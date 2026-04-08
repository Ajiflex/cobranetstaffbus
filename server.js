const express = require('express');
const cors = require('cors');
const path = require('path');

const connectDB = require('./config/db');
const errorHandler = require('./middleware/errorHandler');

const app = express();

// Connect to database
connectDB();

// Middleware
app.use(cors());
app.use(express.json());

// Serve frontend
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.use('/api/staff', require('./routes/staffRoutes'));
app.use('/api/reservations', require('./routes/reservationRoutes'));
app.use('/api/settings', require('./routes/settingsRoutes'));
app.use('/api/history', require('./routes/settingsRoutes'));
app.use('/api/resetBookings', require('./routes/settingsRoutes'));

// Error handler
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

app.listen(PORT, () =>
  console.log(`Server running on port ${PORT}`)
);