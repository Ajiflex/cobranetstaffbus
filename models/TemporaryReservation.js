// models/TemporaryReservation.js
const mongoose = require('mongoose');

const reservationSchema = new mongoose.Schema({
  seat_number: {
    type: Number,
    required: true,
    unique: true,
    min: 1,
    max: 60
  },
  label: {
    type: String,
    required: true,
    trim: true
  },
  reservation_type: {
    type: String,
    enum: ['permanent', 'temporary'],
    default: 'temporary'
  },
  reserved_at: {
    type: Date,
    default: Date.now
  },
  expires_at: {
    type: Date,
    required: function() {
      return this.reservation_type === 'temporary';
    }
  },
  status: {
    type: String,
    enum: ['active', 'expired'],
    default: 'active'
  }
});

// TTL Index: Automatically delete expired temporary reservations
reservationSchema.index({ expires_at: 1 }, { 
  expireAfterSeconds: 0,
  partialFilterExpression: { reservation_type: 'temporary' }
});

// Index for queries
reservationSchema.index({ seat_number: 1, status: 1 });
reservationSchema.index({ status: 1, reservation_type: 1 });

// Req 5: compound index for efficient expiry cleanup queries (cron job + API)
reservationSchema.index({ reservation_type: 1, expires_at: 1 });

reservationSchema.set('toJSON', {
  transform: function(doc, ret) {
    ret.id = ret._id.toString();
    ret._id = ret.id;
    delete ret.__v;
    return ret;
  }
});

module.exports = mongoose.model('Reservation', reservationSchema);