const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const connectDB = require('./config/db');
const errorHandler = require('./middleware/errorHandler');

const app = express();

connectDB();

app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/staff', require('./routes/staffRoutes'));
app.use('/api', require('./routes/routesreservationRoutes'));
app.use('/api', require('./routes/routessettingsRoutes'));

app.use(errorHandler);

module.exports = app;
