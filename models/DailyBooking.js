// models/DailyBooking.js
const mongoose = require('mongoose');

const dailyBookingSchema = new mongoose.Schema({
  staff_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Staff',
    required: true
  },
  staffId: {
    type: String,
    required: true,
    index: true
  },
  seat_number: {
    type: Number,
    required: true,
    min: 1,
    max: 60
  },
  booking_date: {
    type: Date,
    required: true
  },
  booking_time: {
    type: String,
    default: () => {
      const now = new Date();
      return now.toLocaleTimeString('en-GB', {
        hour:     '2-digit',
        minute:   '2-digit',
        second:   '2-digit',
        hour12:   false,
        timeZone: 'Africa/Lagos'
      });
    }
  },
  created_at: {
    type: Date,
    default: Date.now
  }
});

// Compound unique indexes for business rules
// One seat per staff per day
dailyBookingSchema.index({ staffId: 1, booking_date: 1 }, { unique: true });
// One staff per seat per day
dailyBookingSchema.index({ seat_number: 1, booking_date: 1 }, { unique: true });

dailyBookingSchema.set('toJSON', {
  transform: function(doc, ret) {
    ret.id = ret._id.toString();
    delete ret.__v;
    return ret;
  }
});

module.exports = mongoose.model('DailyBooking', dailyBookingSchema);