const express = require('express');
const router  = express.Router();
const { getDB, logEvent } = require('../db');
const { requireAdmin, requireEmployee } = require('../middleware/auth');

// GET /api/ot-requests (admin)
router.get('/ot-requests', requireAdmin, async (req, res) => {
  try {
    const pool = await getDB();
    const { status, employee_id } = req.query;

    let query = `
      SELECT otr.id, otr.time_entry_id, otr.employee_id,
             DATE_FORMAT(otr.date, '%Y-%m-%d') as date,
             otr.total_hours, otr.ot_hours, otr.status, otr.admin_note,
             otr.created_at, otr.updated_at,
             e.name, e.department, e.role
      FROM ot_requests otr
      JOIN employees e ON otr.employee_id = e.id
      WHERE 1=1
    `;
    const params = [];
    if (status)      { query += ' AND otr.status = ?';      params.push(status); }
    if (employee_id) { query += ' AND otr.employee_id = ?'; params.push(employee_id); }
    query += ' ORDER BY otr.created_at DESC';

    const [rows] = await pool.execute(query, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/ot-requests/:id (admin)
router.put('/ot-requests/:id', requireAdmin, async (req, res) => {
  try {
    const pool = await getDB();
    const { status, admin_note } = req.body;

    if (!['approved', 'denied'].includes(status)) {
      return res.status(400).json({ error: 'Status must be approved or denied' });
    }

    const [existing] = await pool.execute(
      `SELECT otr.*, e.name, e.department, e.role
       FROM ot_requests otr JOIN employees e ON otr.employee_id = e.id
       WHERE otr.id = ?`,
      [req.params.id]
    );
    if (existing.length === 0) return res.status(404).json({ error: 'OT request not found' });

    await pool.execute(
      'UPDATE ot_requests SET status=?, admin_note=? WHERE id=?',
      [status, admin_note || null, req.params.id]
    );

    const rec = existing[0];
    await logEvent(pool, {
      employee_id:   rec.employee_id,
      employee_name: rec.name,
      department:    rec.department,
      role:          rec.role,
      event:         status === 'approved' ? 'ot_approved' : 'ot_denied',
      detail:        `OT ${status} — ${rec.ot_hours}h OT on ${rec.date}`,
    });

    const [updated] = await pool.execute('SELECT * FROM ot_requests WHERE id=?', [req.params.id]);
    res.json(updated[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/employee/ot-requests (employee)
router.get('/employee/ot-requests', requireEmployee, async (req, res) => {
  try {
    const pool = await getDB();
    const [rows] = await pool.execute(
      `SELECT id, time_entry_id, employee_id, DATE_FORMAT(date, '%Y-%m-%d') as date,
              total_hours, ot_hours, status, admin_note, created_at, updated_at
       FROM ot_requests WHERE employee_id=? ORDER BY date DESC`,
      [req.employeeId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
