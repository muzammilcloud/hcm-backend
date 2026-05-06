const express = require('express');
const router  = express.Router();
const { getDB } = require('../db');
const { requireAdmin, requireEmployee } = require('../middleware/auth');
const { sendWeeklyReports, sendMonthlyReports, sendMonthlySalarySlips } = require('../services/scheduler');

// GET /api/reports/summary
router.get('/reports/summary', requireAdmin, async (req, res) => {
  const { from, to } = req.query;
  try {
    const pool = await getDB();
    let query = `
      SELECT e.id, e.name, e.department, e.role,
        COUNT(te.id) as total_sessions,
        ROUND(SUM(TIMESTAMPDIFF(SECOND, te.clock_in, COALESCE(te.clock_out, NOW())) / 3600), 2) as total_hours
      FROM employees e LEFT JOIN time_entries te ON e.id = te.employee_id WHERE 1=1
    `;
    const params = [];
    if (req.query.department) { query += ' AND e.department = ?'; params.push(req.query.department); }
    if (from) { query += ' AND (te.clock_in IS NULL OR DATE(te.clock_in) >= ?)'; params.push(from); }
    if (to)   { query += ' AND (te.clock_in IS NULL OR DATE(te.clock_in) <= ?)'; params.push(to); }
    query += ' GROUP BY e.id ORDER BY total_hours DESC';
    const [rows] = await pool.execute(query, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/reports/send-weekly — Manual trigger
router.post('/reports/send-weekly', requireAdmin, async (req, res) => {
  await sendWeeklyReports();
  res.json({ success: true, message: 'Weekly reports sent' });
});

// POST /api/reports/send-monthly — Manual trigger
router.post('/reports/send-monthly', requireAdmin, async (req, res) => {
  await sendMonthlyReports();
  res.json({ success: true, message: 'Monthly reports sent' });
});

// POST /api/reports/send-salary-slips — Manual trigger
router.post('/reports/send-salary-slips', requireAdmin, async (req, res) => {
  await sendMonthlySalarySlips();
  res.json({ success: true, message: 'Salary slips sent' });
});

// GET /api/employee-logs
router.get('/employee-logs', requireAdmin, async (req, res) => {
  const { event, search } = req.query;
  try {
    const pool = await getDB();
    let query  = 'SELECT * FROM employee_logs WHERE 1=1';
    const params = [];
    if (event)  { query += ' AND event = ?'; params.push(event); }
    if (search) { query += ' AND employee_name LIKE ?'; params.push(`%${search}%`); }
    query += ' ORDER BY created_at DESC LIMIT 500';
    const [rows] = await pool.execute(query, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/employee-stats
router.get('/employee-stats', requireAdmin, async (req, res) => {
  try {
    const pool = await getDB();
    const [rows] = await pool.execute(`
      SELECT
        e.id, e.name, e.email, e.department, e.role, e.is_active, e.created_at,
        DATEDIFF(NOW(), e.created_at) as days_served,
        COUNT(te.id) as total_sessions,
        ROUND(COALESCE(SUM(TIMESTAMPDIFF(SECOND, te.clock_in, COALESCE(te.clock_out, NOW())) / 3600), 0), 2) as total_hours,
        MAX(te.clock_in) as last_seen
      FROM employees e
      LEFT JOIN time_entries te ON e.id = te.employee_id
      GROUP BY e.id
      ORDER BY e.created_at DESC
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/reports/departments
router.get('/reports/departments', requireAdmin, async (req, res) => {
  const { from, to } = req.query;
  try {
    const pool = await getDB();
    let query = `
      SELECT
        e.department,
        COUNT(DISTINCT e.id) as headcount,
        COUNT(te.id) as total_sessions,
        ROUND(COALESCE(SUM(TIMESTAMPDIFF(SECOND, te.clock_in, COALESCE(te.clock_out, NOW())) / 3600), 0), 2) as total_hours,
        ROUND(COALESCE(AVG(TIMESTAMPDIFF(SECOND, te.clock_in, COALESCE(te.clock_out, NOW())) / 3600), 0), 2) as avg_session_hours
      FROM employees e
      LEFT JOIN time_entries te ON e.id = te.employee_id
      WHERE 1=1
    `;
    const params = [];
    if (from) { query += ' AND (te.clock_in IS NULL OR DATE(te.clock_in) >= ?)'; params.push(from); }
    if (to)   { query += ' AND (te.clock_in IS NULL OR DATE(te.clock_in) <= ?)'; params.push(to); }
    query += ' GROUP BY e.department ORDER BY total_hours DESC';
    const [rows] = await pool.execute(query, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/reports/overtime — Admin
router.get('/reports/overtime', requireAdmin, async (req, res) => {
  const { from, to, employee_id, department } = req.query;
  try {
    const pool = await getDB();
    let query = `
      SELECT
        e.id as employee_id, e.name, e.department, e.role,
        DATE_FORMAT(te.clock_in, '%Y-%m-%d') as date,
        ROUND(SUM(TIMESTAMPDIFF(SECOND, te.clock_in, COALESCE(te.clock_out, NOW())) / 3600), 2) as total_hours,
        ROUND(GREATEST(0, SUM(TIMESTAMPDIFF(SECOND, te.clock_in, COALESCE(te.clock_out, NOW())) / 3600) - 9), 2) as ot_hours
      FROM employees e
      JOIN time_entries te ON e.id = te.employee_id
      WHERE te.clock_out IS NOT NULL
    `;
    const params = [];
    if (from) { query += ' AND DATE(te.clock_in) >= ?'; params.push(from); }
    if (to)   { query += ' AND DATE(te.clock_in) <= ?'; params.push(to); }
    if (employee_id) { query += ' AND e.id = ?'; params.push(employee_id); }
    if (department)  { query += ' AND e.department = ?'; params.push(department); }
    query += ' GROUP BY e.id, e.name, e.department, e.role, DATE_FORMAT(te.clock_in, \'%Y-%m-%d\') HAVING ot_hours > 0 ORDER BY date DESC, ot_hours DESC';
    const [rows] = await pool.execute(query, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/employee/overtime — Employee: own overtime
router.get('/employee/overtime', requireEmployee, async (req, res) => {
  const { from, to } = req.query;
  try {
    const pool = await getDB();
    let query = `
      SELECT
        DATE_FORMAT(clock_in, '%Y-%m-%d') as date,
        ROUND(SUM(TIMESTAMPDIFF(SECOND, clock_in, COALESCE(clock_out, NOW())) / 3600), 2) as total_hours,
        ROUND(GREATEST(0, SUM(TIMESTAMPDIFF(SECOND, clock_in, COALESCE(clock_out, NOW())) / 3600) - 9), 2) as ot_hours
      FROM time_entries
      WHERE employee_id = ? AND clock_out IS NOT NULL
    `;
    const params = [req.employeeId];
    if (from) { query += ' AND DATE(clock_in) >= ?'; params.push(from); }
    if (to)   { query += ' AND DATE(clock_in) <= ?'; params.push(to); }
    query += ' GROUP BY DATE_FORMAT(clock_in, \'%Y-%m-%d\') HAVING ot_hours > 0 ORDER BY date DESC';
    const [rows] = await pool.execute(query, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
