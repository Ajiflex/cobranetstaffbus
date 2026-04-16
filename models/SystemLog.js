// models/SystemLog.js
// Records system lifecycle events:
//   MIDNIGHT_RESET            — nightly seat cleanup
//   TEMP_RESERVATION_EXPIRED  — a temporary admin reservation expired
//   BOOKING_MOVED_TO_HISTORY  — booking rows were archived to BookingHistory

const mongoose = require('mongoose');

const systemLogSchema = new mongoose.Schema({
  event_type: {
    type:     String,
    enum:     ['MIDNIGHT_RESET', 'TEMP_RESERVATION_EXPIRED', 'BOOKING_MOVED_TO_HISTORY'],
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
