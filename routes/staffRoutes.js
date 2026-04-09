const express = require('express');
const router = express.Router();
const Staff = require('../models/Staff');

// GET /api/staff — list all staff
router.get('/', async (req, res) => {
  try {
    const staff = await Staff.find().sort({ staff_name: 1 });
    res.json({ success: true, staff });
  } catch (err) {
    console.error('Staff GET error:', err);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// POST /api/staff — create a staff member
router.post('/', async (req, res) => {
  try {
    const { staffId, staff_name, department } = req.body;

    if (!staffId || !staff_name) {
      return res.status(400).json({
        success: false,
        message: 'staffId and staff_name are required.',
      });
    }

    const member = await Staff.create({
      staffId: staffId.toLowerCase().trim(),
      staff_name: staff_name.trim(),
      department: department ? department.trim() : '',
    });

    res.status(201).json({ success: true, staff: member });
  } catch (err) {
    console.error('Staff POST error:', err);
    if (err.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'A staff member with that ID already exists.',
      });
    }
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// GET /api/staff/:staffId — get one staff member by staffId
router.get('/:staffId', async (req, res) => {
  try {
    const member = await Staff.findOne({
      staffId: req.params.staffId.toLowerCase(),
    });

    if (!member) {
      return res.status(404).json({ success: false, message: 'Staff member not found.' });
    }

    res.json({ success: true, staff: member });
  } catch (err) {
    console.error('Staff GET /:staffId error:', err);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// PUT /api/staff/:staffId — update a staff member
router.put('/:staffId', async (req, res) => {
  try {
    const { staff_name, department } = req.body;

    const update = {};
    if (staff_name) update.staff_name = staff_name.trim();
    if (department !== undefined) update.department = department.trim();

    const member = await Staff.findOneAndUpdate(
      { staffId: req.params.staffId.toLowerCase() },
      update,
      { new: true, runValidators: true }
    );

    if (!member) {
      return res.status(404).json({ success: false, message: 'Staff member not found.' });
    }

    res.json({ success: true, staff: member });
  } catch (err) {
    console.error('Staff PUT error:', err);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// DELETE /api/staff/:staffId — remove a staff member
router.delete('/:staffId', async (req, res) => {
  try {
    const member = await Staff.findOneAndDelete({
      staffId: req.params.staffId.toLowerCase(),
    });

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
