// utils/bookingArchiver.js
//
// Shared utility that:
//   1. Reads DailyBooking rows matching `query`
//   2. Inserts them into BookingHistory (with denormalised staff data)
//   3. Deletes the original DailyBooking rows
//   4. Writes a BOOKING_MOVED_TO_HISTORY system-log entry
//
// The insert + delete is wrapped in a MongoDB session transaction so
// either both succeed or both are rolled back — no data loss either way.
//
// Falls back to non-transactional execution if the MongoDB deployment
// does not support sessions (standalone instance).

const mongoose     = require('mongoose');
const DailyBooking = require('../models/DailyBooking');
const BookingHistory = require('../models/BookingHistory');
const SystemLog    = require('../models/SystemLog');

/**
 * @param {Object} query          Mongoose filter for DailyBooking.find()
 * @param {string} archiveReason  'midnight_reset' | 'admin_reset' | 'settings_change' | 'manual'
 * @returns {{ archived: number, deleted: number }}
 */
async function archiveAndDeleteBookings(query = {}, archiveReason = 'midnight_reset') {
  const now = new Date();

  // Fetch all matching bookings, populate staff name + department
  const bookings = await DailyBooking.find(query).populate('staff_id', 'name department');

  if (bookings.length === 0) {
    return { archived: 0, deleted: 0 };
  }

  // Build history documents (denormalise to survive staff deletion)
  const historyDocs = bookings.map(b => {
    const staffDoc = b.staff_id && typeof b.staff_id === 'object' ? b.staff_id : null;
    return {
      seatId:          b.seat_number,
      staffId:         b.staffId,
      staff_ref:       staffDoc?._id ?? null,
      staffName:       staffDoc?.name        || b.staffId,
      staffDepartment: staffDoc?.department  || '',
      bookingDate:     b.booking_date,
      startTime:       b.booking_time || '',
      endTime:         '',
      reservationType: 'daily',
      createdAt:       b.created_at || b._id.getTimestamp(),
      archivedAt:      now,
      archiveReason
    };
  });

  let archived = 0;
  let deleted  = 0;

  // ── Attempt transactional write (requires replica set / Atlas) ────────────
  let session = null;
  try {
    session = await mongoose.startSession();

    await session.withTransaction(async () => {
      await BookingHistory.insertMany(historyDocs, { session });
      const delResult = await DailyBooking.deleteMany(query, { session });
      archived = historyDocs.length;
      deleted  = delResult.deletedCount;
    });

  } catch (txErr) {
    // ── Fallback: non-transactional best-effort ────────────────────────────
    // This path is taken on standalone MongoDB instances that do not support
    // sessions. Data loss risk is minimal because we insert before we delete.
    console.warn(
      '[archiver] Transaction not supported, falling back to non-transactional mode:',
      txErr.message
    );

    const insertResult = await BookingHistory.insertMany(historyDocs, { ordered: false });
    archived = insertResult.length;

    const delResult = await DailyBooking.deleteMany(query);
    deleted = delResult.deletedCount;

  } finally {
    if (session) await session.endSession().catch(() => {});
  }

  // ── Write system-log entry (non-fatal) ───────────────────────────────────
  try {
    await SystemLog.create({
      event_type:        'BOOKING_MOVED_TO_HISTORY',
      timestamp:         now,
      records_processed: archived,
      status:            'success',
      details:
        `Archived ${archived} booking(s) to BookingHistory. ` +
        `Deleted ${deleted} DailyBooking row(s). Reason: ${archiveReason}`
    });
  } catch (logErr) {
    console.error('[archiver] SystemLog write failed (non-fatal):', logErr.message);
  }

  console.log(
    `[archiver] archived=${archived} deleted=${deleted} reason=${archiveReason}`
  );

  return { archived, deleted };
}

module.exports = { archiveAndDeleteBookings };
