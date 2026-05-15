const express = require('express');
const router  = express.Router();
const { getDB } = require('../db');
const { requireAdmin, requireEmployee } = require('../middleware/auth');
const { calculateSlip } = require('../services/salaryCalc');

// GET /api/employee/me/slip — logged-in employee fetches their own slip
router.get('/employee/me/slip', requireEmployee, async (req, res, next) => {
  try {
    const pool = await getDB();
    const [rows] = await pool.execute(
      'SELECT employee_id FROM portal_users WHERE id = ?',
      [req.portalUserId]
    );
    if (!rows.length || !rows[0].employee_id) {
      return res.status(404).json({ error: 'No employee record linked to this portal account.' });
    }
    const slip = await calculateSlip(pool, rows[0].employee_id);
    res.json(slip);
  } catch (e) {
    if (e.message === 'Employee not found') return res.status(404).json({ error: e.message });
    next(e);
  }
});

// GET /api/salary/slip/:employee_id — calculated salary slip preview
router.get('/salary/slip/:employee_id', requireAdmin, async (req, res, next) => {
  try {
    const pool = await getDB();
    const slip = await calculateSlip(pool, Number(req.params.employee_id));
    res.json(slip);
  } catch (e) {
    if (e.message === 'Employee not found') return res.status(404).json({ error: e.message });
    next(e);
  }
});

// GET /api/salary/overrides/:employee_id
router.get('/salary/overrides/:employee_id', requireAdmin, async (req, res, next) => {
  try {
    const pool = await getDB();
    const [rows] = await pool.execute(
      `SELECT o.id, o.component_id, o.calc_method, o.amount, o.percent, o.cap_amount, o.note,
              c.code, c.name, c.kind
       FROM employee_component_overrides o
       JOIN salary_components c ON c.id = o.component_id
       WHERE o.employee_id = ?`,
      [Number(req.params.employee_id)]
    );
    res.json({ overrides: rows });
  } catch (e) { next(e); }
});

// PUT /api/salary/overrides/:employee_id/:component_id — upsert one override
router.put('/salary/overrides/:employee_id/:component_id', requireAdmin, async (req, res, next) => {
  try {
    const pool = await getDB();
    const { calc_method, amount, percent, cap_amount, note } = req.body || {};
    if (!['fixed', 'percent_of_basic', 'percent_of_gross', 'percent_of_ctc'].includes(calc_method)) {
      return res.status(400).json({ error: 'Invalid calc_method' });
    }
    await pool.execute(
      `INSERT INTO employee_component_overrides
         (employee_id, component_id, calc_method, amount, percent, cap_amount, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         calc_method = VALUES(calc_method),
         amount      = VALUES(amount),
         percent     = VALUES(percent),
         cap_amount  = VALUES(cap_amount),
         note        = VALUES(note)`,
      [
        Number(req.params.employee_id),
        Number(req.params.component_id),
        calc_method,
        calc_method === 'fixed' ? Number(amount || 0) : null,
        calc_method !== 'fixed' ? Number(percent || 0) : null,
        cap_amount === '' || cap_amount == null ? null : Number(cap_amount),
        note || null,
      ]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// DELETE /api/salary/overrides/:employee_id/:component_id — revert to default
router.delete('/salary/overrides/:employee_id/:component_id', requireAdmin, async (req, res, next) => {
  try {
    const pool = await getDB();
    await pool.execute(
      `DELETE FROM employee_component_overrides WHERE employee_id = ? AND component_id = ?`,
      [Number(req.params.employee_id), Number(req.params.component_id)]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
