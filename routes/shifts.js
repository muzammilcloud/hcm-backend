const express = require('express');
const router  = express.Router();
const { getDB } = require('../db');
const { requireAdmin } = require('../middleware/auth');

// GET /api/shifts
router.get('/shifts', requireAdmin, async (req, res) => {
  try {
    const pool = await getDB();
    const [rows] = await pool.execute('SELECT * FROM shifts ORDER BY created_at DESC');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/shifts
router.post('/shifts', requireAdmin, async (req, res) => {
  const { name, start_time, end_time, min_hours, days_of_week, scope, scope_id } = req.body;
  try {
    const pool = await getDB();
    const [result] = await pool.execute(
      'INSERT INTO shifts (name, start_time, end_time, min_hours, days_of_week, scope, scope_id) VALUES (?,?,?,?,?,?,?)',
      [name, start_time, end_time, min_hours || 8, days_of_week || '1,2,3,4,5', scope || 'employee', scope_id]
    );
    const [rows] = await pool.execute('SELECT * FROM shifts WHERE id=?', [result.insertId]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/shifts/:id
router.put('/shifts/:id', requireAdmin, async (req, res) => {
  const { name, start_time, end_time, min_hours, days_of_week, scope, scope_id, is_active } = req.body;
  try {
    const pool = await getDB();
    await pool.execute(
      'UPDATE shifts SET name=?, start_time=?, end_time=?, min_hours=?, days_of_week=?, scope=?, scope_id=?, is_active=? WHERE id=?',
      [name, start_time, end_time, min_hours, days_of_week, scope, scope_id, is_active ? 1 : 0, req.params.id]
    );
    const [rows] = await pool.execute('SELECT * FROM shifts WHERE id=?', [req.params.id]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/shifts/:id
router.delete('/shifts/:id', requireAdmin, async (req, res) => {
  try {
    const pool = await getDB();
    await pool.execute('DELETE FROM shifts WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
