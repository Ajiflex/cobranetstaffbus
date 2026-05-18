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
// SERVER TIME HELPERS  (Africa/Lagos — WAT, UTC+1, no DST)
//
// All booking-window comparisons use the SERVER clock, not the client's device
// time.  This prevents staff from bypassing the booking window by changing the
// clock on their phone or computer.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the current server minute-of-day in Africa/Lagos local time.
 * e.g. 17:05 WAT → 1025
 */
function getServerLagosMinuteOfDay() {
  const now   = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos',
    hour:     '2-digit',
    minute:   '2-digit',
    hour12:   false
  }).formatToParts(now);
  const h = parseInt(parts.find(p => p.type === 'hour').value,   10);
  const m = parseInt(parts.find(p => p.type === 'minute').value, 10);
  return h * 60 + m;
}

/**
 * Returns 0 (Sun) … 6 (Sat) in Africa/Lagos local time.
 */
function getServerLagosDayOfWeek() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos',
    weekday:  'short'
  }).formatToParts(now);
  const name = parts.find(p => p.type === 'weekday').value; // 'Mon', 'Tue', ...
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
}

/**
 * Returns the current server ISO timestamp string (UTC).
 */
function getServerISOTime() {
  return new Date().toISOString();
}

/**
 * Parse a "HH:MM" settings string → total minutes since midnight.
 */
function timeStrToMinutes(str) {
  const [h, m] = (str || '00:00').split(':').map(Number);
  return h * 60 + m;
}


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
// RATE-LIMIT CLEANUP: only run expired reservation cleanup at most once per
// 2 minutes across all requests — avoids hammering MongoDB on every poll.
// ─────────────────────────────────────────────────────────────────────────────
let _lastCleanupAt       = 0;
const CLEANUP_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

async function maybeCleanupExpiredReservations() {
  const now = Date.now();
  if (now - _lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  _lastCleanupAt = now;
  await cleanupExpiredTemporaryReservations();
}


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
    // Free expired admin reservations — throttled to run at most every 2 minutes
    // instead of on every single poll request.
    await maybeCleanupExpiredReservations();
    // NOTE: cleanupDuplicateBookings() is NOT called here on every poll — it is a
    // full collection scan. It runs only via POST /verifySeatAllocations which the
    // frontend calls exactly once when the booking window closes.

    const { start: todayStart, end: todayEnd } = getTodayRange();
    const todayStr = todayStart.toISOString().split('T')[0];

    const bookingRows = await DailyBooking.find({
      booking_date: { $gte: todayStart, $lt: todayEnd }
    }).populate('staff_id', 'name username department').lean();

    const bookings = {};
    bookingRows.forEach(row => {
      bookings[String(row.seat_number)] = {
        username:   row.staffId,
        name:       row.staff_id ? row.staff_id.name : row.staffId,
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
    }).lean();

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
          ? new Date(r.reserved_at).toLocaleTimeString('en-GB', {
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
      id:             settingsDoc._id.toString(),
      openTime:       settingsDoc.booking_start_time,
      closeTime:      settingsDoc.booking_end_time,
      resultsTime:    settingsDoc.display_time,
      totalSeats:     settingsDoc.total_seats,
      sessionVersion: settingsDoc.session_version
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
    // ── Server-side booking window enforcement ─────────────────────────────
    // Uses SERVER clock only. Client device time is completely ignored.
    // Staff cannot bypass this by changing their phone/computer clock.
    let settingsDoc;
    try {
      settingsDoc = await Settings.getSettings();
    } catch (settingsErr) {
      console.error('[bookSeat] Failed to load settings for time check:', settingsErr.message);
      return res.status(503).json({ success: false, message: 'Could not verify booking window. Please try again.' });
    }

    const serverDay     = getServerLagosDayOfWeek();
    const nowMinutes    = getServerLagosMinuteOfDay();
    const openMins      = timeStrToMinutes(settingsDoc.booking_start_time);
    const closeMins     = timeStrToMinutes(settingsDoc.booking_end_time);

    if (serverDay === 0 || serverDay === 6) {
      logBookingEvent('warn', 'BOOKING_TIME_REJECTED', {
        staffId: staffIdLower, seatId: seatNum,
        message: `Weekend booking attempt rejected by server (serverDay=${serverDay})`
      });
      return res.status(403).json({
        success: false,
        message: 'Booking is not available on weekends.'
      });
    }

    if (nowMinutes < openMins) {
      logBookingEvent('warn', 'EARLY_BOOKING_ATTEMPT', {
        staffId: staffIdLower, seatId: seatNum,
        message: `Early booking attempt — server ${nowMinutes}min, window opens ${openMins}min`
      });
      return res.status(403).json({
        success: false,
        message: `Booking window has not opened yet. It opens at ${settingsDoc.booking_start_time} (server time).`
      });
    }

    if (nowMinutes >= closeMins) {
      logBookingEvent('warn', 'BOOKING_TIME_REJECTED', {
        staffId: staffIdLower, seatId: seatNum,
        message: `Late booking attempt — server ${nowMinutes}min, window closed at ${closeMins}min`
      });
      return res.status(403).json({
        success: false,
        message: `Booking has closed for today. It closed at ${settingsDoc.booking_end_time} (server time).`
      });
    }
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
    await maybeCleanupExpiredReservations();

    const now  = new Date();
    const data = await Reservation.find({
      status: 'active',
      $or: [
        { reservation_type: 'permanent' },
        { reservation_type: 'temporary', expires_at: { $gt: now } }
      ]
    }).lean();

    const reservations = data.map(r => ({
      _id:         r._id.toString(),
      seat:        r.seat_number,
      label:       r.label,
      type:        r.reservation_type,
      status:      r.status,
      expiresDate: r.expires_at ? new Date(r.expires_at).toISOString().split('T')[0] : null,
      expiresAt:   r.expires_at ? new Date(r.expires_at).toISOString() : null,
      reservedAt:  new Date(r.reserved_at).toISOString()
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

    await maybeCleanupExpiredReservations();

    const now      = new Date();
    const existing = await Reservation.findOne({
      seat_number: seatNum,
      status:      'active',
      $or: [
        { reservation_type: 'permanent' },
        { reservation_type: 'temporary', expires_at: { $gt: now } }
      ]
    }).lean();

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

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/serverTime
// Returns authoritative server time so the frontend can sync countdowns
// and detect stale sessions — no auth required (read-only, non-sensitive).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/serverTime', async (req, res) => {
  try {
    const now = new Date();
    const lagosTime = now.toLocaleTimeString('en-GB', {
      timeZone: 'Africa/Lagos',
      hour:     '2-digit',
      minute:   '2-digit',
      second:   '2-digit',
      hour12:   false
    });
    const lagosDate = now.toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' }); // YYYY-MM-DD

    let sessionVersion = 1;
    try {
      const settingsDoc = await Settings.getSettings();
      sessionVersion = settingsDoc.session_version || 1;
    } catch (_) { /* non-fatal — return time even if DB is slow */ }

    res.json({
      success:        true,
      serverTime:     now.toISOString(),
      lagosTime,
      lagosDate,
      lagosDay:       getServerLagosDayOfWeek(),
      sessionVersion
    });
  } catch (err) {
    console.error('serverTime error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/forceLogoutAll
// Increments settings.session_version.  Every active client will detect the
// version mismatch on their next /api/seats or /api/serverTime poll and be
// logged out automatically.  NO user, booking, or history records are touched.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/forceLogoutAll', async (req, res) => {
  try {
    const settingsDoc = await Settings.getSettings();
    settingsDoc.session_version = (settingsDoc.session_version || 1) + 1;
    await settingsDoc.save();
    Settings.clearCache(); // invalidate cache so next poll sees new version

    const newVersion = settingsDoc.session_version;
    const ts         = getServerISOTime();

    logBookingEvent('info', 'SESSION_INVALIDATED', {
      message: `All sessions invalidated by admin. New session_version=${newVersion} at ${ts}`
    });

    await SystemLog.create({
      event_type: 'SESSION_INVALIDATED',
      timestamp:  new Date(),
      status:     'success',
      details:    `Admin forced logout of all users. session_version bumped to ${newVersion} at ${ts}`
    }).catch(e => console.error('[forceLogoutAll] SystemLog write failed:', e.message));

    res.json({
      success:        true,
      message:        'All active sessions have been invalidated. Users will be logged out on their next page poll.',
      sessionVersion: newVersion
    });
  } catch (err) {
    console.error('forceLogoutAll error:', err);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

module.exports = router;
