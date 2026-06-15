const express = require('express');
const router  = express.Router();
const { getDB, hashPassword, verifyPassword, generateToken, logEvent } = require('../db');
const { requireEmployee } = require('../middleware/auth');
const { sendPasswordResetEmail } = require('../services/email');

// GET /api/invite/:token
router.get('/invite/:token', async (req, res) => {
  try {
    const pool = await getDB();
    const [rows] = await pool.execute(
      'SELECT * FROM portal_users WHERE invite_token = ? AND invite_expires_at > NOW() AND status = ?',
      [req.params.token, 'pending']
    );
    if (rows.length === 0) return res.status(400).json({ error: 'Invite link is invalid or has expired.' });
    res.json({ valid: true, name: rows[0].name, email: rows[0].email });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/invite/:token/set-password
router.post('/invite/:token/set-password', async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const pool = await getDB();
    const [rows] = await pool.execute(
      "SELECT * FROM portal_users WHERE invite_token = ? AND invite_expires_at > NOW() AND status = 'pending'",
      [req.params.token]
    );
    if (rows.length === 0) return res.status(400).json({ error: 'Invite link is invalid or has expired.' });
    const pu = rows[0];

    await pool.execute(
      "UPDATE portal_users SET password_hash=?, status='active', invite_token=NULL, invite_expires_at=NULL WHERE id=?",
      [hashPassword(password), pu.id]
    );

    await logEvent(pool, { employee_name: pu.name, department: pu.department, role: pu.role, event: 'portal_activated', detail: 'Portal account activated' });

    const token     = generateToken();
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
    await pool.execute('DELETE FROM portal_sessions WHERE portal_user_id = ?', [pu.id]);
    await pool.execute('INSERT INTO portal_sessions (portal_user_id, token, expires_at) VALUES (?, ?, ?)', [pu.id, token, expiresAt]);

    const portalRole = pu.portal_role || 'employee';
    res.json({ token, expires_at: expiresAt, role: portalRole, employee: { id: pu.id, name: pu.name, email: pu.email, role: pu.role, department: pu.department, portal_role: portalRole } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/employee/login
router.post('/employee/login', async (req, res, next) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const pool = await getDB();
    const [rows] = await pool.execute(
      "SELECT * FROM portal_users WHERE LOWER(email) = LOWER(?) AND status = 'active'",
      [email]
    );
    if (rows.length === 0) return res.status(401).json({ error: 'Invalid email or password, or account not yet activated.' });
    const pu = rows[0];

    const { ok, needsRehash } = verifyPassword(password, pu.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password, or account not yet activated.' });

    if (needsRehash) {
      try { await pool.execute('UPDATE portal_users SET password_hash = ? WHERE id = ?', [hashPassword(password), pu.id]); }
      catch (e) { console.error('Password rehash failed:', e.message); }
    }

    const portalRole = pu.portal_role || 'employee';
    const token      = generateToken();
    const expiresAt  = new Date(Date.now() + 8 * 60 * 60 * 1000);
    await pool.execute('DELETE FROM portal_sessions WHERE portal_user_id = ?', [pu.id]);
    await pool.execute('INSERT INTO portal_sessions (portal_user_id, token, expires_at) VALUES (?, ?, ?)', [pu.id, token, expiresAt]);

    res.json({ token, expires_at: expiresAt, role: portalRole, employee: { id: pu.id, name: pu.name, email: pu.email, role: pu.role, department: pu.department, portal_role: portalRole } });
  } catch (e) { next(e); }
});

// POST /api/employee/logout
router.post('/employee/logout', async (req, res) => {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (token) {
    try { const pool = await getDB(); await pool.execute('DELETE FROM portal_sessions WHERE token = ?', [token]); } catch (_) {}
  }
  res.json({ success: true });
});

// GET /api/employee/me
router.get('/employee/me', requireEmployee, async (req, res) => {
  try {
    const pool = await getDB();
    const [rows] = await pool.execute(
      `SELECT pu.id, pu.name, pu.email, pu.role, pu.department, pu.portal_role, pu.created_at,
              e.emp_code, e.join_date, e.date_of_birth, e.marital_status, e.employment_status,
              rt.name AS reports_to_name, rt.emp_code AS reports_to_code
       FROM portal_users pu
       LEFT JOIN employees e  ON pu.employee_id = e.id
       LEFT JOIN employees rt ON e.reports_to = rt.id
       WHERE pu.id = ?`,
      [req.portalUserId]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/employee/forgot-password
router.post('/employee/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const pool = await getDB();
    const [rows] = await pool.execute("SELECT * FROM portal_users WHERE email = ? AND status = 'active'", [email]);
    if (rows.length === 0) return res.json({ success: true, message: 'If that email exists, a reset link has been sent.' });
    const pu = rows[0];

    const resetToken = generateToken();
    const expiresAt  = new Date(Date.now() + 60 * 60 * 1000);
    await pool.execute('UPDATE portal_users SET reset_token=?, reset_expires_at=? WHERE id=?', [resetToken, expiresAt, pu.id]);
    await sendPasswordResetEmail({ name: pu.name, email: pu.email, resetToken });
    res.json({ success: true, message: 'If that email exists, a reset link has been sent.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/employee/reset-password
router.post('/employee/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const pool = await getDB();
    const [rows] = await pool.execute('SELECT * FROM portal_users WHERE reset_token = ? AND reset_expires_at > NOW()', [token]);
    if (rows.length === 0) return res.status(400).json({ error: 'Reset link is invalid or has expired.' });
    const pu = rows[0];

    await pool.execute('UPDATE portal_users SET password_hash=?, reset_token=NULL, reset_expires_at=NULL WHERE id=?', [hashPassword(password), pu.id]);
    await logEvent(pool, { employee_name: pu.name, department: pu.department, role: pu.role, event: 'password_reset', detail: 'Password reset via forgot password flow' });
    res.json({ success: true, message: 'Password reset successful. You can now log in.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
