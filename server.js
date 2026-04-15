const express = require('express');
const cors    = require('cors');
const path    = require('path');
require('dotenv').config();

const connectDB    = require('./config/db');
const errorHandler = require('./middleware/errorHandler');

const app = express();

app.use(cors());
app.use(express.json());

// Serve static frontend files (no DB needed)
app.use(express.static(path.join(__dirname, 'public')));

// Ensure DB is connected before every API request.
// On Vercel serverless each cold start re-runs this file — calling
// connectDB() at module load would not await it, so the first request
// would always race against an unresolved connection.
// Using middleware guarantees the connection is ready before any handler runs.
app.use('/api', async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error('DB middleware error:', err.message);
    res.status(503).json({
      success: false,
      message: `Database connection failed: ${err.message}`,
    });
  }
});

app.use('/api', require('./routes/staffRoutes'));
app.use('/api', require('./routes/routesreservationRoutes'));
app.use('/api', require('./routes/routessettingsRoutes'));
app.use('/api/cron', require('./routes/cronRoutes'));

app.use(errorHandler);

module.exports = app;
