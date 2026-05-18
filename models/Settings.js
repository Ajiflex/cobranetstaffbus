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
    // Incremented by POST /api/forceLogoutAll to invalidate all active client sessions.
    // Clients store this value in localStorage; mismatch → forced re-login.
    session_version: {
      type:    Number,
      default: 1,
      min:     1,
    },
  },
  {
    timestamps: true,
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// IN-MEMORY SETTINGS CACHE
// Reduces repeated MongoDB reads on every /seats and /serverTime poll.
// Cache TTL: 5 minutes. Call Settings.clearCache() after any save() to ensure
// the next read fetches fresh data from MongoDB.
// ─────────────────────────────────────────────────────────────────────────────
let _settingsCache   = null;
let _settingsCacheAt = 0;
const CACHE_TTL_MS   = 5 * 60 * 1000; // 5 minutes

settingsSchema.statics.getSettings = async function () {
  const now = Date.now();
  if (_settingsCache && (now - _settingsCacheAt) < CACHE_TTL_MS) {
    return _settingsCache;
  }
  let settings = await this.findOne();
  if (!settings) {
    settings = await this.create({});
  }
  _settingsCache   = settings;
  _settingsCacheAt = now;
  return settings;
};

settingsSchema.statics.clearCache = function () {
  _settingsCache   = null;
  _settingsCacheAt = 0;
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
