const express = require('express');
const router  = express.Router();
const { getDB, generateToken, logEvent } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { sendInviteEmail } = require('../services/email');
const { recordAudit } = require('../services/audit');

// Build the set-password URL for an invite, scoped to the current tenant.
// Without this, sendInviteEmail falls back to process.env.FRONTEND_URL
// (or localhost in dev) — wrong for multi-tenant invites.
const APEX_DOMAIN = (process.env.APEX_DOMAIN || 'tickin.pro').trim();
function tenantInviteUrl(req, token) {
  const slug = req.tenant?.slug;
  if (!slug) return null;   // platform-level call — let email service default
  return `https://${slug}.${APEX_DOMAIN}/set-password?token=${token}`;
}

// GET /api/portal-users
router.get('/portal-users', requireAdmin, async (req, res) => {
  try {
    const pool = await getDB();
    const [rows] = await pool.execute(`
      SELECT pu.*,
        e.emp_code, e.name AS linked_employee_name,
        (SELECT COUNT(*) FROM portal_time_entries pte WHERE pte.portal_user_id = pu.id) as total_sessions,
        (SELECT ROUND(COALESCE(SUM(TIMESTAMPDIFF(SECOND, clock_in, COALESCE(clock_out, clock_in))/3600),0),2)
         FROM portal_time_entries WHERE portal_user_id = pu.id) as total_hours
      FROM portal_users pu
      LEFT JOIN employees e ON pu.employee_id = e.id
      ORDER BY pu.created_at DESC
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/portal-users/:id/time-entries
router.get('/portal-users/:id/time-entries', requireAdmin, async (req, res) => {
  try {
    const pool = await getDB();
    const [rows] = await pool.execute(`
      SELECT *, ROUND(TIMESTAMPDIFF(SECOND, clock_in, COALESCE(clock_out, NOW()))/3600, 2) as hours
      FROM portal_time_entries
      WHERE portal_user_id = ?
      ORDER BY clock_in DESC
    `, [req.params.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/idle-sessions — All idle sessions across all users (with user info)
router.get('/idle-sessions', requireAdmin, async (req, res) => {
  try {
    const pool = await getDB();
    const [rows] = await pool.execute(`
      SELECT ids.*, pu.name, pu.department, pu.email, pu.role
      FROM idle_sessions ids
      JOIN portal_users pu ON ids.portal_user_id = pu.id
      ORDER BY ids.idle_start DESC
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/portal-users/:id/idle-sessions
router.get('/portal-users/:id/idle-sessions', requireAdmin, async (req, res) => {
  try {
    const pool = await getDB();
    const [rows] = await pool.execute(
      'SELECT * FROM idle_sessions WHERE portal_user_id = ? ORDER BY idle_start DESC',
      [req.params.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/portal-users — invite a new portal user
router.post('/portal-users', requireAdmin, async (req, res) => {
  const { name, first_name, last_name, email, department, role, employee_id, portal_role } = req.body;
  const displayName = (first_name && last_name) ? `${first_name} ${last_name}` : (name || '');
  if (!displayName || !email) return res.status(400).json({ error: 'Name and email required' });
  const validPortalRoles = ['employee', 'team-lead', 'sys-admin'];
  const pRole = validPortalRoles.includes(portal_role) ? portal_role : 'employee';
  try {
    const pool = await getDB();

    const inviteToken  = generateToken();
    const inviteExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const [existing] = await pool.execute('SELECT * FROM portal_users WHERE email = ?', [email]);
    let puId;
    if (existing.length > 0) {
      puId = existing[0].id;
      await pool.execute(`
        UPDATE portal_users SET name=?, first_name=?, last_name=?, department=?, role=?, employee_id=?,
          portal_role=?, status='pending', password_hash=NULL, invite_token=?, invite_expires_at=?, revoked_at=NULL
        WHERE id=?
      `, [displayName, first_name||null, last_name||null, department||'General', role||'Employee',
          employee_id||null, pRole, inviteToken, inviteExpiry, puId]);
    } else {
      const [result] = await pool.execute(`
        INSERT INTO portal_users (name, first_name, last_name, email, department, role, employee_id, portal_role, status, invite_token, invite_expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `, [displayName, first_name||null, last_name||null, email, department||'General', role||'Employee',
          employee_id||null, pRole, inviteToken, inviteExpiry]);
      puId = result.insertId;
    }

    // Sync slack_email to the linked employee record
    if (employee_id) {
      await pool.execute(`UPDATE employees SET slack_email = ? WHERE id = ?`, [email, employee_id]);
    }

    const inviteUrl = tenantInviteUrl(req, inviteToken);
    const emailSent = await sendInviteEmail({
      name: displayName, email, inviteToken, inviteUrl,
      companyName: req.tenant?.company_name,
    });
    const [rows] = await pool.execute(`
      SELECT pu.*, e.emp_code FROM portal_users pu
      LEFT JOIN employees e ON pu.employee_id = e.id
      WHERE pu.id = ?
    `, [puId]);
    await logEvent(pool, { employee_name: displayName, department: department||'General', role: role||'Employee', event: 'portal_invited', detail: `Portal invite sent to ${email}` });
    recordAudit(req, {
      action: 'portal_user.invited',
      target: { type: 'portal_user', id: puId },
      after: { email, name: displayName, portal_role: pRole, department: department || 'General' },
    });

    res.json({ ...rows[0], email_sent: emailSent });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/portal-users/:id — update Slack email (live sync to employee record)
router.put('/portal-users/:id', requireAdmin, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const pool = await getDB();
    const [rows] = await pool.execute('SELECT * FROM portal_users WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Portal user not found' });
    const pu = rows[0];

    await pool.execute('UPDATE portal_users SET email = ? WHERE id = ?', [email, req.params.id]);

    // Live sync: update slack_email on linked employee
    if (pu.employee_id) {
      await pool.execute('UPDATE employees SET slack_email = ? WHERE id = ?', [email, pu.employee_id]);
    }

    const [updated] = await pool.execute(`
      SELECT pu.*, e.emp_code FROM portal_users pu
      LEFT JOIN employees e ON pu.employee_id = e.id
      WHERE pu.id = ?
    `, [req.params.id]);
    res.json(updated[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/portal-users/:id/resend
router.post('/portal-users/:id/resend', requireAdmin, async (req, res) => {
  try {
    const pool = await getDB();
    const [rows] = await pool.execute('SELECT * FROM portal_users WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Portal user not found' });
    const pu = rows[0];

    const inviteToken  = generateToken();
    const inviteExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await pool.execute(
      "UPDATE portal_users SET invite_token=?, invite_expires_at=?, status='pending', password_hash=NULL WHERE id=?",
      [inviteToken, inviteExpiry, pu.id]
    );

    const inviteUrl = tenantInviteUrl(req, inviteToken);
    const emailSent = await sendInviteEmail({
      name: pu.name, email: pu.email, inviteToken, inviteUrl,
      companyName: req.tenant?.company_name,
    });
    res.json({ success: true, email_sent: emailSent });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/portal-users/:id — revoke access
router.delete('/portal-users/:id', requireAdmin, async (req, res) => {
  try {
    // Guard: a sys-admin must not revoke their own access. Without this, an
    // admin who's the sole sys-admin on the tenant can lock themselves out
    // permanently. Frontend hides the button; this is the belt-and-braces.
    if (req.portalUserId && Number(req.portalUserId) === Number(req.params.id)) {
      return res.status(400).json({ error: "You can't revoke your own portal access. Ask another admin." });
    }

    const pool = await getDB();
    const [rows] = await pool.execute('SELECT * FROM portal_users WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Portal user not found' });
    const pu = rows[0];

    await pool.execute('DELETE FROM portal_sessions WHERE portal_user_id = ?', [pu.id]);
    await pool.execute(
      "UPDATE portal_users SET status='inactive', password_hash=NULL, revoked_at=NOW() WHERE id=?",
      [pu.id]
    );

    await logEvent(pool, { employee_name: pu.name, department: pu.department, role: pu.role, event: 'portal_revoked', detail: `Portal access revoked for ${pu.email}` });
    recordAudit(req, {
      action: 'portal_user.revoked',
      target: { type: 'portal_user', id: pu.id },
      before: { email: pu.email, portal_role: pu.portal_role, status: pu.status },
      after:  { status: 'inactive' },
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
