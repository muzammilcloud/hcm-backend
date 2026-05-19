const express = require('express');
const router  = express.Router();
const { getDB } = require('../db');
const { requireAdmin, requireEmployee } = require('../middleware/auth');
const { calculateSlip } = require('../services/salaryCalc');
const { generateSalarySlipPdf } = require('../services/pdf');

// Helper — load employee + slip + workspace settings + the recipient locale
// (the EMPLOYEE'S locale, not the requester's, so a Japanese employee's
// slip is in Japanese even if the admin downloading it is in en).
async function loadSlipBundle(pool, employeeId, fallbackLocale) {
  const slip = await calculateSlip(pool, Number(employeeId));
  const [empRows] = await pool.execute(
    `SELECT e.id, e.name, e.role, e.department, e.emp_code,
            pu.preferred_locale
     FROM employees e
     LEFT JOIN portal_users pu ON pu.employee_id = e.id
     WHERE e.id = ? LIMIT 1`,
    [Number(employeeId)]
  );
  const employee = empRows[0] || null;
  const [setRows] = await pool.execute(
    `SELECT currency, country_code, company_name, slip_title, default_locale
     FROM tenant_settings WHERE singleton_key = 1 LIMIT 1`
  );
  const settings = setRows[0] || {};
  const locale = employee?.preferred_locale
              || settings.default_locale
              || fallbackLocale
              || 'en';
  return { employee, slip, settings, locale };
}

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

// ── PDF endpoints (server-rendered via Puppeteer, CJK-safe) ─────────────────

// GET /api/employee/me/slip.pdf — employee downloads their own slip
router.get('/employee/me/slip.pdf', requireEmployee, async (req, res, next) => {
  try {
    const pool = await getDB();
    const [rows] = await pool.execute(
      'SELECT employee_id FROM portal_users WHERE id = ?',
      [req.portalUserId]
    );
    if (!rows.length || !rows[0].employee_id) {
      return res.status(404).json({ error: 'No employee record linked to this portal account.' });
    }
    const bundle = await loadSlipBundle(pool, rows[0].employee_id, req.locale);
    const pdf = await generateSalarySlipPdf(bundle);
    res.set({
      'Content-Type':        'application/pdf',
      'Content-Disposition': `attachment; filename="salary-slip-${bundle.slip?.month || 'current'}.pdf"`,
      'Content-Length':      pdf.length,
      'Cache-Control':       'no-store',
    });
    res.send(pdf);
  } catch (e) { next(e); }
});

// GET /api/salary/slip/:employee_id.pdf — admin downloads any employee's slip
router.get('/salary/slip/:employee_id.pdf', requireAdmin, async (req, res, next) => {
  try {
    const pool = await getDB();
    const bundle = await loadSlipBundle(pool, req.params.employee_id, req.locale);
    const pdf = await generateSalarySlipPdf(bundle);
    res.set({
      'Content-Type':        'application/pdf',
      'Content-Disposition': `attachment; filename="salary-slip-${bundle.employee?.emp_code || req.params.employee_id}-${bundle.slip?.month || 'current'}.pdf"`,
      'Content-Length':      pdf.length,
      'Cache-Control':       'no-store',
    });
    res.send(pdf);
  } catch (e) { next(e); }
});

module.exports = router;
