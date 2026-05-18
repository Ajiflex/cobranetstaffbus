const mongoose = require('mongoose');

// ─────────────────────────────────────────────────────────────────────────────
// VERCEL SERVERLESS CONNECTION CACHING
//
// Problem: Vercel cold-starts re-evaluate every module, resetting any
// module-level variable (e.g. `isConnected = false`).  Two concurrent
// cold-start invocations both see `isConnected === false` and each call
// mongoose.connect() — creating duplicate connections.
//
// Solution: cache the in-flight connection PROMISE on the `global` object.
// `global` survives module re-evaluation within the same execution environment,
// so all concurrent invocations await the SAME promise instead of each
// starting a new connection.  On a genuine cold start `global._mongooseConn`
// is undefined and exactly one connect() call is made.
//
// Pool settings: Mongoose 6+ defaults to maxPoolSize=100.  With ~40 users
// across several serverless instances that means hundreds of Atlas connections.
// Capping at 10 per instance keeps the total well within Atlas free-tier limits.
// ─────────────────────────────────────────────────────────────────────────────

const POOL_OPTIONS = {
  maxPoolSize:              5,
  minPoolSize:              0,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS:          45000,
  connectTimeoutMS:         10000,
};

const connectDB = async () => {
  // Fast-path: existing open connection (warm invocation, same instance)
  if (mongoose.connection.readyState === 1) {
    return;
  }

  // Mid-flight: another concurrent invocation already started connecting —
  // wait for the same promise rather than opening a second connection.
  if (global._mongooseConn) {
    await global._mongooseConn;
    return;
  }

  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI environment variable is not set.');
  }

  // Store the promise immediately so concurrent calls share it.
  global._mongooseConn = mongoose
    .connect(process.env.MONGODB_URI, POOL_OPTIONS)
    .then(async (conn) => {
      console.log('MongoDB connected:', conn.connection.host);
      await seedAdmin();
      return conn;
    })
    .catch((err) => {
      // Clear the cached promise on failure so the next request can retry.
      global._mongooseConn = null;
      console.error('MongoDB connection error — full detail:', err);
      throw err;
    });

  await global._mongooseConn;
};

async function seedAdmin() {
  try {
    const Staff = require('../models/Staff');
    const existing = await Staff.findOne({ username: 'admin' });
    if (!existing) {
      const hashed = await Staff.hashPassword('admin123');
      await Staff.create({
        username:     'admin',
        name:         'Administrator',
        role:         'admin',
        password:     hashed,
        mustChangePw: false,
      });
      console.log('Admin user created — username: admin / password: admin123');
    }
  } catch (err) {
    console.error('Seed error:', err.message);
  }
}

module.exports = connectDB;
