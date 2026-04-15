const express = require('express');
const router = express.Router();
const Settings = require('../models/Settings');
const DailyBooking = require('../models/DailyBooking');
const Staff = require('../models/Staff');

// GET /api/settings
router.get('/settings', async (req, res) => {
  try {
    const data = await Settings.getSettings();
    res.json({
      success: true,
      settings: {
        id: data._id.toString(),
        openTime: data.booking_start_time,
        closeTime: data.booking_end_time,
        resultsTime: data.display_time,
        totalSeats: data.total_seats
      }
    });
  } catch (err) {
    console.error('Settings GET error:', err);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// POST /api/settings
router.post('/settings', async (req, res) => {
  try {
    const { openTime, closeTime, resultsTime, totalSeats } = req.body;

    if (!openTime || !closeTime || !resultsTime || !totalSeats) {
      return res.status(400).json({
        success: false,
        message: 'openTime, closeTime, resultsTime, and totalSeats are required.'
      });
    }

    const settings = await Settings.getSettings();
    settings.booking_start_time = openTime;
    settings.booking_end_time   = closeTime;
    settings.display_time       = resultsTime;
    settings.total_seats        = parseInt(totalSeats, 10);
    await settings.save();

    // ── Req 2: clear ALL existing bookings whenever settings change ───────
    // Any change to booking times or seat capacity invalidates the current
    // booking session. All seats are returned to available immediately.
    const clearResult = await DailyBooking.deleteMany({});
    console.log(
      `[settings:post] Settings updated — cleared ${clearResult.deletedCount} booking(s) ` +
      `(openTime=${openTime}, closeTime=${closeTime}, resultsTime=${resultsTime}, totalSeats=${totalSeats})`
    );

    res.json({
      success: true,
      message: 'Settings saved. All existing bookings have been cleared.',
      clearedBookings: clearResult.deletedCount,
      settings: {
        openTime:    settings.booking_start_time,
        closeTime:   settings.booking_end_time,
        resultsTime: settings.display_time,
        totalSeats:  settings.total_seats
      }
    });
  } catch (err) {
    console.error('Settings POST error:', err);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// GET /api/history
router.get('/history', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const data = await DailyBooking.find({
      booking_date: { $lt: today }
    }).sort({ booking_date: -1, seat_number: 1 }).populate('staff_id', 'name username department');

    const flatHistory = data.map(row => ({
      date: row.booking_date.toISOString().split('T')[0],
      seat: row.seat_number,
      name: row.staff_id ? row.staff_id.name : '',
      username: row.staffId,
      department: row.staff_id ? row.staff_id.department : '',
      time: row.booking_time
    }));

    res.json({
      success: true,
      flatHistory,
      totalBookings: flatHistory.length
    });
  } catch (err) {
    console.error('History GET error:', err);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// DELETE /api/history
router.delete('/history', async (req, res) => {
  try {
    await DailyBooking.deleteMany({});
    res.json({
      success: true,
      message: 'All booking history has been cleared.'
    });
  } catch (err) {
    console.error('History DELETE error:', err);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// POST /api/resetBookings
router.post('/resetBookings', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const result = await DailyBooking.deleteMany({
      booking_date: { $gte: today, $lt: tomorrow }
    });

    res.json({
      success: true,
      message: "Today's bookings have been reset.",
      deletedCount: result.deletedCount
    });
  } catch (err) {
    console.error('ResetBookings error:', err);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

module.exports = router;