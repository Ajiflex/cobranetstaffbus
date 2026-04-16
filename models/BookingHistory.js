// models/BookingHistory.js
// Permanent archive of every completed DailyBooking record.
// Records are inserted here BEFORE the active DailyBooking row is deleted
// so that history is never lost during a midnight reset or admin reset.

const mongoose = require('mongoose');

const bookingHistorySchema = new mongoose.Schema({
  // Core booking identity
  seatId: {
    type:     Number,
    required: true,
    index:    true
  },
  staffId: {
    type:     String,
    required: true,
    index:    true
  },
  // Denormalised staff info so history survives staff deletion
  staffName: {
    type:    String,
    default: ''
  },
  staffDepartment: {
    type:    String,
    default: ''
  },
  // Keep the ObjectId ref for optional population (may be null if staff deleted)
  staff_ref: {
    type: mongoose.Schema.Types.ObjectId,
    ref:  'Staff'
  },
  // Booking time fields
  bookingDate: {
    type:     Date,
    required: true,
    index:    true
  },
  startTime: {            // original booking_time (HH:MM:SS when seat was claimed)
    type:    String,
    default: ''
  },
  endTime: {              // reserved for future use
    type:    String,
    default: ''
  },
  reservationType: {      // always 'daily' for staff bookings
    type:    String,
    default: 'daily'
  },
  // Timestamps
  createdAt: {            // when the original DailyBooking was created
    type:    Date,
    default: Date.now
  },
  archivedAt: {           // when this history record was written
    type:    Date,
    default: Date.now,
    index:   true
  },
  archiveReason: {        // why the booking was archived
    type: String,
    enum: ['midnight_reset', 'admin_reset', 'settings_change', 'manual'],
    default: 'midnight_reset'
  }
});

// Compound indexes for efficient history queries
bookingHistorySchema.index({ bookingDate: 1, seatId: 1 });
bookingHistorySchema.index({ staffId: 1, bookingDate: 1 });

bookingHistorySchema.set('toJSON', {
  transform: function (doc, ret) {
    ret.id = ret._id.toString();
    delete ret.__v;
    return ret;
  }
});

module.exports = mongoose.model('BookingHistory', bookingHistorySchema);
