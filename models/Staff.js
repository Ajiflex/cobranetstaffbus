const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

const staffSchema = new mongoose.Schema(
  {
    username: {
      type:     String,
      required: [true, 'Username is required'],
      unique:   true,
      trim:     true,
      lowercase: true,
    },
    name: {
      type:     String,
      required: [true, 'Name is required'],
      trim:     true,
    },
    department: {
      type:    String,
      trim:    true,
      default: '',
    },
    password: {
      type:     String,
      required: [true, 'Password is required'],
    },
    role: {
      type:    String,
      enum:    ['admin', 'staff'],
      default: 'staff',
    },
    mustChangePw: {
      type:    Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

staffSchema.methods.comparePassword = async function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

staffSchema.statics.hashPassword = async function (plainText) {
  return bcrypt.hash(plainText, 10);
};

staffSchema.set('toJSON', {
  transform: function (doc, ret) {
    ret._id = ret._id.toString();
    delete ret.password;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('Staff', staffSchema);
