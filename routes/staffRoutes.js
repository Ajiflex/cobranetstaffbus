const express = require('express');
const router  = express.Router();
const Staff   = require('../models/Staff');

// POST /api/login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: 'Username and password are required.',
      });
    }

    const user = await Staff.findOne({ username: username.toLowerCase().trim() });
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid username or password.',
      });
    }

    const match = await user.comparePassword(password);
    if (!match) {
      return res.status(401).json({
        success: false,
        message: 'Invalid username or password.',
      });
    }

    res.json({
      success: true,
      user: {
        _id:          user._id,
        name:         user.name,
        username:     user.username,
        department:   user.department || '',
        role:         user.role,
        mustChangePw: user.mustChangePw,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// POST /api/changePassword
router.post('/changePassword', async (req, res) => {
  try {
    const { userId, newPassword } = req.body;

    if (!userId || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'userId and newPassword are required.',
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 6 characters.',
      });
    }

    const hashed = await Staff.hashPassword(newPassword);
    const user   = await Staff.findByIdAndUpdate(
      userId,
      { password: hashed, mustChangePw: false },
      { new: true }
    );

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    res.json({ success: true, message: 'Password updated successfully.' });
  } catch (err) {
    console.error('ChangePassword error:', err);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// GET /api/staff — list all staff
router.get('/staff', async (req, res) => {
  try {
    const staff = await Staff.find().sort({ name: 1 });
    res.json({ success: true, users: staff });
  } catch (err) {
    console.error('Staff GET error:', err);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// POST /api/staff — create a staff member
router.post('/staff', async (req, res) => {
  try {
    const { name, username, department, password, role } = req.body;

    if (!name || !username || !password) {
      return res.status(400).json({
        success: false,
        message: 'Name, username, and password are required.',
      });
    }

    const hashed = await Staff.hashPassword(password);
    const member = await Staff.create({
      username:     username.toLowerCase().trim(),
      name:         name.trim(),
      department:   department ? department.trim() : '',
      password:     hashed,
      role:         role || 'staff',
      mustChangePw: true,
    });

    res.status(201).json({ success: true, user: member });
  } catch (err) {
    console.error('Staff POST error:', err);
    if (err.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'A staff member with that username already exists.',
      });
    }
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// PUT /api/staff — update a staff member
router.put('/staff', async (req, res) => {
  try {
    const { userId, name, department, password, role } = req.body;

    if (!userId || !name) {
      return res.status(400).json({
        success: false,
        message: 'userId and name are required.',
      });
    }

    const update = {
      name:       name.trim(),
      department: department ? department.trim() : '',
      role:       role || 'staff',
    };

    if (password) {
      update.password     = await Staff.hashPassword(password);
      update.mustChangePw = true;
    }

    const member = await Staff.findByIdAndUpdate(userId, update, {
      new:            true,
      runValidators:  true,
    });

    if (!member) {
      return res.status(404).json({ success: false, message: 'Staff member not found.' });
    }

    res.json({ success: true, user: member });
  } catch (err) {
    console.error('Staff PUT error:', err);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// DELETE /api/staff — remove a staff member
router.delete('/staff', async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required.' });
    }

    const member = await Staff.findByIdAndDelete(userId);

    if (!member) {
      return res.status(404).json({ success: false, message: 'Staff member not found.' });
    }

    res.json({ success: true, message: 'Staff member removed.' });
  } catch (err) {
    console.error('Staff DELETE error:', err);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

module.exports = router;
