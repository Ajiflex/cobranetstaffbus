const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
    });
    console.log(`MongoDB connected: ${conn.connection.host}`);
    await seedAdmin();
  } catch (err) {
    console.error(`MongoDB connection error: ${err.message}`);
    process.exit(1);
  }
};

async function seedAdmin () {
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
      console.log('Admin user seeded — username: admin / password: admin123');
    }
  } catch (err) {
    console.error('Admin seed error:', err.message);
  }
}

module.exports = connectDB;
