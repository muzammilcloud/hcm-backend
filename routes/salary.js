const express = require('express');
const router  = express.Router();
const { getDB } = require('../db');
const { requireAdmin, requireEmployee } = require('../middleware/auth');
const { calculateSalaryBreakdown } = require('../services/salary');

// Load the tenant's configured income-tax brackets for calculateSalaryBreakdown:
//   non-empty array → use them; [] → tax disabled (0); null → none configured
//   (legacy PK fallback). Mirrors the tenant-aware slip engine (salaryCalc.js).
async function loadTaxBrackets(pool) {
  try {
    const [brackets] = await pool.execute(
      'SELECT band_from, band_to, rate FROM tax_brackets ORDER BY sort_order ASC, band_from ASC'
    );
    let taxEnabled = true;
    try {
      const [meta] = await pool.execute('SELECT tax_enabled FROM tax_bracket_meta WHERE singleton_key = 1 LIMIT 1');
      if (meta.length && meta[0].tax_enabled != null) taxEnabled = !!meta[0].tax_enabled;
    } catch (_) {}
    if (!taxEnabled) return [];               // explicitly disabled → 0 tax
    if (brackets.length) return brackets;     // configured → use them
    return null;                              // none configured → legacy fallback
  } catch (_) {
    return null;                              // no tax tables → legacy fallback
  }
}

// GET /api/salaries — Admin: every employee in the workspace.
// Includes employees who haven't activated their portal account yet
// (is_active=0) so admins can pre-configure salary at hire time. The
// previous WHERE is_active=1 hid newly-created employees and made it
// look like salary saves were silently failing.
router.get('/salaries', requireAdmin, async (req, res) => {
  try {
    const pool = await getDB();
    const [rows] = await pool.execute(`
      SELECT e.id, e.name, e.email, e.department, e.role, e.is_active,
             s.basic_salary, s.house_rent, s.conveyance, s.medical, s.utilities,
             s.created_at, s.updated_at
      FROM employees e
      LEFT JOIN employee_salaries s ON e.id = s.employee_id
      ORDER BY e.name
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/salaries/:employeeId — Admin: set/update salary
router.post('/salaries/:employeeId', requireAdmin, async (req, res) => {
  const { employeeId } = req.params;
  const { basic_salary, house_rent, conveyance, medical, utilities } = req.body;

  try {
    const pool = await getDB();

    const [existing] = await pool.execute(
      'SELECT * FROM employee_salaries WHERE employee_id = ?',
      [employeeId]
    );

    if (existing.length > 0) {
      await pool.execute(`
        UPDATE employee_salaries
        SET basic_salary = ?, house_rent = ?, conveyance = ?, medical = ?, utilities = ?
        WHERE employee_id = ?
      `, [basic_salary, house_rent, conveyance, medical, utilities, employeeId]);
    } else {
      await pool.execute(`
        INSERT INTO employee_salaries (employee_id, basic_salary, house_rent, conveyance, medical, utilities)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [employeeId, basic_salary, house_rent, conveyance, medical, utilities]);
    }

    const [result] = await pool.execute(
      'SELECT * FROM employee_salaries WHERE employee_id = ?',
      [employeeId]
    );

    res.json(result[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/employee/salary/current — Employee: current month pro-rata
router.get('/employee/salary/current', requireEmployee, async (req, res) => {
  try {
    const pool = await getDB();
    const [salary] = await pool.execute(
      'SELECT * FROM employee_salaries WHERE employee_id = ?',
      [req.employeeId]
    );

    if (salary.length === 0) {
      return res.json({ message: 'No salary configured yet' });
    }

    const now = new Date();
    const daysInMonth = 30;
    const daysWorked = now.getDate();

    const taxBrackets = await loadTaxBrackets(pool);
    const breakdown = calculateSalaryBreakdown(salary[0], daysInMonth, daysWorked, taxBrackets);

    res.json({
      ...salary[0],
      breakdown: breakdown.proRata,
      month: now.toISOString().slice(0, 7), // YYYY-MM
      isPartialMonth: true
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/employee/salary/history — Employee: completed months
router.get('/employee/salary/history', requireEmployee, async (req, res) => {
  try {
    const pool = await getDB();
    const [rows] = await pool.execute(
      'SELECT * FROM salary_history WHERE employee_id = ? ORDER BY month DESC',
      [req.employeeId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/salaries/:employeeId/generate/:month — Admin: close month
router.post('/salaries/:employeeId/generate/:month', requireAdmin, async (req, res) => {
  const { employeeId, month } = req.params; // month format: YYYY-MM
  const { days_worked = 30 } = req.body;

  try {
    const pool = await getDB();

    const [salary] = await pool.execute(
      'SELECT * FROM employee_salaries WHERE employee_id = ?',
      [employeeId]
    );

    if (salary.length === 0) {
      return res.status(404).json({ error: 'Salary not configured for this employee' });
    }

    const taxBrackets = await loadTaxBrackets(pool);
    const breakdown = calculateSalaryBreakdown(salary[0], 30, days_worked, taxBrackets);
    const data = breakdown.proRata;

    await pool.execute(`
      INSERT INTO salary_history
      (employee_id, month, basic_salary, house_rent, conveyance, medical, utilities,
       gross_salary, provident_fund, withholding_tax, total_deductions, net_salary, days_worked)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        basic_salary = VALUES(basic_salary),
        house_rent = VALUES(house_rent),
        conveyance = VALUES(conveyance),
        medical = VALUES(medical),
        utilities = VALUES(utilities),
        gross_salary = VALUES(gross_salary),
        provident_fund = VALUES(provident_fund),
        withholding_tax = VALUES(withholding_tax),
        total_deductions = VALUES(total_deductions),
        net_salary = VALUES(net_salary),
        days_worked = VALUES(days_worked)
    `, [
      employeeId, month + '-01',
      data.basic, data.houseRent, data.conveyance, data.medical, data.utilities,
      data.gross, data.providentFund, data.withholdingTax,
      data.totalDeductions, data.net, days_worked
    ]);

    res.json({ message: 'Salary generated successfully', month });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
