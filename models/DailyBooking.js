// models/DailyBooking.js
const mongoose = require('mongoose');

const dailyBookingSchema = new mongoose.Schema({
  staff_id: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'Staff',
    required: true
  },
  // Lowercase username string — the primary key used in uniqueness checks.
  // Stored separately from the ObjectId ref so history survives staff deletion.
  staffId: {
    type:     String,
    required: true,
    index:    true
  },
  seat_number: {
    type:     Number,
    required: true,
    min:      1,
    max:      60
  },
  booking_date: {
    type:     Date,
    required: true,
    index:    true   // speeds up today-range queries
  },
  booking_time: {
    type:    String,
    default: () => {
      const now = new Date();
      return now.toLocaleTimeString('en-GB', {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false, timeZone: 'Africa/Lagos'
      });
    }
  },
  created_at: {
    type:    Date,
    default: Date.now
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// UNIQUE COMPOUND INDEXES — the atomic, database-level enforcement layer
//
//  Index A: { staffId, booking_date }   — one seat per staff per day.
//    Any attempt to INSERT a second document with the same (staffId, date)
//    fails immediately with MongoServerError code 11000, regardless of
//    concurrency.  bookSeat.js catches this and returns HTTP 409.
//
//  Index B: { seat_number, booking_date } — one staff per seat per day.
//    Any attempt to INSERT a duplicate (seat, date) pair fails with 11000.
//    This prevents two concurrent requests from assigning the same seat to
//    two different staff members even if both pass all application-level
//    checks before writing.
//
// These indexes act as the final guard after the transaction (or fallback)
// layer in routesreservationRoutes.js.
// ─────────────────────────────────────────────────────────────────────────────
dailyBookingSchema.index(
  { staffId: 1, booking_date: 1 },
  { unique: true, name: 'one_seat_per_staff_per_day' }
);
dailyBookingSchema.index(
  { seat_number: 1, booking_date: 1 },
  { unique: true, name: 'one_staff_per_seat_per_day' }
);

dailyBookingSchema.set('toJSON', {
  transform: function (doc, ret) {
    ret.id = ret._id.toString();
    delete ret.__v;
    return ret;
  }
});

module.exports = mongoose.model('DailyBooking', dailyBookingSchema);
