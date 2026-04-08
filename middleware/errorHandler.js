// middleware/errorHandler.js
const errorHandler = (err, req, res, next) => {
  console.error('Error:', err);

  if (err.name === 'ValidationError') {
    const messages = Object.values(err.errors).map(val => val.message);
    return res.status(400).json({
      success: false,
      message: messages.join(', ')
    });
  }

  if (err.code === 11000) {
    const field = Object.keys(err.keyValue)[0];
    let message = 'Duplicate field value entered';
    
    if (field === 'staffId') {
      message = 'Staff ID already exists';
    } else if (field === 'seat_number' && err.message.includes('reservation')) {
      message = 'Seat already has an active reservation';
    } else if (err.message.includes('dailybookings')) {
      if (field === 'staffId') {
        message = 'Staff already has a seat for today';
      } else {
        message = 'Seat already taken for today';
      }
    }
    
    return res.status(409).json({
      success: false,
      message: message
    });
  }

  if (err.name === 'CastError') {
    return res.status(400).json({
      success: false,
      message: `Invalid ${err.path}: ${err.value}`
    });
  }

  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Server error. Please try again.'
  });
};

module.exports = errorHandler;
