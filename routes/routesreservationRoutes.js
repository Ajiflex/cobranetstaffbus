// routes/reservationRoutes.js
const express = require('express');
const router = express.Router();
const Reservation = require('../models/TemporaryReservation');
const DailyBooking = require('../models/DailyBooking');
const Staff = require('../models/Staff');
const Settings = require('../models/Settings');

// Helper to get today's date range
const getTodayRange = () => {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return { start, end };
};

// ─────────────────────────────────────────────────────────────────────────────
// DUPLICATE SEAT VALIDATION
// Detects users who hold more than one DailyBooking for today and releases
// the extras, keeping only the earliest booking (lowest created_at / _id).
//
// Called before GET /seats (so the seat map is always clean before rendering)
// and before POST /bookSeat (so allocation never starts from a dirty state).
// ─────────────────────────────────────────────────────────────────────────────
async function cleanupDuplicateBookings() {
  const { start: todayStart, end: todayEnd } = getTodayRange();

  // Fetch all of today's bookings, oldest first so we can keep the first one
  const todayBookings = await DailyBooking.find({
    booking_date: { $gte: todayStart, $lt: todayEnd }
  }).sort({ created_at: 1, _id: 1 });

  // Group bookings by staffId — each key holds an array of that user's bookings
  const byStaff = {};
  todayBookings.forEach(b => {
    const key = b.staffId.toLowerCase();
    if (!byStaff[key]) byStaff[key] = [];
    byStaff[key].push(b);
  });

  // For any user with more than one booking, delete every record after the first.
  // The first element is the earliest because we sorted by created_at / _id above.
  const deletePromises = [];
  Object.values(byStaff).forEach(bookings => {
    if (bookings.length > 1) {
      // Keep bookings[0] (earliest), release the rest back to the available pool
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
}

// GET /api/seats - Get all seat data (bookings + reservations + settings)
router.get('/seats', async (req, res) => {
  try {
    // ── Step 1: Run duplicate-seat validation before building the seat map ──
    // This guarantees no user appears on more than one seat in the response.
    await cleanupDuplicateBookings();

    const { start: todayStart, end: todayEnd } = getTodayRange();
    const todayStr = todayStart.toISOString().split('T')[0];

    // ── Step 2: Fetch confirmed bookings (DailyBooking) ────────────────────
    const bookingRows = await DailyBooking.find({
      booking_date: { $gte: todayStart, $lt: todayEnd }
    }).populate('staff_id', 'name username department');

    const bookings = {};
    bookingRows.forEach(row => {
      bookings[String(row.seat_number)] = {
        username: row.staffId,
        name: row.staff_id ? row.staff_id.name : '',
        department: row.staff_id ? row.staff_id.department : '',
        time: row.booking_time,
        date: todayStr
      };
    });

    // ── Step 3: Fetch active reservations (TemporaryReservation) ───────────
    const now = new Date();
    const resRows = await Reservation.find({
      status: 'active',
      $or: [
        { reservation_type: 'permanent' },
        { reservation_type: 'temporary', expires_at: { $gt: now } }
      ]
    });

    const reservations = resRows.map(r => ({
      _id: r._id.toString(),
      seat: r.seat_number,
      label: r.label,
      type: r.reservation_type,
      status: r.status,
      expiresDate: r.expires_at ? r.expires_at.toISOString().split('T')[0] : null,
      expiresAt: r.expires_at ? r.expires_at.toISOString() : null,
      reservedAt: r.reserved_at.toISOString()
    }));

    // ── Step 4: Merge reserved seats into the bookings map ─────────────────
    // The results tab, PDF export, and Excel export all iterate cachedBookings.
    // Without this merge, permanently/temporarily reserved seats appear in the
    // seat grid (via cachedReservations) but are invisible in the results view.
    //
    // We add each reserved seat to bookings with _reserved: true so the
    // frontend's existing filter (`!v._reserved`) excludes them from the
    // staff-booked count while still rendering them in the seat result map.
    //
    // A confirmed booking already in bookings takes precedence — we do not
    // overwrite it with a reservation placeholder.
    resRows.forEach(r => {
      const sNum = String(r.seat_number);
      if (!bookings[sNum]) {
        bookings[sNum] = {
          username:   r.label,
          name:       r.label,
          department: '',
          time:       '—',
          date:       todayStr,
          _reserved:  true,                       // marker: exclude from staff count
          _reservationType: r.reservation_type    // permanent | temporary
        };
      }
    });

    // ── Step 5: Fetch settings and map to frontend field names ─────────────
    const settingsDoc = await Settings.getSettings();
    const settings = {
      id:          settingsDoc._id.toString(),
      openTime:    settingsDoc.booking_start_time,
      closeTime:   settingsDoc.booking_end_time,
      resultsTime: settingsDoc.display_time,
      totalSeats:  settingsDoc.total_seats,
    };

    res.json({
      success: true,
      bookings,
      reservations,
      settings,
    });
  } catch (err) {
    console.error('Seats API error:', err);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// POST /api/bookSeat - Book a seat
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

    // ── Duplicate validation: clean up before allocating a new seat ────────
    // Ensures that if the user somehow already holds multiple seats (race
    // condition, stale data), those are resolved before we proceed.
    await cleanupDuplicateBookings();

    const { start: todayStart, end: todayEnd } = getTodayRange();

    // Check if seat is reserved
    const now = new Date();
    const reservation = await Reservation.findOne({
      seat_number: seatNum,
      status: 'active',
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
      seat_number: seatNum,
      booking_date: { $gte: todayStart, $lt: todayEnd }
    });

    if (existingBooking) {
      return res.status(409).json({
        success: false,
        message: `Seat ${seatNum} was just taken — please choose another.`,
        conflict: true
      });
    }

    // Check if staff already has a booking today (application level validation)
    const staffBooking = await DailyBooking.findOne({
      staffId: username.toLowerCase(),
      booking_date: { $gte: todayStart, $lt: todayEnd }
    });

    // Delete existing booking if changing seats — enforces one seat per user
    if (staffBooking) {
      await DailyBooking.findByIdAndDelete(staffBooking._id);
    }

    // Create new booking
    const newBooking = await DailyBooking.create({
      staff_id: userId,
      staffId: username.toLowerCase(),
      seat_number: seatNum,
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
        success: false,
        message: 'Seat already taken or staff already has a seat today.',
        conflict: true
      });
    }
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// GET /api/reservations - List reservations
router.get('/reservations', async (req, res) => {
  try {
    const now = new Date();
    const data = await Reservation.find({
      status: 'active',
      $or: [
        { reservation_type: 'permanent' },
        { reservation_type: 'temporary', expires_at: { $gt: now } }
      ]
    });

    const reservations = data.map(r => ({
      _id: r._id.toString(),
      seat: r.seat_number,
      label: r.label,
      type: r.reservation_type,
      status: r.status,
      expiresDate: r.expires_at ? r.expires_at.toISOString().split('T')[0] : null,
      expiresAt: r.expires_at ? r.expires_at.toISOString() : null,
      reservedAt: r.reserved_at.toISOString()
    }));

    res.json({ success: true, reservations });
  } catch (err) {
    console.error('Reservations GET error:', err);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// POST /api/reservations - Create reservation
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

    // Check existing
    const now = new Date();
    const existing = await Reservation.findOne({
      seat_number: seatNum,
      status: 'active',
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

    // Calculate expiry
    let expiresAt = null;
    if (type === 'temporary') {
      const daysNum = Math.max(1, parseInt(days, 10) || 1);
      expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + daysNum);
      expiresAt.setHours(23, 59, 59, 999);
    }

    const newRes = await Reservation.create({
      seat_number: seatNum,
      label: label.trim(),
      reservation_type: type,
      expires_at: expiresAt,
      status: 'active'
    });

    res.json({
      success: true,
      reservation: {
        _id: newRes._id.toString(),
        seat: newRes.seat_number,
        label: newRes.label,
        type: newRes.reservation_type,
        status: newRes.status,
        expiresDate: newRes.expires_at ? newRes.expires_at.toISOString().split('T')[0] : null,
        expiresAt: newRes.expires_at ? newRes.expires_at.toISOString() : null,
        reservedAt: newRes.reserved_at.toISOString()
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

// DELETE /api/reservations - Remove reservation
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

// POST /api/bookSeat - Book a seat
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

    const { start: todayStart, end: todayEnd } = getTodayRange();

    // Check if seat is reserved
    const now = new Date();
    const reservation = await Reservation.findOne({
      seat_number: seatNum,
      status: 'active',
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
      seat_number: seatNum,
      booking_date: { $gte: todayStart, $lt: todayEnd }
    });

    if (existingBooking) {
      return res.status(409).json({
        success: false,
        message: `Seat ${seatNum} was just taken — please choose another.`,
        conflict: true
      });
    }

    // Check if staff already has a booking today (application level validation)
    const staffBooking = await DailyBooking.findOne({
      staffId: username.toLowerCase(),
      booking_date: { $gte: todayStart, $lt: todayEnd }
    });

    // Delete existing booking if changing seats
    if (staffBooking) {
      await DailyBooking.findByIdAndDelete(staffBooking._id);
    }

    // Create new booking
    const newBooking = await DailyBooking.create({
      staff_id: userId,
      staffId: username.toLowerCase(),
      seat_number: seatNum,
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
        success: false,
        message: 'Seat already taken or staff already has a seat today.',
        conflict: true
      });
    }
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// GET /api/reservations - List reservations
router.get('/reservations', async (req, res) => {
  try {
    const now = new Date();
    const data = await Reservation.find({
      status: 'active',
      $or: [
        { reservation_type: 'permanent' },
        { reservation_type: 'temporary', expires_at: { $gt: now } }
      ]
    });

    const reservations = data.map(r => ({
      _id: r._id.toString(),
      seat: r.seat_number,
      label: r.label,
      type: r.reservation_type,
      status: r.status,
      expiresDate: r.expires_at ? r.expires_at.toISOString().split('T')[0] : null,
      expiresAt: r.expires_at ? r.expires_at.toISOString() : null,
      reservedAt: r.reserved_at.toISOString()
    }));

    res.json({ success: true, reservations });
  } catch (err) {
    console.error('Reservations GET error:', err);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// POST /api/reservations - Create reservation
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

    // Check existing
    const now = new Date();
    const existing = await Reservation.findOne({
      seat_number: seatNum,
      status: 'active',
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

    // Calculate expiry
    let expiresAt = null;
    if (type === 'temporary') {
      const daysNum = Math.max(1, parseInt(days, 10) || 1);
      expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + daysNum);
      expiresAt.setHours(23, 59, 59, 999);
    }

    const newRes = await Reservation.create({
      seat_number: seatNum,
      label: label.trim(),
      reservation_type: type,
      expires_at: expiresAt,
      status: 'active'
    });

    res.json({
      success: true,
      reservation: {
        _id: newRes._id.toString(),
        seat: newRes.seat_number,
        label: newRes.label,
        type: newRes.reservation_type,
        status: newRes.status,
        expiresDate: newRes.expires_at ? newRes.expires_at.toISOString().split('T')[0] : null,
        expiresAt: newRes.expires_at ? newRes.expires_at.toISOString() : null,
        reservedAt: newRes.reserved_at.toISOString()
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

// DELETE /api/reservations - Remove reservation
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