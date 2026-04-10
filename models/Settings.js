const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema(
  {
    booking_start_time: {
      type: String,
      default: '07:00',
    },
    booking_end_time: {
      type: String,
      default: '09:00',
    },
    display_time: {
      type: String,
      default: '09:30',
    },
    total_seats: {
      type: Number,
      default: 32,
      min: 1,
      max: 100,
    },
  },
  {
    timestamps: true,
  }
);

settingsSchema.statics.getSettings = async function () {
  let settings = await this.findOne();
  if (!settings) {
    settings = await this.create({});
  }
  return settings;
};

settingsSchema.set('toJSON', {
  transform: function (doc, ret) {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('Settings', settingsSchema);
