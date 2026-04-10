const mongoose = require('mongoose');

let isConnected = false;

const connectDB = async () => {
  if (isConnected && mongoose.connection.readyState === 1) {
    return;
  }

  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI environment variable is not set.');
  }

  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS:          45000,
    });

    isConnected = true;
    console.log('MongoDB connected:', mongoose.connection.host);
    await seedAdmin();
  } catch (err) {
    isConnected = false;
    console.error('MongoDB connection error — full detail:', err);
    throw err;
  }
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
