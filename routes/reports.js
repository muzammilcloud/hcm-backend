const express = require('express');
const router  = express.Router();
const { getDB } = require('../db');
const { requireAdmin, requireEmployee } = require('../middleware/auth');
const { sendWeeklyReports, sendMonthlyReports, sendMonthlySalarySlips } = require('../services/scheduler');
const { getBusinessConfig } = require('../config/business');
const { computeForPortalUser, runForMonth: runOtReconciliationForMonth } = require('../services/otReconciliation');

// Read the reconciliation snapshot for past months, compute live for current
// month. Returns a normalized row (same shape either way) for one portal_user.
async function getReconciliationRow(pool, portalUserId, year, month) {
  const now = new Date();
  const isCurrentOrFuture =
    year > now.getFullYear() ||
    (year === now.getFullYear() && month >= now.getMonth() + 1);

  if (isCurrentOrFuture) {
    const biz = await getBusinessConfig(pool);
    const snap = await computeForPortalUser(pool, portalUserId, year, month, biz);
    return { ...snap, source: 'live', computed_at: new Date().toISOString() };
  }

  const [rows] = await pool.execute(
    `SELECT * FROM monthly_ot_reconciliation
      WHERE portal_user_id = ? AND year = ? AND month = ? LIMIT 1`,
    [portalUserId, year, month]
  );
  if (rows.length > 0) return { ...rows[0], source: 'snapshot' };

  // No snapshot exists yet — compute live and persist (catches months that
  // pre-date the feature, or tenants that missed the cron window).
  const biz = await getBusinessConfig(pool);
  const snap = await computeForPortalUser(pool, portalUserId, year, month, biz);
  return { ...snap, source: 'live_backfill', computed_at: new Date().toISOString() };
}

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
    const { daily_hours } = await getBusinessConfig(pool);
    const dh = Number(daily_hours) || 9;
    let query = `
      SELECT
        e.id as employee_id, e.name, e.department, e.role,
        DATE_FORMAT(te.clock_in, '%Y-%m-%d') as date,
        ROUND(SUM(TIMESTAMPDIFF(SECOND, te.clock_in, COALESCE(te.clock_out, NOW())) / 3600), 2) as total_hours,
        ROUND(GREATEST(0, SUM(TIMESTAMPDIFF(SECOND, te.clock_in, COALESCE(te.clock_out, NOW())) / 3600) - ${dh}), 2) as ot_hours
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

// ─────────────────────────────────────────────────────────────────────────────
// Monthly OT Reconciliation — report-only summary of the 3-step breakdown
// for the previous month (or any selected month). Per-session OT approval
// flow is unchanged.
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/reports/monthly-reconciliation?year=&month=&portal_user_id=
// Admin: all employees (optional filter to one). Returns a list.
router.get('/reports/monthly-reconciliation', requireAdmin, async (req, res) => {
  try {
    const pool = await getDB();
    const now   = new Date();
    let year    = parseInt(req.query.year,  10);
    let month   = parseInt(req.query.month, 10);
    if (!Number.isFinite(year))  year  = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
    if (!Number.isFinite(month) || month < 1 || month > 12) {
      month = now.getMonth() === 0 ? 12 : now.getMonth();
    }
    const filterPu = req.query.portal_user_id ? parseInt(req.query.portal_user_id, 10) : null;

    let users;
    if (filterPu) {
      const [rows] = await pool.execute(
        `SELECT id, name, department, role FROM portal_users
          WHERE id = ? AND portal_role IN ('employee','team-lead')`,
        [filterPu]
      );
      users = rows;
    } else {
      const [rows] = await pool.execute(
        `SELECT id, name, department, role FROM portal_users
          WHERE status = 'active' AND portal_role IN ('employee','team-lead')
          ORDER BY name ASC`
      );
      users = rows;
    }

    const out = [];
    for (const u of users) {
      const row = await getReconciliationRow(pool, u.id, year, month);
      out.push({
        portal_user_id: u.id, name: u.name, department: u.department, role: u.role,
        ...row,
      });
    }
    res.json({ year, month, rows: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/reports/monthly-reconciliation/run?year=&month= — Admin
// Manual re-run for a specific month. Useful after fixing leave/holiday data.
router.post('/reports/monthly-reconciliation/run', requireAdmin, async (req, res) => {
  try {
    const pool = await getDB();
    const year  = parseInt(req.query.year, 10);
    const month = parseInt(req.query.month, 10);
    if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
      return res.status(400).json({ error: 'year + month (1-12) required' });
    }
    const result = await runOtReconciliationForMonth(pool, year, month);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/employee/monthly-reconciliation?year=&month= — Employee: own
router.get('/employee/monthly-reconciliation', requireEmployee, async (req, res) => {
  try {
    const pool = await getDB();
    const now   = new Date();
    let year    = parseInt(req.query.year,  10);
    let month   = parseInt(req.query.month, 10);
    if (!Number.isFinite(year))  year  = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
    if (!Number.isFinite(month) || month < 1 || month > 12) {
      month = now.getMonth() === 0 ? 12 : now.getMonth();
    }
    const row = await getReconciliationRow(pool, req.portalUserId, year, month);
    res.json({ year, month, row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/employee/overtime — Employee: own overtime
router.get('/employee/overtime', requireEmployee, async (req, res) => {
  const { from, to } = req.query;
  try {
    const pool = await getDB();
    const { daily_hours } = await getBusinessConfig(pool);
    const dh = Number(daily_hours) || 9;
    let query = `
      SELECT
        DATE_FORMAT(clock_in, '%Y-%m-%d') as date,
        ROUND(SUM(TIMESTAMPDIFF(SECOND, clock_in, COALESCE(clock_out, NOW())) / 3600), 2) as total_hours,
        ROUND(GREATEST(0, SUM(TIMESTAMPDIFF(SECOND, clock_in, COALESCE(clock_out, NOW())) / 3600) - ${dh}), 2) as ot_hours
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
