const { getPlatformDB } = require('../db');

// Auth middleware for platform admin routes (hcm-admin app at admin.tickin.pro).
// Reads Bearer token, looks it up in platform_sessions, attaches req.platformAdmin.
async function requirePlatformAdmin(req, res, next) {
  try {
    const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return res.status(401).json({ error: 'Authentication required' });

    const db = getPlatformDB();
    const [rows] = await db.execute(
      `SELECT s.id AS session_id, s.expires_at,
              a.id, a.email, a.name, a.role
       FROM platform_sessions s
       JOIN platform_admins   a ON a.id = s.platform_admin_id
       WHERE s.token = ? LIMIT 1`,
      [token]
    );
    if (!rows.length) return res.status(401).json({ error: 'Invalid session' });

    const row = rows[0];
    if (new Date(row.expires_at) < new Date()) {
      await db.execute('DELETE FROM platform_sessions WHERE id = ?', [row.session_id]);
      return res.status(401).json({ error: 'Session expired' });
    }

    req.platformAdmin = { id: row.id, email: row.email, name: row.name, role: row.role };
    next();
  } catch (e) {
    next(e);
  }
}

module.exports = { requirePlatformAdmin };
