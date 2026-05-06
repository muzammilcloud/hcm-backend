const express = require('express');
const router  = express.Router();
const { getDB } = require('../db');
const { requireAdmin } = require('../middleware/auth');

// GET /api/resignation/lookup?email=... — Admin: fetch employee + salary + history
router.get('/resignation/lookup', requireAdmin, async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email is required' });
  try {
    const pool = await getDB();

    const [empRows] = await pool.execute(
      'SELECT id, name, email, department, role, created_at, is_active FROM employees WHERE email = ?',
      [email.trim()]
    );
    if (empRows.length === 0) return res.status(404).json({ error: 'No employee found with this email' });

    const emp = empRows[0];

    const [salaryRows] = await pool.execute(
      'SELECT * FROM employee_salaries WHERE employee_id = ?',
      [emp.id]
    );

    const [historyRows] = await pool.execute(
      `SELECT id, DATE_FORMAT(month, '%Y-%m-%d') as month, gross_salary,
              provident_fund, withholding_tax, total_deductions, net_salary, days_worked
       FROM salary_history WHERE employee_id = ? ORDER BY month ASC`,
      [emp.id]
    );

    res.json({
      employee: emp,
      salary:   salaryRows[0] || null,
      history:  historyRows,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
