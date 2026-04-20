// models/SystemLog.js
// Records system lifecycle events:
//   MIDNIGHT_RESET            — nightly seat cleanup
//   TEMP_RESERVATION_EXPIRED  — a temporary admin reservation expired
//   BOOKING_MOVED_TO_HISTORY  — booking rows were archived to BookingHistory
//   BOOKING_CONFLICT          — staff attempted to book when they already hold a seat
//   SEAT_CONFLICT             — two concurrent requests targeted the same seat

const mongoose = require('mongoose');

const systemLogSchema = new mongoose.Schema({
  event_type: {
    type:     String,
    enum:     [
      'MIDNIGHT_RESET',
      'TEMP_RESERVATION_EXPIRED',
      'BOOKING_MOVED_TO_HISTORY',
      'BOOKING_CONFLICT',
      'SEAT_CONFLICT',
      // New events added for production fixes
      'EARLY_BOOKING_ATTEMPT',    // Staff tried to book before opening time
      'BOOKING_TIME_REJECTED',    // Booking rejected by server-side time check
      'SESSION_INVALIDATED',      // Admin forced all sessions to expire
      'AUTH_FAILURE',             // Login attempt with wrong credentials
      'BOOKING_ATTEMPT',          // Any seat booking attempt (success or fail)
      'SEAT_RESERVATION_ACTION'   // Admin created / removed a seat reservation
    ],
    required: true,
    index:    true
  },
  timestamp: {
    type:    Date,
    default: Date.now,
    index:   true
  },
  records_processed: {
    type:    Number,
    default: 0
  },
  status: {
    type:    String,
    enum:    ['success', 'partial', 'failed'],
    default: 'success'
  },
  details: {
    type:    String,
    default: ''
  }
});

systemLogSchema.set('toJSON', {
  transform: function (doc, ret) {
    ret.id = ret._id.toString();
    delete ret.__v;
    return ret;
  }
});

module.exports = mongoose.model('SystemLog', systemLogSchema);
