// routes/settingsRoutes.js
const express      = require('express');
const router       = express.Router();
const Settings     = require('../models/Settings');
const BookingHistory = require('../models/BookingHistory');
const { archiveAndDeleteBookings } = require('../utils/bookingArchiver');

// GET /api/settings
router.get('/settings', async (req, res) => {
  try {
    const data = await Settings.getSettings();
    res.json({
      success:  true,
      settings: {
        id:             data._id.toString(),
        openTime:       data.booking_start_time,
        closeTime:      data.booking_end_time,
        resultsTime:    data.display_time,
        totalSeats:     data.total_seats,
        sessionVersion: data.session_version || 1
      }
    });
  } catch (err) {
    console.error('Settings GET error:', err);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// POST /api/settings
// Saves new settings and clears (archiving first) all existing bookings,
// because any change to booking times or seat capacity invalidates the session.
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
    Settings.clearCache(); // force fresh read on next poll

    // Archive all existing bookings to history before clearing them
    const { archived, deleted } = await archiveAndDeleteBookings({}, 'settings_change');
    console.log(
      `[settings:post] Settings updated — archived ${archived} and cleared ${deleted} booking(s) ` +
      `(openTime=${openTime}, closeTime=${closeTime}, resultsTime=${resultsTime}, totalSeats=${totalSeats})`
    );

    res.json({
      success:         true,
      message:         'Settings saved. All existing bookings have been archived and cleared.',
      archivedBookings: archived,
      clearedBookings:  deleted,
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
// Returns all archived booking history from the BookingHistory collection.
// Records survive midnight resets because they are inserted here BEFORE
// DailyBooking rows are deleted.
router.get('/history', async (req, res) => {
  try {
    const data = await BookingHistory.find({})
      .sort({ bookingDate: -1, seatId: 1 })
      .lean();

    const flatHistory = data.map(row => ({
      date:       row.bookingDate.toISOString().split('T')[0],
      seat:       row.seatId,
      name:       row.staffName || row.staffId,
      username:   row.staffId,
      department: row.staffDepartment || '',
      time:       row.startTime || ''
    }));

    res.json({
      success:       true,
      flatHistory,
      totalBookings: flatHistory.length
    });
  } catch (err) {
    console.error('History GET error:', err);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// DELETE /api/history
// Permanently deletes ALL booking history records.
router.delete('/history', async (req, res) => {
  try {
    await BookingHistory.deleteMany({});
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
// Admin-triggered same-day reset: archives today's bookings to history,
// then removes them from DailyBooking so seats become available again.
router.post('/resetBookings', async (req, res) => {
  try {
    const today    = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const { archived, deleted } = await archiveAndDeleteBookings(
      { booking_date: { $gte: today, $lt: tomorrow } },
      'admin_reset'
    );

    res.json({
      success:         true,
      message:         "Today's bookings have been archived and reset.",
      archivedBookings: archived,
      deletedCount:     deleted
    });
  } catch (err) {
    console.error('ResetBookings error:', err);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

module.exports = router;
