const express = require('express');
const router  = express.Router();
const { getDB, hashPassword, verifyPassword, generateToken } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { allowsMultipleSessions } = require('../services/tenant');

// POST /api/login/unified — single entry point for all roles
router.post('/login/unified', async (req, res, next) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const pool = await getDB();

    // 1. Try portal users (employee / team-lead / sys-admin)
    const [rows] = await pool.execute(
      "SELECT * FROM portal_users WHERE LOWER(email) = LOWER(?) AND status = 'active'",
      [email]
    );
    if (rows.length > 0) {
      const pu = rows[0];
      const { ok, needsRehash } = verifyPassword(password, pu.password_hash);
      if (ok) {
        // Silent upgrade legacy SHA-256 → bcrypt on successful login.
        if (needsRehash) {
          try { await pool.execute('UPDATE portal_users SET password_hash = ? WHERE id = ?', [hashPassword(password), pu.id]); }
          catch (e) { console.error('Password rehash failed:', e.message); }
        }
        const portalRole = pu.portal_role || 'employee';
        const token      = generateToken();
        const expiresAt  = new Date(Date.now() + 8 * 60 * 60 * 1000);
        // Single active session per user, unless the tenant allows multiple
        // (e.g. qa-starter) — then keep prior sessions alive.
        if (!allowsMultipleSessions(req.tenant)) {
          await pool.execute('DELETE FROM portal_sessions WHERE portal_user_id = ?', [pu.id]);
        }
        await pool.execute('INSERT INTO portal_sessions (portal_user_id, token, expires_at) VALUES (?, ?, ?)', [pu.id, token, expiresAt]);
        return res.json({
          token, expires_at: expiresAt,
          role: portalRole,
          employee: { id: pu.id, name: pu.name, email: pu.email, role: pu.role, department: pu.department, portal_role: portalRole },
        });
      }
    }

    // 2. Fall back to legacy env-var admin (username match)
    const envUser = (process.env.ADMIN_USERNAME || 'admin').trim();
    const envPass = (process.env.ADMIN_PASSWORD || 'admin123').trim();
    if (email === envUser && password === envPass) {
      const token     = generateToken();
      const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
      await pool.execute('INSERT INTO admin_sessions (admin_id, token, expires_at) VALUES (1, ?, ?)', [token, expiresAt]);
      return res.json({ token, username: envUser, expires_at: expiresAt, role: 'admin' });
    }

    return res.status(401).json({ error: 'Invalid email or password, or account not yet activated.' });
  } catch (e) { next(e); }
});

// POST /api/login
router.post('/login', async (req, res, next) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  try {
    const envUser = (process.env.ADMIN_USERNAME || 'admin').trim();
    const envPass = (process.env.ADMIN_PASSWORD || 'admin123').trim();
    if (username !== envUser || password !== envPass) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    const pool = await getDB();
    const token = generateToken();
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
    await pool.execute(
      'INSERT INTO admin_sessions (admin_id, token, expires_at) VALUES (1, ?, ?)',
      [token, expiresAt]
    );
    res.json({ token, username: envUser, expires_at: expiresAt, role: 'admin' });
  } catch (e) { next(e); }
});

// POST /api/logout
router.post('/logout', async (req, res) => {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (token) {
    try { const pool = await getDB(); await pool.execute('DELETE FROM admin_sessions WHERE token = ?', [token]); } catch (_) {}
  }
  res.json({ success: true });
});

// GET /api/me
router.get('/me', requireAdmin, async (req, res, next) => {
  try {
    const pool = await getDB();
    const [rows] = await pool.execute('SELECT id, username, created_at FROM admins WHERE id = ?', [req.adminId]);
    res.json(rows[0]);
  } catch (e) { next(e); }
});

module.exports = router;
