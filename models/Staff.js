const mongoose = require('mongoose');

const staffSchema = new mongoose.Schema(
  {
    staffId: {
      type: String,
      required: [true, 'Staff ID is required'],
      unique: true,
      trim: true,
      lowercase: true,
    },
    staff_name: {
      type: String,
      required: [true, 'Staff name is required'],
      trim: true,
    },
    department: {
      type: String,
      trim: true,
      default: '',
    },
    pin: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

staffSchema.set('toJSON', {
  transform: function (doc, ret) {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    delete ret.pin;
    return ret;
  },
});

module.exports = mongoose.model('Staff', staffSchema);
