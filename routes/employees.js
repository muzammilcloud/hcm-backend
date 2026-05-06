const express = require('express');
const router  = express.Router();
const { getDB, generateToken, logEvent } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { sendInviteEmail } = require('../services/email');

// POST /api/employees/data — Add employee record only (no invite)
router.post('/employees/data', requireAdmin, async (req, res) => {
  const { name, email, role, department, date_of_birth, join_date, first_name, last_name, father_name, gender, cnic, emp_code, marital_status, employment_status, reports_to } = req.body;
  const displayName = (first_name && last_name) ? `${first_name} ${last_name}` : (name || '');
  if (!displayName || !email) return res.status(400).json({ error: 'Name and email required' });
  try {
    const pool = await getDB();
    const [result] = await pool.execute(
      'INSERT INTO employees (name, email, role, department, is_active, date_of_birth, join_date, first_name, last_name, father_name, gender, cnic, emp_code, marital_status, employment_status, reports_to) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [displayName, email, role || 'Employee', department || 'General', date_of_birth || null, join_date || null, first_name || null, last_name || null, father_name || null, gender || null, cnic || null, emp_code || null, marital_status || 'Single', employment_status || 'probation', reports_to || null]
    );
    const [rows] = await pool.execute('SELECT * FROM employees WHERE id = ?', [result.insertId]);
    await logEvent(pool, { employee_id: result.insertId, employee_name: displayName, department: department || 'General', role: role || 'Employee', event: 'added', detail: `Employee record created (no invite)` });
    res.json({ ...rows[0], has_pending_invite: 0 });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Email already exists' });
    res.status(500).json({ error: e.message });
  }
});

// POST /api/employees — Admin invites employee
router.post('/employees', requireAdmin, async (req, res) => {
  const { name, email, role, department, date_of_birth, join_date, first_name, last_name, father_name, gender, cnic, emp_code, marital_status, employment_status, reports_to } = req.body;
  const displayName = (first_name && last_name) ? `${first_name} ${last_name}` : (name || '');
  if (!displayName || !email) return res.status(400).json({ error: 'Name and email required' });
  try {
    const pool = await getDB();

    // Check if employee with this email already exists
    const [existing] = await pool.execute('SELECT * FROM employees WHERE email = ?', [email]);

    let empId, empName;
    if (existing.length > 0) {
      // Reuse the existing employee record — just send a fresh invite
      empId   = existing[0].id;
      empName = existing[0].name || displayName;
    } else {
      // Create new employee record (no password yet — pending invite)
      const [result] = await pool.execute(
        'INSERT INTO employees (name, email, role, department, is_active, date_of_birth, join_date, first_name, last_name, father_name, gender, cnic, emp_code, marital_status, employment_status, reports_to) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [displayName, email, role || 'Employee', department || 'General', date_of_birth || null, join_date || null, first_name || null, last_name || null, father_name || null, gender || null, cnic || null, emp_code || null, marital_status || 'Single', employment_status || 'probation', reports_to || null]
      );
      empId   = result.insertId;
      empName = displayName;
    }

    // Create invite token (7 days) — replace any existing token for this employee
    const inviteToken = generateToken();
    const expiresAt   = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await pool.execute('DELETE FROM employee_invites WHERE employee_id = ?', [empId]);
    await pool.execute(
      'INSERT INTO employee_invites (employee_id, token, expires_at) VALUES (?, ?, ?)',
      [empId, inviteToken, expiresAt]
    );

    // Send invite email
    const emailSent = await sendInviteEmail({ name: empName, email, inviteToken });

    const [rows] = await pool.execute('SELECT * FROM employees WHERE id = ?', [empId]);
    await logEvent(pool, { employee_id: empId, employee_name: empName, department: rows[0].department, role: rows[0].role, event: 'invited', detail: `Invited via email to ${email}` });
    res.json({ ...rows[0], email_sent: emailSent, invite_token: inviteToken, has_pending_invite: 1 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/employees/:id/resend-invite
router.post('/employees/:id/resend-invite', requireAdmin, async (req, res) => {
  try {
    const pool = await getDB();
    const [empRows] = await pool.execute('SELECT * FROM employees WHERE id = ?', [req.params.id]);
    if (empRows.length === 0) return res.status(404).json({ error: 'Employee not found' });
    const emp = empRows[0];

    // Delete old invites
    await pool.execute('DELETE FROM employee_invites WHERE employee_id = ?', [emp.id]);

    // Create new invite
    const inviteToken = generateToken();
    const expiresAt   = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await pool.execute(
      'INSERT INTO employee_invites (employee_id, token, expires_at) VALUES (?, ?, ?)',
      [emp.id, inviteToken, expiresAt]
    );

    const emailSent = await sendInviteEmail({ name: emp.name, email: emp.email, inviteToken });
    res.json({ success: true, email_sent: emailSent });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/employees
router.get('/employees', requireAdmin, async (req, res) => {
  try {
    const pool = await getDB();
    const [rows] = await pool.execute(`
      SELECT e.*,
        CASE WHEN ei.employee_id IS NOT NULL AND e.is_active = 0 THEN 1 ELSE 0 END AS has_pending_invite,
        pu.status      AS hcm_status,
        pu.id          AS portal_user_id,
        pu.portal_role AS portal_role,
        tl.name     AS reports_to_name,
        tl.emp_code AS reports_to_code
      FROM employees e
      LEFT JOIN employee_invites ei ON e.id = ei.employee_id
      LEFT JOIN portal_users pu ON pu.employee_id = e.id
      LEFT JOIN employees tl ON tl.id = e.reports_to
      ORDER BY e.name
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/employees/:id
router.put('/employees/:id', requireAdmin, async (req, res) => {
  const { name, email, role, department, date_of_birth, join_date, first_name, last_name, father_name, gender, cnic, emp_code, marital_status, employment_status, reports_to } = req.body;
  const displayName = (first_name && last_name) ? `${first_name} ${last_name}` : (name || '');
  try {
    const pool = await getDB();
    await pool.execute(
      'UPDATE employees SET name=?, email=?, role=?, department=?, date_of_birth=?, join_date=?, first_name=?, last_name=?, father_name=?, gender=?, cnic=?, emp_code=?, marital_status=?, employment_status=?, reports_to=? WHERE id=?',
      [displayName, email, role, department, date_of_birth || null, join_date || null, first_name || null, last_name || null, father_name || null, gender || null, cnic || null, emp_code || null, marital_status || 'Single', employment_status || 'probation', reports_to || null, req.params.id]
    );
    const [rows] = await pool.execute(
      'SELECT * FROM employees WHERE id=?',
      [req.params.id]
    );
    await logEvent(pool, { employee_id: rows[0].id, employee_name: rows[0].name, department: rows[0].department, role: rows[0].role, event: 'edited', detail: `Updated to: ${displayName} | ${role} | ${department}` });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/employees/:id
router.delete('/employees/:id', requireAdmin, async (req, res) => {
  try {
    const pool = await getDB();
    // Fetch employee info before deleting for the log
    const [empRows] = await pool.execute(
      'SELECT e.*, ROUND(SUM(TIMESTAMPDIFF(SECOND,te.clock_in,COALESCE(te.clock_out,NOW()))/3600),2) as total_hours, DATEDIFF(NOW(),e.created_at) as days_served FROM employees e LEFT JOIN time_entries te ON e.id=te.employee_id WHERE e.id=? GROUP BY e.id',
      [req.params.id]
    );
    const emp = empRows[0];
    await pool.execute('DELETE FROM employee_sessions WHERE employee_id=?', [req.params.id]);
    await pool.execute('DELETE FROM employee_invites WHERE employee_id=?', [req.params.id]);
    await pool.execute('DELETE FROM time_entries WHERE employee_id=?', [req.params.id]);
    await pool.execute('DELETE FROM employees WHERE id=?', [req.params.id]);
    if (emp) {
      await logEvent(pool, { employee_id: null, employee_name: emp.name, department: emp.department, role: emp.role, event: 'deleted', detail: `Removed after ${emp.days_served || 0} days · ${emp.total_hours || 0}h total worked · ${emp.email}` });
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
