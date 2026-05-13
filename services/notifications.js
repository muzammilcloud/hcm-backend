const { sendSlackDM, getSlackUserIdByEmail } = require('./slack');

const FE_BASE_URL = process.env.FRONTEND_URL?.split(',')[0] || 'https://app.tickin.pro';

// ── Slack DM helpers ─────────────────────────────────────────────────────────
async function dmUser(pool, portalUserId, text, blocks = null) {
  try {
    const [rows] = await pool.execute(
      'SELECT email, slack_user_id FROM portal_users WHERE id=?',
      [portalUserId]
    );
    if (!rows[0]) return false;
    let slackId = rows[0].slack_user_id;
    if (!slackId && rows[0].email) {
      slackId = await getSlackUserIdByEmail(rows[0].email);
      if (slackId) await pool.execute('UPDATE portal_users SET slack_user_id=? WHERE id=?', [slackId, portalUserId]);
    }
    if (slackId) return await sendSlackDM(slackId, text, blocks);
    return false;
  } catch (_) { return false; }
}

async function dmRoleInDept(pool, department, portalRole, text, blocks = null) {
  try {
    const [users] = await pool.execute(
      "SELECT id FROM portal_users WHERE department=? AND portal_role=? AND status='active'",
      [department, portalRole]
    );
    for (const u of users) await dmUser(pool, u.id, text, blocks);
    return users.map(u => u.id);
  } catch (_) { return []; }
}

async function dmAllSysAdmins(pool, text, blocks = null) {
  try {
    const [users] = await pool.execute(
      "SELECT id FROM portal_users WHERE portal_role='sys-admin' AND status='active'"
    );
    for (const u of users) await dmUser(pool, u.id, text, blocks);
    return users.map(u => u.id);
  } catch (_) { return []; }
}

// Find the team lead of a given portal user, return the TL's portal_user_id (or null)
async function getTeamLeadOf(pool, portalUserId) {
  try {
    const [rows] = await pool.execute(
      `SELECT tl_pu.id AS tl_portal_user_id
       FROM portal_users pu
       JOIN employees e        ON pu.employee_id = e.id
       JOIN employees tl_emp   ON e.reports_to = tl_emp.id
       JOIN portal_users tl_pu ON tl_pu.employee_id = tl_emp.id
       WHERE pu.id = ? AND tl_pu.status = 'active'
       LIMIT 1`,
      [portalUserId]
    );
    return rows[0]?.tl_portal_user_id || null;
  } catch (_) { return null; }
}

// ── In-app notifications ─────────────────────────────────────────────────────
//
// notify(pool, { recipient_user_id, type, title, body, link, slackText, slackBlocks, sendSlack })
//   - recipient_user_id: portal_users.id
//   - type: short string e.g. 'leave_submitted', 'leave_approved'
//   - title: short headline shown in the bell dropdown
//   - body:  one-line detail (optional)
//   - link:  relative path inside FE, e.g. '/leaves?request=42'
//   - sendSlack: bool, default true. Set false to only create the in-app notification.
async function notify(pool, opts) {
  const {
    recipient_user_id, type, title,
    body = null, link = null,
    slackText = null, slackBlocks = null,
    sendSlack = true,
  } = opts;
  if (!recipient_user_id || !type || !title) return;

  // 1. Insert notification row
  try {
    await pool.execute(
      `INSERT INTO notifications (recipient_user_id, type, title, body, link)
       VALUES (?,?,?,?,?)`,
      [recipient_user_id, type, title, body, link]
    );
  } catch (e) { console.error('notify: insert failed', e.message); }

  // 2. Send Slack DM with a "View in Dashboard" link button
  if (sendSlack) {
    const text   = slackText || `${title}${body ? `\n${body}` : ''}`;
    const blocks = [];

    if (slackBlocks) blocks.push(...slackBlocks);
    else blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });

    if (link) {
      blocks.push({
        type: 'actions',
        elements: [{
          type: 'button',
          text: { type: 'plain_text', text: 'Open in Dashboard', emoji: true },
          url:  FE_BASE_URL.replace(/\/$/, '') + link,
          style: 'primary',
        }],
      });
    }

    await dmUser(pool, recipient_user_id, text, blocks);
  }
}

module.exports = {
  dmUser,
  dmRoleInDept,
  dmAllSysAdmins,
  getTeamLeadOf,
  notify,
  FE_BASE_URL,
};
