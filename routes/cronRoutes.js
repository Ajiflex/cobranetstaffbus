const express        = require('express');
const router         = express.Router();
const DailyBooking   = require('../models/DailyBooking');
const Reservation    = require('../models/TemporaryReservation');

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/cron/midnight-reset
//
// Called by Vercel Cron Jobs at 00:00 UTC every day (schedule: "0 0 * * *").
// The Authorization header check guards against arbitrary public calls.
//
// Requirement 1 — clear ALL seat reservations at midnight.
// Requirement 4 — delete expired temporary reservations.
//
// MongoDB TTL index on TemporaryReservation.expires_at already handles
// automatic expiry, but this job provides an explicit, logged, synchronous
// sweep to guarantee consistency and covers any TTL lag.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/midnight-reset', async (req, res) => {
  // Simple secret check so only Vercel's cron caller (or an admin) can trigger this
  const secret = req.headers['authorization'];
  if (process.env.CRON_SECRET && secret !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, message: 'Unauthorized.' });
  }

  const startedAt = new Date().toISOString();
  console.log(`[cron:midnight-reset] Starting daily reset at ${startedAt}`);

  try {
    // ── Req 1: delete ALL DailyBooking records (seats back to available) ──
    const bookingResult = await DailyBooking.deleteMany({});
    console.log(`[cron:midnight-reset] Deleted ${bookingResult.deletedCount} daily booking(s)`);

    // ── Req 4: delete expired temporary reservations ─────────────────────
    const now = new Date();
    const expiredResult = await Reservation.deleteMany({
      reservation_type: 'temporary',
      $or: [
        { expires_at: { $lt: now } },
        { status: 'expired' }
      ]
    });
    console.log(`[cron:midnight-reset] Deleted ${expiredResult.deletedCount} expired temporary reservation(s)`);

    console.log(`[cron:midnight-reset] Completed successfully at ${new Date().toISOString()}`);

    res.json({
      success:               true,
      message:               'Midnight reset completed.',
      deletedBookings:       bookingResult.deletedCount,
      deletedExpiredReservations: expiredResult.deletedCount,
      executedAt:            startedAt
    });
  } catch (err) {
    console.error('[cron:midnight-reset] Error during reset:', err);
    res.status(500).json({ success: false, message: 'Reset failed.', error: err.message });
  }
});

module.exports = router;
