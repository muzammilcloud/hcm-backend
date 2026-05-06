const express = require('express');
const router  = express.Router();
const { getDB } = require('../db');
const { requireAdmin } = require('../middleware/auth');

// GET /api/birthdays — all active employees with DOB, sorted by days until next birthday
router.get('/birthdays', requireAdmin, async (req, res) => {
  try {
    const pool = await getDB();
    const [rows] = await pool.execute(`
      SELECT id, name, email, department, role, date_of_birth,
        CASE
          WHEN DATE(CONCAT(YEAR(CURDATE()), DATE_FORMAT(date_of_birth, '-%m-%d'))) >= CURDATE()
          THEN DATE(CONCAT(YEAR(CURDATE()), DATE_FORMAT(date_of_birth, '-%m-%d')))
          ELSE DATE(CONCAT(YEAR(CURDATE())+1, DATE_FORMAT(date_of_birth, '-%m-%d')))
        END AS next_birthday,
        DATEDIFF(
          CASE
            WHEN DATE(CONCAT(YEAR(CURDATE()), DATE_FORMAT(date_of_birth, '-%m-%d'))) >= CURDATE()
            THEN DATE(CONCAT(YEAR(CURDATE()), DATE_FORMAT(date_of_birth, '-%m-%d')))
            ELSE DATE(CONCAT(YEAR(CURDATE())+1, DATE_FORMAT(date_of_birth, '-%m-%d')))
          END,
          CURDATE()
        ) AS days_until
      FROM employees
      WHERE date_of_birth IS NOT NULL
      ORDER BY days_until ASC
    `);
    res.json({ employees: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/anniversaries — all active employees with join_date, sorted by days until next work anniversary
router.get('/anniversaries', requireAdmin, async (req, res) => {
  try {
    const pool = await getDB();
    const [rows] = await pool.execute(`
      SELECT id, name, email, department, role, join_date,
        CASE
          WHEN DATE(CONCAT(YEAR(CURDATE()), DATE_FORMAT(join_date, '-%m-%d'))) >= CURDATE()
          THEN DATE(CONCAT(YEAR(CURDATE()), DATE_FORMAT(join_date, '-%m-%d')))
          ELSE DATE(CONCAT(YEAR(CURDATE())+1, DATE_FORMAT(join_date, '-%m-%d')))
        END AS next_anniversary,
        DATEDIFF(
          CASE
            WHEN DATE(CONCAT(YEAR(CURDATE()), DATE_FORMAT(join_date, '-%m-%d'))) >= CURDATE()
            THEN DATE(CONCAT(YEAR(CURDATE()), DATE_FORMAT(join_date, '-%m-%d')))
            ELSE DATE(CONCAT(YEAR(CURDATE())+1, DATE_FORMAT(join_date, '-%m-%d')))
          END,
          CURDATE()
        ) AS days_until
      FROM employees
      WHERE join_date IS NOT NULL
      ORDER BY days_until ASC
    `);
    res.json({ employees: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
