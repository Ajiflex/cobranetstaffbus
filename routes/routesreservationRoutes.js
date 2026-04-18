// routes/reservationRoutes.js
const express      = require('express');
const router       = express.Router();
const mongoose     = require('mongoose');
const Reservation  = require('../models/TemporaryReservation');
const DailyBooking = require('../models/DailyBooking');
const Staff        = require('../models/Staff');
const Settings     = require('../models/Settings');
const SystemLog    = require('../models/SystemLog');

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const getTodayRange = () => {
  const now   = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end   = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return { start, end };
};

// Structured conflict/error logger — satisfies Step 7 logging requirement.
function logBookingEvent(level, event, { staffId, seatId, message, extra } = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    event,
    staffId:   staffId  || '—',
    seatId:    seatId   || '—',
    message:   message  || '',
    ...extra
  };
  if (level === 'warn')  console.warn( `[booking:${event}]`, JSON.stringify(entry));
  else if (level === 'error') console.error(`[booking:${event}]`, JSON.stringify(entry));
  else                        console.log(  `[booking:${event}]`, JSON.stringify(entry));
}

// ─────────────────────────────────────────────────────────────────────────────
// TEMPORARY RESERVATION EXPIRY CLEANUP
//
// Called from GET /seats so expired admin reservations are freed before the
// seat map is rendered. NOT called inside bookSeat — the reservation check
// inside bookSeat uses `expires_at: { $gt: now }` which already excludes
// expired records at the database level without needing a separate cleanup.
// ─────────────────────────────────────────────────────────────────────────────
async function cleanupExpiredTemporaryReservations() {
  const now = new Date();

  const expired = await Reservation.find({
    reservation_type: 'temporary',
    status:           'active',
    expires_at:       { $lt: now }
  }).select('_id seat_number expires_at').lean();

  if (expired.length === 0) return 0;

  const ids   = expired.map(r => r._id);
  const seats = expired.map(r => r.seat_number).join(', ');

  await Reservation.deleteMany({ _id: { $in: ids } });

  logBookingEvent('info', 'TEMP_RESERVATION_EXPIRED', {
    message: `Deleted ${expired.length} expired reservation(s): seats ${seats}`
  });

  await SystemLog.create({
    event_type:        'TEMP_RESERVATION_EXPIRED',
    timestamp:         now,
    records_processed: expired.length,
    status:            'success',
    details:           `Deleted ${expired.length} expired temporary reservation(s): seats ${seats}`
  }).catch(e => console.error('[cleanup] SystemLog write failed:', e.message));

  return expired.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// DUPLICATE BOOKING CLEANUP
//
// POST-BOOKING verification sweep.  Used by GET /seats and the
// /verifySeatAllocations endpoint ONLY.
//
// NOT called inside the bookSeat critical path — calling a full collection
// scan on every booking request is O(n) per request and causes timeouts when
// 50 staff book simultaneously.  The unique indexes on DailyBooking provide
// atomic duplicate prevention at insert time without a pre-flight scan.
// ─────────────────────────────────────────────────────────────────────────────
async function cleanupDuplicateBookings() {
  const { start: todayStart, end: todayEnd } = getTodayRange();

  const todayBookings = await DailyBooking.find({
    booking_date: { $gte: todayStart, $lt: todayEnd }
  }).select('staffId seat_number created_at _id').sort({ created_at: 1, _id: 1 }).lean();

  const byStaff = {};
  todayBookings.forEach(b => {
    const key = b.staffId.toLowerCase();
    if (!byStaff[key]) byStaff[key] = [];
    byStaff[key].push(b);
  });

  const idsToDelete = [];
  Object.values(byStaff).forEach(bookings => {
    if (bookings.length > 1) {
      bookings.slice(1).forEach(extra => {
        logBookingEvent('warn', 'DUPLICATE_DETECTED', {
          staffId: extra.staffId,
          seatId:  extra.seat_number,
          message: `Releasing duplicate seat; keeping seat ${bookings[0].seat_number}`
        });
        idsToDelete.push(extra._id);
      });
    }
  });

  if (idsToDelete.length > 0) {
    await DailyBooking.deleteMany({ _id: { $in: idsToDelete } });
    logBookingEvent('warn', 'DUPLICATE_CLEANUP', {
      message: `Released ${idsToDelete.length} duplicate booking(s)`
    });
  }

  return idsToDelete.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// ATOMIC BOOKING CORE
//
// Executes the seat-change sequence (delete old booking + create new one)
// inside a MongoDB session transaction so the two writes are atomic.
//
// If the MongoDB deployment does not support multi-document transactions
// (standalone instance, no replica set), this falls back to a non-transactional
// sequential write and relies on the unique indexes as the final guard.
//
// Unique indexes on DailyBooking:
//   { staffId, booking_date }    — one seat per staff per day
//   { seat_number, booking_date } — one staff per seat per day
//
// Any violation of either index results in a MongoServerError with code 11000.
// ─────────────────────────────────────────────────────────────────────────────
async function atomicBookSeat({ staffIdLower, staffObjectId, seatNum, todayStart, todayEnd }) {
  let session = null;

  try {
    session = await mongoose.startSession();

    let newBooking = null;

    await session.withTransaction(async () => {
      // ── Step A: Re-check seat availability inside the transaction ──────
      // This read uses the session so it observes the transaction's snapshot,
      // preventing another concurrent transaction from slipping in the same seat.
      const seatTaken = await DailyBooking.findOne({
        seat_number:  seatNum,
        booking_date: { $gte: todayStart, $lt: todayEnd }
      }).session(session).lean();

      if (seatTaken) {
        const err = new Error('SEAT_TAKEN');
        err.code  = 'SEAT_TAKEN';
        throw err;
      }

      // ── Step B: Remove any existing booking for this staff (seat change) ─
      // deleteOne is idempotent; if no booking exists it simply deletes 0 docs.
      await DailyBooking.deleteOne({
        staffId:      staffIdLower,
        booking_date: { $gte: todayStart, $lt: todayEnd }
      }).session(session);

      // ── Step C: Create the new booking ────────────────────────────────
      // create() with a session requires an array argument.
      const docs = await DailyBooking.create([{
        staff_id:     staffObjectId,
        staffId:      staffIdLower,
        seat_number:  seatNum,
        booking_date: todayStart
      }], { session });

      newBooking = docs[0];
    });

    return { newBooking };

  } catch (err) {
    throw err; // caller handles all error classification
  } finally {
    if (session) await session.endSession().catch(() => {});
  }
}

// Non-transactional fallback (standalone MongoDB without replica set)
async function nonTransactionalBookSeat({ staffIdLower, staffObjectId, seatNum, todayStart, todayEnd }) {
  // Remove old booking atomically before creating the new one.
  // The unique index on {staffId, booking_date} ensures only one document
  // exists per staff per day. If two concurrent requests both reach this
  // point, the second create will fail with 11000 which the caller handles.
  await DailyBooking.deleteOne({
    staffId:      staffIdLower,
    booking_date: { $gte: todayStart, $lt: todayEnd }
  });

  const newBooking = await DailyBooking.create({
    staff_id:     staffObjectId,
    staffId:      staffIdLower,
    seat_number:  seatNum,
    booking_date: todayStart
  });

  return { newBooking };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/verifySeatAllocations
// POST-booking sweep called by the frontend after the booking window closes.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/verifySeatAllocations', async (req, res) => {
  try {
    const releasedCount = await cleanupDuplicateBookings();
    logBookingEvent('info', 'VERIFY_COMPLETE', { message: `Released ${releasedCount} seat(s)` });
    res.json({ success: true, releasedCount });
  } catch (err) {
    console.error('verifySeatAllocations error:', err);
    res.status(500).json({ success: false, message: 'Verification failed. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/seats
// ─────────────────────────────────────────────────────────────────────────────
router.get('/seats', async (req, res) => {
  try {
    // Free expired admin reservations before building the seat map
    await cleanupExpiredTemporaryReservations();
    // Sweep for any duplicates left by previous concurrency edge cases
    await cleanupDuplicateBookings();

    const { start: todayStart, end: todayEnd } = getTodayRange();
    const todayStr = todayStart.toISOString().split('T')[0];

    const bookingRows = await DailyBooking.find({
      booking_date: { $gte: todayStart, $lt: todayEnd }
    }).populate('staff_id', 'name username department');

    const bookings = {};
    bookingRows.forEach(row => {
      bookings[String(row.seat_number)] = {
        username:   row.staffId,
        name:       row.staff_id ? row.staff_id.name : '',
        department: row.staff_id ? row.staff_id.department : '',
        time:       row.booking_time,
        date:       todayStr
      };
    });

    const now     = new Date();
    const resRows = await Reservation.find({
      status: 'active',
      $or: [
        { reservation_type: 'permanent' },
        { reservation_type: 'temporary', expires_at: { $gt: now } }
      ]
    });

    const reservations = resRows.map(r => ({
      _id:         r._id.toString(),
      seat:        r.seat_number,
      label:       r.label,
      type:        r.reservation_type,
      status:      r.status,
      expiresDate: r.expires_at ? r.expires_at.toISOString().split('T')[0] : null,
      expiresAt:   r.expires_at ? r.expires_at.toISOString() : null,
      reservedAt:  r.reserved_at.toISOString()
    }));

    resRows.forEach(r => {
      const sNum = String(r.seat_number);
      if (!bookings[sNum]) {
        const reservedTime = r.reserved_at
          ? r.reserved_at.toLocaleTimeString('en-GB', {
              hour: '2-digit', minute: '2-digit', second: '2-digit',
              hour12: false, timeZone: 'Africa/Lagos'
            })
          : '—';
        bookings[sNum] = {
          username:         r.label,
          name:             r.label,
          department:       '',
          time:             reservedTime,
          date:             todayStr,
          _reserved:        true,
          _reservationType: r.reservation_type
        };
      }
    });

    const settingsDoc = await Settings.getSettings();
    const settings = {
      id:          settingsDoc._id.toString(),
      openTime:    settingsDoc.booking_start_time,
      closeTime:   settingsDoc.booking_end_time,
      resultsTime: settingsDoc.display_time,
      totalSeats:  settingsDoc.total_seats
    };

    res.json({ success: true, bookings, reservations, settings });
  } catch (err) {
    console.error('Seats API error:', err);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/bookSeat
//
// Security model:
//
//   Layer 1 — Admin reservation check (Reservation collection)
//     Seat is blocked by admin? → 409 immediately (no DB write attempted)
//
//   Layer 2 — Atomic transaction (MongoDB session)
//     Re-read seat availability INSIDE the transaction so concurrent requests
//     cannot both pass the check and both write.
//     Delete old booking (if staff is changing seats) INSIDE the transaction.
//     Create new booking INSIDE the transaction.
//     On any failure → ROLLBACK (no partial state).
//
//   Layer 3 — Unique index enforcement (database level)
//     { staffId, booking_date }     — one seat per staff per day
//     { seat_number, booking_date } — one seat per staff, one staff per seat
//     Any concurrent request that races past Layer 2 is caught here by
//     MongoDB raising a duplicate key error (code 11000).
//     This layer works even without replica-set transactions.
//
//   Layer 4 — Fallback non-transactional path
//     If the MongoDB deployment does not support sessions (standalone),
//     Layer 2 is skipped. Layers 1, 3, and 4 still protect correctness.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/bookSeat', async (req, res) => {
  const { seatNumber, userId, username, name } = req.body;

  // ── Input validation ────────────────────────────────────────────────────
  if (!seatNumber || !userId || !username) {
    return res.status(400).json({
      success: false,
      message: 'Missing required fields: seatNumber, userId, username'
    });
  }

  const seatNum = parseInt(seatNumber, 10);
  if (isNaN(seatNum) || seatNum < 1 || seatNum > 60) {
    return res.status(400).json({ success: false, message: 'Invalid seat number.' });
  }

  const staffIdLower   = username.toLowerCase().trim();
  const staffObjectId  = userId;
  const { start: todayStart, end: todayEnd } = getTodayRange();
  const now            = new Date();

  try {
    // ── Layer 1: Admin reservation guard ──────────────────────────────────
    // Checked outside the transaction because reservation records change
    // rarely (admin action) and this read does not need to be serialised
    // with the booking write.
    const reservation = await Reservation.findOne({
      seat_number: seatNum,
      status:      'active',
      $or: [
        { reservation_type: 'permanent' },
        { reservation_type: 'temporary', expires_at: { $gt: now } }
      ]
    }).lean();

    if (reservation) {
      logBookingEvent('warn', 'SEAT_RESERVED_BLOCKED', {
        staffId: staffIdLower, seatId: seatNum,
        message: `Seat blocked by ${reservation.reservation_type} admin reservation`
      });
      return res.status(409).json({
        success: false,
        message: `Seat ${seatNum} is reserved and unavailable.`
      });
    }

    // ── Layers 2 + 3: Atomic booking ──────────────────────────────────────
    let newBooking;

    try {
      // Attempt transactional path (Atlas / replica-set deployments)
      ({ newBooking } = await atomicBookSeat({
        staffIdLower, staffObjectId, seatNum, todayStart, todayEnd
      }));

    } catch (txErr) {
      // ── Custom application error thrown from inside transaction ──────────
      if (txErr.code === 'SEAT_TAKEN') {
        logBookingEvent('warn', 'SEAT_CONFLICT', {
          staffId: staffIdLower, seatId: seatNum,
          message: 'Seat taken — detected inside transaction'
        });
        return res.status(409).json({
          success:  false,
          message:  `Seat ${seatNum} was just taken — please choose another.`,
          conflict: true
        });
      }

      // ── Transaction not supported (standalone MongoDB) → fallback ───────
      const isSessionError =
        txErr.message && (
          txErr.message.includes('Transaction') ||
          txErr.message.includes('session')     ||
          txErr.message.includes('replica')     ||
          txErr.message.includes('startSession')
        );

      if (isSessionError) {
        // Layer 4 fallback: non-transactional sequential writes.
        // Unique indexes (Layer 3) are the final guard here.
        ({ newBooking } = await nonTransactionalBookSeat({
          staffIdLower, staffObjectId, seatNum, todayStart, todayEnd
        }));
      } else {
        throw txErr; // re-throw unexpected errors to outer catch
      }
    }

    logBookingEvent('info', 'BOOKING_CREATED', {
      staffId: staffIdLower, seatId: seatNum,
      message: `Seat ${seatNum} booked successfully`
    });

    return res.json({
      success: true,
      message: `Seat ${seatNum} reserved!`,
      booking: {
        seatNumber: String(seatNum),
        username,
        name,
        time: newBooking.booking_time,
        date: todayStart.toISOString().split('T')[0]
      }
    });

  } catch (err) {
    // ── Layer 3: Unique index violation ─────────────────────────────────
    if (err.code === 11000) {
      const keyPattern = err.keyPattern || {};

      if (keyPattern.seat_number) {
        logBookingEvent('warn', 'SEAT_CONFLICT', {
          staffId: staffIdLower, seatId: seatNum,
          message: 'Unique index violation — seat_number+booking_date'
        });
        return res.status(409).json({
          success:  false,
          message:  `Seat ${seatNum} was just taken — please choose another.`,
          conflict: true
        });
      }

      if (keyPattern.staffId) {
        logBookingEvent('warn', 'STAFF_DUPLICATE', {
          staffId: staffIdLower, seatId: seatNum,
          message: 'Unique index violation — staffId+booking_date'
        });
        return res.status(409).json({
          success:  false,
          message:  'You already have a seat booked for today.',
          conflict: true
        });
      }

      // Unknown 11000 (belt-and-suspenders)
      logBookingEvent('warn', 'DUPLICATE_KEY_UNKNOWN', {
        staffId: staffIdLower, seatId: seatNum,
        message: `11000 on unknown key: ${JSON.stringify(keyPattern)}`
      });
      return res.status(409).json({
        success:  false,
        message:  'Booking conflict — please try again.',
        conflict: true
      });
    }

    // ── Transaction abort / transient error ────────────────────────────
    if (err.errorLabels && err.errorLabels.includes('TransientTransactionError')) {
      logBookingEvent('warn', 'TRANSIENT_TX_ERROR', {
        staffId: staffIdLower, seatId: seatNum,
        message: err.message
      });
      return res.status(409).json({
        success:  false,
        message:  'Booking conflict — please try again.',
        conflict: true
      });
    }

    logBookingEvent('error', 'BOOKING_ERROR', {
      staffId: staffIdLower, seatId: seatNum,
      message: err.message
    });
    return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reservations
// ─────────────────────────────────────────────────────────────────────────────
router.get('/reservations', async (req, res) => {
  try {
    await cleanupExpiredTemporaryReservations();

    const now  = new Date();
    const data = await Reservation.find({
      status: 'active',
      $or: [
        { reservation_type: 'permanent' },
        { reservation_type: 'temporary', expires_at: { $gt: now } }
      ]
    });

    const reservations = data.map(r => ({
      _id:         r._id.toString(),
      seat:        r.seat_number,
      label:       r.label,
      type:        r.reservation_type,
      status:      r.status,
      expiresDate: r.expires_at ? r.expires_at.toISOString().split('T')[0] : null,
      expiresAt:   r.expires_at ? r.expires_at.toISOString() : null,
      reservedAt:  r.reserved_at.toISOString()
    }));

    res.json({ success: true, reservations });
  } catch (err) {
    console.error('Reservations GET error:', err);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/reservations
// ─────────────────────────────────────────────────────────────────────────────
router.post('/reservations', async (req, res) => {
  try {
    const { seat, label, type, days } = req.body;

    if (!seat || !label || !type) {
      return res.status(400).json({
        success: false, message: 'seat, label, and type are required.'
      });
    }

    if (!['permanent', 'temporary'].includes(type)) {
      return res.status(400).json({
        success: false, message: 'type must be "permanent" or "temporary".'
      });
    }

    const seatNum = parseInt(seat, 10);
    if (isNaN(seatNum) || seatNum < 1) {
      return res.status(400).json({ success: false, message: 'Invalid seat number.' });
    }

    await cleanupExpiredTemporaryReservations();

    const now      = new Date();
    const existing = await Reservation.findOne({
      seat_number: seatNum,
      status:      'active',
      $or: [
        { reservation_type: 'permanent' },
        { reservation_type: 'temporary', expires_at: { $gt: now } }
      ]
    });

    if (existing) {
      return res.status(409).json({
        success: false,
        message: `Seat ${seatNum} already has an active reservation. Remove it first.`
      });
    }

    let expiresAt = null;
    if (type === 'temporary') {
      const daysNum = Math.max(1, parseInt(days, 10) || 1);
      expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + daysNum);
      expiresAt.setHours(23, 59, 59, 999);
    }

    const newRes = await Reservation.create({
      seat_number:      seatNum,
      label:            label.trim(),
      reservation_type: type,
      expires_at:       expiresAt,
      status:           'active'
    });

    res.json({
      success: true,
      reservation: {
        _id:         newRes._id.toString(),
        seat:        newRes.seat_number,
        label:       newRes.label,
        type:        newRes.reservation_type,
        status:      newRes.status,
        expiresDate: newRes.expires_at ? newRes.expires_at.toISOString().split('T')[0] : null,
        expiresAt:   newRes.expires_at ? newRes.expires_at.toISOString() : null,
        reservedAt:  newRes.reserved_at.toISOString()
      }
    });
  } catch (err) {
    console.error('Reservations POST error:', err);
    if (err.code === 11000) {
      return res.status(409).json({
        success: false, message: 'Seat already has an active reservation.'
      });
    }
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/reservations
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/reservations', async (req, res) => {
  try {
    const { seat } = req.body;
    if (!seat) {
      return res.status(400).json({ success: false, message: 'seat is required.' });
    }
    const seatNum = parseInt(seat, 10);
    await Reservation.deleteOne({ seat_number: seatNum });
    res.json({ success: true, message: `Reservation for Seat ${seatNum} removed.` });
  } catch (err) {
    console.error('Reservations DELETE error:', err);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

module.exports = router;
