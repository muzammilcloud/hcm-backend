// LINE WORKS webhook — the LINE equivalent of routes/slack.js.
//
// Multi-tenant by design: each tenant points their bot's callback at
//   POST /api/lineworks/callback/<slug>
// so we resolve the workspace from the URL (not from a shared team_id), verify
// the HMAC signature with that tenant's bot secret, then run the same
// clock-in/out/break/status flows against that tenant's database.
//
// Commands match Slack but without the leading slash — the user types (or taps
// a Rich Menu button) `clockin`, `clockout`, `break`, `status`. Japanese
// aliases (出勤 / 退勤 / 休憩 / 状況) are accepted for the JP market.

const express = require('express');
const router  = express.Router();
const { getTenantDB } = require('../db');
const { getTenantBySlug } = require('../services/tenant');
const { getIntegrationConfig } = require('../services/integrations');
const lw = require('../services/lineworks');

const nowSec = () => Math.floor(Date.now() / 1000);

// Map a typed message to a canonical command.
const COMMANDS = {
  clockin: 'clockin', 'clock in': 'clockin', in: 'clockin', 出勤: 'clockin',
  clockout: 'clockout', 'clock out': 'clockout', out: 'clockout', 退勤: 'clockout',
  break: 'break', 休憩: 'break',
  status: 'status', clockstatus: 'status', 状況: 'status', ステータス: 'status',
  help: 'help', ヘルプ: 'help',
};

const fmtDur = (ms) => {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

const HELP = 'Commands: *clockin* / *clockout* / *break* / *status*. ' +
             '(日本語: 出勤 / 退勤 / 休憩 / 状況)';

// ── Clock operations (tenant pool passed explicitly) ─────────────────────────
async function doClockIn(pool, emp) {
  const [active] = await pool.execute(
    'SELECT clock_in FROM portal_time_entries WHERE portal_user_id=? AND clock_out IS NULL', [emp.id]);
  if (active.length) {
    return `You're already clocked in since ${new Date(active[0].clock_in).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Type *clockout* when you're done.`;
  }
  await pool.execute(
    'INSERT INTO portal_time_entries (portal_user_id, clock_in, notes) VALUES (?, NOW(), ?)',
    [emp.id, 'Via LINE WORKS']);
  return null; // success → caller announces + replies
}

async function doClockOut(pool, emp) {
  const [active] = await pool.execute(
    'SELECT * FROM portal_time_entries WHERE portal_user_id=? AND clock_out IS NULL', [emp.id]);
  if (!active.length) return { error: `You're not clocked in. Type *clockin* to start.` };

  const entry = active[0];
  // Auto-close any open break so a leftover break never runs forever.
  await pool.execute(
    `UPDATE portal_breaks SET break_end = NOW(),
        duration_seconds = TIMESTAMPDIFF(SECOND, break_start, NOW())
      WHERE time_entry_id = ? AND break_end IS NULL`, [entry.id]);
  await pool.execute('UPDATE portal_time_entries SET clock_out=NOW() WHERE id=?', [entry.id]);

  const [b] = await pool.execute(
    'SELECT COALESCE(SUM(duration_seconds),0) AS total FROM portal_breaks WHERE time_entry_id=?', [entry.id]);
  const breakSec = Number(b[0].total || 0);
  const grossMs  = Date.now() - new Date(entry.clock_in).getTime();
  const netMs    = Math.max(0, grossMs - breakSec * 1000);
  return { netMs, breakSec };
}

async function doBreakToggle(pool, emp) {
  const [active] = await pool.execute(
    'SELECT id FROM portal_time_entries WHERE portal_user_id=? AND clock_out IS NULL', [emp.id]);
  if (!active.length) return { error: 'You need to be clocked in to take a break. Type *clockin* first.' };
  const [open] = await pool.execute(
    'SELECT id FROM portal_breaks WHERE time_entry_id=? AND break_end IS NULL ORDER BY break_start DESC LIMIT 1',
    [active[0].id]);
  if (open.length) {
    await pool.execute(
      `UPDATE portal_breaks SET break_end=NOW(), duration_seconds=TIMESTAMPDIFF(SECOND, break_start, NOW()) WHERE id=?`,
      [open[0].id]);
    return { onBreak: false };
  }
  await pool.execute(
    `INSERT INTO portal_breaks (portal_user_id, time_entry_id, break_start, source) VALUES (?, ?, NOW(), 'lineworks')`,
    [emp.id, active[0].id]);
  return { onBreak: true };
}

async function doStatus(pool, emp) {
  const [active] = await pool.execute(
    'SELECT * FROM portal_time_entries WHERE portal_user_id=? AND clock_out IS NULL', [emp.id]);
  if (!active.length) return `You're off the clock. Type *clockin* to start your day.`;
  const entry = active[0];
  const [open] = await pool.execute(
    'SELECT break_start FROM portal_breaks WHERE time_entry_id=? AND break_end IS NULL LIMIT 1', [entry.id]);
  const [b] = await pool.execute(
    `SELECT COALESCE(SUM(CASE WHEN break_end IS NULL THEN TIMESTAMPDIFF(SECOND, break_start, NOW()) ELSE duration_seconds END),0) AS total
       FROM portal_breaks WHERE time_entry_id=?`, [entry.id]);
  const breakSec = Number(b[0].total || 0);
  const netMs = Math.max(0, (Date.now() - new Date(entry.clock_in).getTime()) - breakSec * 1000);
  const state = open.length ? '☕ On break' : '🟢 Clocked in';
  return `${state} — net worked *${fmtDur(netMs)}* today${breakSec > 0 ? ` (break ${fmtDur(breakSec * 1000)})` : ''}.`;
}

// ── Webhook ──────────────────────────────────────────────────────────────────
router.post('/lineworks/callback/:slug', async (req, res) => {
  // Acknowledge fast; process after.
  res.status(200).end();

  try {
    const tenant = await getTenantBySlug(req.params.slug);
    if (!tenant || tenant.status !== 'active') return;
    const pool = getTenantDB(tenant.db_name);

    // Load + verify this tenant's LINE WORKS config.
    let cfg;
    await require('../db').tenantContext.run({ dbName: tenant.db_name, slug: tenant.slug, tenantId: tenant.id }, async () => {
      cfg = await getIntegrationConfig('lineworks');
    });
    if (!cfg) return; // not configured / disabled
    const signature = req.headers['x-works-signature'];
    if (!lw.verifySignature(req.rawBody, signature, cfg.bot_secret)) {
      console.warn('[lineworks] bad signature for', tenant.slug);
      return;
    }

    const ev = req.body || {};
    const userId = ev.source?.userId;
    if (!userId) return;

    // Resolve the employee once; surface a friendly error if unlinked.
    let emp;
    try { emp = await lw.getEmployeeByLineWorksId(cfg, userId, pool, nowSec()); }
    catch (e) { await lw.pushToUser(cfg, userId, lw.textContent(e.message), nowSec()).catch(() => {}); return; }

    // Only text messages drive commands (postbacks reserved for future buttons).
    if (ev.type !== 'message' || ev.content?.type !== 'text') return;
    const raw = String(ev.content.text || '').trim().toLowerCase();
    const cmd = COMMANDS[raw];

    if (cmd === 'clockin') {
      const err = await doClockIn(pool, emp);
      if (err) return lw.pushToUser(cfg, userId, lw.textContent(err), nowSec());
      const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      await lw.pushToUser(cfg, userId, lw.textContent(`✅ Clocked in at ${t}. Have a great day! Type *break* anytime.`), nowSec());
      await lw.announce(cfg, `*${emp.name}* (${emp.department}) clocked in at ${t}.`, nowSec());
      return;
    }
    if (cmd === 'clockout') {
      const r = await doClockOut(pool, emp);
      if (r.error) return lw.pushToUser(cfg, userId, lw.textContent(r.error), nowSec());
      const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const brk = r.breakSec > 0 ? ` (break ${fmtDur(r.breakSec * 1000)})` : '';
      await lw.pushToUser(cfg, userId, lw.textContent(`👋 Clocked out at ${t} — worked *${fmtDur(r.netMs)}*${brk}.`), nowSec());
      await lw.announce(cfg, `*${emp.name}* (${emp.department}) clocked out at ${t} — worked *${fmtDur(r.netMs)}*${brk}.`, nowSec());
      return;
    }
    if (cmd === 'break') {
      const r = await doBreakToggle(pool, emp);
      if (r.error) return lw.pushToUser(cfg, userId, lw.textContent(r.error), nowSec());
      await lw.pushToUser(cfg, userId, lw.textContent(r.onBreak
        ? '☕ Break started — your work timer is paused. Type *break* again when you\'re back.'
        : '✅ Break ended — welcome back. Work timer resumed.'), nowSec());
      return;
    }
    if (cmd === 'status') {
      return lw.pushToUser(cfg, userId, lw.textContent(await doStatus(pool, emp)), nowSec());
    }
    // help / unknown
    await lw.pushToUser(cfg, userId, lw.textContent(HELP), nowSec());
  } catch (e) {
    console.error('[lineworks] callback error:', e.message);
  }
});

module.exports = router;
