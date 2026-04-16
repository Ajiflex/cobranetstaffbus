// routes/reservationRoutes.js
const express     = require('express');
const router      = express.Router();
const Reservation = require('../models/TemporaryReservation');
const DailyBooking = require('../models/DailyBooking');
const Staff       = require('../models/Staff');
const Settings    = require('../models/Settings');
const SystemLog   = require('../models/SystemLog');

// Helper to get today's date range
const getTodayRange = () => {
  const now   = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end   = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return { start, end };
};

// ─────────────────────────────────────────────────────────────────────────────
// ISSUE 4 — TEMPORARY SEAT EXPIRATION
//
// Finds temporary reservations whose expires_at has passed, deletes them, and
// writes a TEMP_RESERVATION_EXPIRED system-log entry.
//
// Called on every GET /api/seats so seats are freed immediately without
// relying on the MongoDB TTL index lag (TTL runs every ~60 s by default).
// Also called before POST /api/bookSeat allocation.
//
// Safe to call concurrently — deleteMany is idempotent.
// ─────────────────────────────────────────────────────────────────────────────
async function cleanupExpiredTemporaryReservations() {
  const now = new Date();

  const expired = await Reservation.find({
    reservation_type: 'temporary',
    status:           'active',
    expires_at:       { $lt: now }
  }).select('_id seat_number expires_at');

  if (expired.length === 0) return 0;

  const ids = expired.map(r => r._id);
  await Reservation.deleteMany({ _id: { $in: ids } });

  const seats = expired.map(r => r.seat_number).join(', ');
  console.log(
    `[cleanup] Expired and deleted ${expired.length} temporary reservation(s): seats ${seats}`
  );

  // ISSUE 5 — log the expiry event (non-fatal)
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
// DUPLICATE SEAT VALIDATION
// ─────────────────────────────────────────────────────────────────────────────
async function cleanupDuplicateBookings() {
  const { start: todayStart, end: todayEnd } = getTodayRange();

  const todayBookings = await DailyBooking.find({
    booking_date: { $gte: todayStart, $lt: todayEnd }
  }).sort({ created_at: 1, _id: 1 });

  const byStaff = {};
  todayBookings.forEach(b => {
    const key = b.staffId.toLowerCase();
    if (!byStaff[key]) byStaff[key] = [];
    byStaff[key].push(b);
  });

  const deletePromises = [];
  Object.values(byStaff).forEach(bookings => {
    if (bookings.length > 1) {
      const extras = bookings.slice(1);
      extras.forEach(extra => {
        console.log(
          `[duplicate-cleanup] Releasing extra seat ${extra.seat_number} ` +
          `for user ${extra.staffId} (keeping seat ${bookings[0].seat_number})`
        );
        deletePromises.push(DailyBooking.findByIdAndDelete(extra._id));
      });
    }
  });

  if (deletePromises.length > 0) {
    await Promise.all(deletePromises);
    console.log(`[duplicate-cleanup] Released ${deletePromises.length} duplicate booking(s)`);
  }

  return deletePromises.length;
}

// POST /api/verifySeatAllocations
router.post('/verifySeatAllocations', async (req, res) => {
  try {
    const releasedCount = await cleanupDuplicateBookings();
    console.log(`[verifySeatAllocations] Released ${releasedCount} seat(s)`);
    res.json({ success: true, releasedCount });
  } catch (err) {
    console.error('verifySeatAllocations error:', err);
    res.status(500).json({ success: false, message: 'Verification failed. Please try again.' });
  }
});

// GET /api/seats — Get all seat data (bookings + reservations + settings)
router.get('/seats', async (req, res) => {
  try {
    // ── Step 1: Expire and remove stale temporary reservations ────────────
    // This makes Vercel Free plan work without per-minute cron jobs.
    await cleanupExpiredTemporaryReservations();

    // ── Step 2: Duplicate-seat validation ─────────────────────────────────
    await cleanupDuplicateBookings();

    const { start: todayStart, end: todayEnd } = getTodayRange();
    const todayStr = todayStart.toISOString().split('T')[0];

    // ── Step 3: Fetch confirmed bookings (DailyBooking) ───────────────────
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

    // ── Step 4: Fetch active reservations (TemporaryReservation) ─────────
    const now = new Date();
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

    // ── Step 5: Merge reserved seats into the bookings map ────────────────
    resRows.forEach(r => {
      const sNum = String(r.seat_number);
      if (!bookings[sNum]) {
        const reservedTime = r.reserved_at
          ? r.reserved_at.toLocaleTimeString('en-GB', {
              hour:     '2-digit',
              minute:   '2-digit',
              second:   '2-digit',
              hour12:   false,
              timeZone: 'Africa/Lagos'
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

    // ── Step 6: Fetch settings ────────────────────────────────────────────
    const settingsDoc = await Settings.getSettings();
    const settings = {
      id:          settingsDoc._id.toString(),
      openTime:    settingsDoc.booking_start_time,
      closeTime:   settingsDoc.booking_end_time,
      resultsTime: settingsDoc.display_time,
      totalSeats:  settingsDoc.total_seats
    };

    res.json({
      success: true,
      bookings,
      reservations,
      settings
    });
  } catch (err) {
    console.error('Seats API error:', err);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// POST /api/bookSeat — Book a seat
router.post('/bookSeat', async (req, res) => {
  try {
    const { seatNumber, userId, username, name } = req.body;

    if (!seatNumber || !userId || !username) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: seatNumber, userId, username'
      });
    }

    const seatNum = parseInt(seatNumber, 10);
    if (isNaN(seatNum) || seatNum < 1) {
      return res.status(400).json({ success: false, message: 'Invalid seat number.' });
    }

    // Expire stale temporary reservations before allocation
    await cleanupExpiredTemporaryReservations();
    await cleanupDuplicateBookings();

    const { start: todayStart, end: todayEnd } = getTodayRange();
    const now = new Date();

    // Check if seat is reserved
    const reservation = await Reservation.findOne({
      seat_number: seatNum,
      status:      'active',
      $or: [
        { reservation_type: 'permanent' },
        { reservation_type: 'temporary', expires_at: { $gt: now } }
      ]
    });

    if (reservation) {
      return res.status(409).json({
        success: false,
        message: `Seat ${seatNum} is reserved and unavailable.`
      });
    }

    // Check if seat is already booked today
    const existingBooking = await DailyBooking.findOne({
      seat_number:  seatNum,
      booking_date: { $gte: todayStart, $lt: todayEnd }
    });

    if (existingBooking) {
      return res.status(409).json({
        success:  false,
        message:  `Seat ${seatNum} was just taken — please choose another.`,
        conflict: true
      });
    }

    // If staff already has a booking today, release it (seat change)
    const staffBooking = await DailyBooking.findOne({
      staffId:      username.toLowerCase(),
      booking_date: { $gte: todayStart, $lt: todayEnd }
    });

    if (staffBooking) {
      await DailyBooking.findByIdAndDelete(staffBooking._id);
    }

    // Create new booking
    const newBooking = await DailyBooking.create({
      staff_id:     userId,
      staffId:      username.toLowerCase(),
      seat_number:  seatNum,
      booking_date: todayStart
    });

    res.json({
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
    console.error('BookSeat error:', err);
    if (err.code === 11000) {
      return res.status(409).json({
        success:  false,
        message:  'Seat already taken or staff already has a seat today.',
        conflict: true
      });
    }
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// GET /api/reservations — List active reservations
router.get('/reservations', async (req, res) => {
  try {
    // Expire stale reservations before returning the list
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

// POST /api/reservations — Create reservation
router.post('/reservations', async (req, res) => {
  try {
    const { seat, label, type, days } = req.body;

    if (!seat || !label || !type) {
      return res.status(400).json({
        success: false,
        message: 'seat, label, and type are required.'
      });
    }

    if (!['permanent', 'temporary'].includes(type)) {
      return res.status(400).json({
        success: false,
        message: 'type must be "permanent" or "temporary".'
      });
    }

    const seatNum = parseInt(seat, 10);
    if (isNaN(seatNum) || seatNum < 1) {
      return res.status(400).json({ success: false, message: 'Invalid seat number.' });
    }

    // Clean up expired before checking conflicts
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
        success: false,
        message: 'Seat already has an active reservation.'
      });
    }
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// DELETE /api/reservations — Remove reservation
router.delete('/reservations', async (req, res) => {
  try {
    const { seat } = req.body;

    if (!seat) {
      return res.status(400).json({ success: false, message: 'seat is required.' });
    }

    const seatNum = parseInt(seat, 10);
    await Reservation.deleteOne({ seat_number: seatNum });

    res.json({
      success: true,
      message: `Reservation for Seat ${seatNum} removed.`
    });
  } catch (err) {
    console.error('Reservations DELETE error:', err);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

module.exports = router;
