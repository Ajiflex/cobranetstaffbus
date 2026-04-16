// routes/cronRoutes.js
//
// POST /api/cron/midnight-reset
//
// Called by Vercel Cron Jobs at 00:00 UTC every day (vercel.json: "0 0 * * *").
// The Authorization header check guards against arbitrary public calls.
//
// Operations (inside a transaction where supported):
//   1. Move all active DailyBooking rows to BookingHistory
//   2. Delete the archived DailyBooking rows (seats back to FREE)
//   3. Delete expired temporary reservations
//   4. Write a MIDNIGHT_RESET system-log entry

const express     = require('express');
const router      = express.Router();
const Reservation = require('../models/TemporaryReservation');
const SystemLog   = require('../models/SystemLog');
const { archiveAndDeleteBookings } = require('../utils/bookingArchiver');

router.post('/midnight-reset', async (req, res) => {
  // Guard: only Vercel cron caller (or bearer-token admin) may trigger this
  const secret = req.headers['authorization'];
  if (process.env.CRON_SECRET && secret !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, message: 'Unauthorized.' });
  }

  const startedAt = new Date();
  console.log(`[cron:midnight-reset] Starting daily reset at ${startedAt.toISOString()}`);

  try {
    // ── Step 1 & 2: Archive ALL active bookings → BookingHistory, then delete ──
    // archiveAndDeleteBookings uses a transaction internally (Atlas replica sets).
    // Passing {} matches every DailyBooking document.
    const { archived, deleted } = await archiveAndDeleteBookings({}, 'midnight_reset');

    console.log(
      `[cron:midnight-reset] Archived ${archived} booking(s) to history, ` +
      `deleted ${deleted} DailyBooking row(s).`
    );

    // ── Step 3: Delete expired temporary reservations ─────────────────────
    const now = new Date();
    const expiredResult = await Reservation.deleteMany({
      reservation_type: 'temporary',
      $or: [
        { expires_at: { $lt: now } },
        { status:     'expired'   }
      ]
    });

    const expiredCount = expiredResult.deletedCount;
    console.log(
      `[cron:midnight-reset] Deleted ${expiredCount} expired temporary reservation(s).`
    );

    // Log expired reservation count separately if any were cleaned up
    if (expiredCount > 0) {
      await SystemLog.create({
        event_type:        'TEMP_RESERVATION_EXPIRED',
        timestamp:         now,
        records_processed: expiredCount,
        status:            'success',
        details:           `Midnight cleanup removed ${expiredCount} expired temporary reservation(s).`
      }).catch(e => console.error('[cron] SystemLog write failed:', e.message));
    }

    // ── Step 4: Write MIDNIGHT_RESET log entry ────────────────────────────
    const completedAt = new Date();
    await SystemLog.create({
      event_type:        'MIDNIGHT_RESET',
      timestamp:         startedAt,
      records_processed: archived,
      status:            'success',
      details:
        `Reset completed at ${completedAt.toISOString()}. ` +
        `Archived: ${archived}, Deleted bookings: ${deleted}, ` +
        `Deleted expired reservations: ${expiredCount}.`
    }).catch(e => console.error('[cron] SystemLog write failed:', e.message));

    console.log(`[cron:midnight-reset] Completed at ${completedAt.toISOString()}`);

    res.json({
      success:                    true,
      message:                    'Midnight reset completed.',
      archivedBookings:           archived,
      deletedBookings:            deleted,
      deletedExpiredReservations: expiredCount,
      executedAt:                 startedAt.toISOString()
    });

  } catch (err) {
    console.error('[cron:midnight-reset] Error during reset:', err);

    // Attempt to log the failure
    await SystemLog.create({
      event_type:        'MIDNIGHT_RESET',
      timestamp:         startedAt,
      records_processed: 0,
      status:            'failed',
      details:           `Reset failed: ${err.message}`
    }).catch(() => {});

    res.status(500).json({
      success: false,
      message: 'Reset failed.',
      error:   err.message
    });
  }
});

module.exports = router;
