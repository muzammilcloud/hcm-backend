const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');
const router  = express.Router({ mergeParams: true });
const { getDB, logEvent, tenantContext } = require('../db');
const { getBusinessConfig } = require('../config/business');
const { getTenantBySlug } = require('../services/tenant');
const {
  getEmployeeBySlackId,
  postToSlack,
  fmtTimeInZone,
  getSlackUserTz,
} = require('../services/slack');
const { notify } = require('../services/notifications');
const { recordAuditActor } = require('../services/audit');
const { getIntegrationConfig } = require('../services/integrations');

const LEAVE_LINK = id => `/leaves?request=${id}`;

// Verify Slack's request signature (HMAC-SHA256 over `v0:timestamp:rawBody`,
// keyed with the tenant's Signing Secret). Fails OPEN when we genuinely can't
// verify — no signature header, no captured raw body, or no signing secret
// configured — so it never blocks a tenant mid-setup. It rejects only a request
// that DID present a signature we can check and it didn't match (or is stale).
// Must run inside tenant context so getIntegrationConfig('slack') resolves.
async function slackSignatureOk(req) {
  const sig = req.headers['x-slack-signature'];
  const ts  = req.headers['x-slack-request-timestamp'];
  const raw = req.rawBody;
  if (!sig || !ts || !raw) return true;                 // can't verify → allow
  let secret;
  try { secret = (await getIntegrationConfig('slack'))?.signing_secret; } catch (_) {}
  if (!secret) return true;                             // not configured → allow
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // replay guard
  const expected = 'v0=' + crypto.createHmac('sha256', secret)
    .update(`v0:${ts}:${raw.toString('utf8')}`).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig)); }
  catch (_) { return false; }
}

// Slack slash commands all hit a shared host (api.tickin.pro) with no tenant
// subdomain, so the tenant is carried in the URL: /api/slack/<slug>/<command>
// (mirrors the LINE WORKS webhook). Resolve it here and run the handler inside
// the tenant context, so getDB() and the per-tenant Slack credentials resolve.
// Without this, requests fall back to the empty platform Slack config and fail
// with "SLACK_BOT_TOKEN not configured".
router.use(async (req, res, next) => {
  let tenant;
  try { tenant = await getTenantBySlug(req.params.slug); } catch (_) {}
  if (!tenant || tenant.status === 'deleted') {
    if (req.body && req.body.response_url) {
      axios.post(req.body.response_url, {
        response_type: 'ephemeral',
        text: `Tickin workspace "${req.params.slug || ''}" wasn't found. Check the Request URL in your Slack app — it should be https://api.tickin.pro/api/slack/<your-workspace>/<command>.`,
      }).catch(() => {});
    }
    return res.status(200).end();
  }
  tenantContext.run({ dbName: tenant.db_name, slug: tenant.slug, tenantId: tenant.id }, async () => {
    try {
      if (!(await slackSignatureOk(req))) return res.status(401).send('Invalid Slack signature');
    } catch (_) { /* never block on a verification error */ }
    next();
  });
});

// POST /clockin — triggered by /clockin in Slack
router.post('/clockin', async (req, res) => {
  const { user_id } = req.body;

  // Respond immediately (Slack requires < 3s)
  res.status(200).end();

  try {
    const pool = await getDB();
    const emp  = await getEmployeeBySlackId(user_id, pool);

    // Check already clocked in
    const [active] = await pool.execute(
      'SELECT * FROM portal_time_entries WHERE portal_user_id=? AND clock_out IS NULL',
      [emp.id]
    );
    if (active.length > 0) {
      const clockInTimestamp = Math.floor(new Date(active[0].clock_in).getTime() / 1000);
      await axios.post(req.body.response_url, {
        response_type: 'ephemeral',
        text: `You're already clocked in since <!date^${clockInTimestamp}^{time}|${new Date(active[0].clock_in).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}>. Use */clockout* when you're done.`,
      });
      return;
    }

    // Clock in
    await pool.execute(
      'INSERT INTO portal_time_entries (portal_user_id, clock_in, notes) VALUES (?, NOW(), ?)',
      [emp.id, 'Via Slack']
    );

    const timestamp = Math.floor(Date.now() / 1000);

    // Announce in #attendance channel
    await postToSlack(`*${emp.name}* (${emp.department}) clocked in at <!date^${timestamp}^{time}|${new Date().toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' })}>`);

  } catch (e) {
    console.error('Slack /clockin error:', e.message);
    if (req.body.response_url) {
      await axios.post(req.body.response_url, {
        response_type: 'ephemeral',
        text: e.message,
      }).catch(() => {});
    }
  }
});

// POST /clockout — triggered by /clockout in Slack
router.post('/clockout', async (req, res) => {
  const { user_id } = req.body;

  // Respond immediately (Slack requires < 3s)
  res.status(200).end();

  try {
    const pool = await getDB();
    const emp  = await getEmployeeBySlackId(user_id, pool);

    // Check not clocked in
    const [active] = await pool.execute(
      'SELECT * FROM portal_time_entries WHERE portal_user_id=? AND clock_out IS NULL',
      [emp.id]
    );
    if (active.length === 0) {
      await axios.post(req.body.response_url, {
        response_type: 'ephemeral',
        text: `You're not clocked in. Use */clockin* to start your session.`,
      });
      return;
    }

    // Auto-close any open break (so leftover breaks don't run forever)
    await pool.execute(
      `UPDATE portal_breaks
         SET break_end = NOW(),
             duration_seconds = TIMESTAMPDIFF(SECOND, break_start, NOW())
       WHERE time_entry_id = ? AND break_end IS NULL`,
      [active[0].id]
    );

    // Clock out
    await pool.execute('UPDATE portal_time_entries SET clock_out=NOW() WHERE id=?', [active[0].id]);

    // Announce in #attendance channel — clock-out time only (no worked/break summary)
    const clockOutTime = new Date();
    const timestampOut = Math.floor(clockOutTime.getTime() / 1000);
    await postToSlack(`*${emp.name}* (${emp.department}) clocked out at <!date^${timestampOut}^{time}|${new Date().toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' })}>`);

  } catch (e) {
    console.error('Slack /clockout error:', e.message);
    if (req.body.response_url) {
      await axios.post(req.body.response_url, {
        response_type: 'ephemeral',
        text: e.message,
      }).catch(() => {});
    }
  }
});

// POST /break — toggles a break (or use 'start' / 'stop' to be explicit).
// Plain /break: if you're working, start a break; if you're on a break, end it.
router.post('/break', async (req, res) => {
  const { user_id, text } = req.body;
  res.status(200).end();

  const sub = String(text || '').trim().toLowerCase();
  const reply = (t) => axios.post(req.body.response_url, { response_type: 'ephemeral', text: t }).catch(() => {});

  if (sub !== '' && sub !== 'start' && sub !== 'stop' && sub !== 'end') {
    return reply(`Usage: */break* to toggle a break, or */break start* / */break stop* to be explicit. Your work timer pauses during the break.`);
  }

  try {
    const pool = await getDB();
    const emp  = await getEmployeeBySlackId(user_id, pool);

    const [active] = await pool.execute(
      'SELECT id, clock_in FROM portal_time_entries WHERE portal_user_id=? AND clock_out IS NULL',
      [emp.id]
    );
    if (active.length === 0) {
      return reply(`You're not clocked in. Use */clockin* to start your session first.`);
    }
    const entryId = active[0].id;

    const [openBreak] = await pool.execute(
      'SELECT id, break_start FROM portal_breaks WHERE time_entry_id=? AND break_end IS NULL ORDER BY break_start DESC LIMIT 1',
      [entryId]
    );
    const onBreak = openBreak.length > 0;

    // Resolve action: plain /break toggles; explicit start/stop overrides.
    const action = sub === '' ? (onBreak ? 'stop' : 'start')
                  : (sub === 'start' ? 'start' : 'stop');

    if (action === 'start') {
      if (onBreak) {
        // Only reachable via explicit /break start while already on break.
        const since   = new Date(openBreak[0].break_start);
        const elapsed = Math.floor((Date.now() - since) / 60000);
        return reply(`You're already on break (started ${elapsed}m ago). Use */break* to end it.`);
      }
      await pool.execute(
        `INSERT INTO portal_breaks (portal_user_id, time_entry_id, break_start, source)
         VALUES (?, ?, NOW(), 'slack')`,
        [emp.id, entryId]
      );
      // Channel message only — no ephemeral self-reply, no emoji.
      await postToSlack(`*${emp.name}* (${emp.department}) started a break. Work timer paused.`);
      return;
    }

    // action === 'stop'
    if (!onBreak) {
      // Only reachable via explicit /break stop with no break running.
      return reply(`You're not on a break right now. Use */break* to take one.`);
    }
    await pool.execute(
      `UPDATE portal_breaks
         SET break_end = NOW(),
             duration_seconds = TIMESTAMPDIFF(SECOND, break_start, NOW())
       WHERE id = ?`,
      [openBreak[0].id]
    );
    // Channel message only — no ephemeral self-reply, no emoji, no duration.
    await postToSlack(`*${emp.name}* (${emp.department}) ended their break. Work timer resumed.`);
    return;

  } catch (e) {
    console.error('Slack /break error:', e.message);
    return reply(`Something went wrong: ${e.message}`);
  }
});

// POST /clockstatus — /clockstatus (ephemeral)
router.post('/clockstatus', async (req, res) => {
  // Respond immediately so Slack doesn't time out
  res.json({ response_type: 'ephemeral', text: 'Checking your status...' });

  try {
    const pool = await getDB();
    const emp  = await getEmployeeBySlackId(req.body.user_id, pool);

    // Use portal_time_entries (same table /clockin and /clockout write to).
    const [active] = await pool.execute(
      'SELECT id, clock_in FROM portal_time_entries WHERE portal_user_id=? AND clock_out IS NULL',
      [emp.id]
    );

    let text;
    if (active.length > 0) {
      const entryId = active[0].id;
      const since   = new Date(active[0].clock_in);
      const grossMs = Date.now() - since;

      // Open break + total break seconds for this entry
      const [openBreak] = await pool.execute(
        'SELECT break_start FROM portal_breaks WHERE time_entry_id=? AND break_end IS NULL ORDER BY break_start DESC LIMIT 1',
        [entryId]
      );
      const [closedBreaks] = await pool.execute(
        'SELECT COALESCE(SUM(duration_seconds), 0) AS total FROM portal_breaks WHERE time_entry_id=? AND break_end IS NOT NULL',
        [entryId]
      );
      const closedSec = Number(closedBreaks[0].total || 0);
      const openSec   = openBreak.length > 0 ? Math.floor((Date.now() - new Date(openBreak[0].break_start)) / 1000) : 0;
      const breakSec  = closedSec + openSec;
      const netMs     = Math.max(0, grossMs - breakSec * 1000);

      const fmt = (ms) => {
        const h = Math.floor(ms / 3600000);
        const m = Math.floor((ms % 3600000) / 60000);
        return h > 0 ? `${h}h ${m}m` : `${m}m`;
      };
      const tz   = await getSlackUserTz(req.body.user_id);
      const time = fmtTimeInZone(since, tz);

      if (openBreak.length > 0) {
        text = `☕ On break since ${Math.floor(openSec / 60)}m ago. Clocked in at *${time}* — *${fmt(netMs)}* worked, *${fmt(breakSec * 1000)}* on break. Use */break stop* to resume.`;
      } else if (breakSec > 0) {
        text = `You're clocked in since *${time}* — *${fmt(netMs)}* worked (took *${fmt(breakSec * 1000)}* in breaks).`;
      } else {
        text = `You're clocked in since *${time}* — *${fmt(netMs)}* so far.`;
      }
    } else {
      text = `You're not clocked in.`;
    }

    await axios.post(req.body.response_url, {
      response_type: 'ephemeral',
      replace_original: true,
      text,
    });

  } catch (e) {
    console.error('Slack /clockstatus error:', e.message);
    if (req.body.response_url) {
      await axios.post(req.body.response_url, {
        response_type: 'ephemeral',
        replace_original: true,
        text: e.message,
      }).catch(() => {});
    }
  }
});

// POST /interactive — Slack button interactions
router.post('/interactive', async (req, res) => {
  // Ack immediately — Slack requires response within 3s
  res.status(200).send();

  let payload;
  try {
    payload = JSON.parse(req.body.payload);
  } catch (e) {
    console.error('❌ Slack interactive: failed to parse payload', e.message);
    return;
  }

  try {
    const actionId = payload.actions?.[0]?.action_id;
    const value    = payload.actions?.[0]?.value;
    const userId   = payload.user?.id;

    const pool = await getDB();

    // ── Leave approve / decline straight from the admin's Slack DM ────────
    if (actionId === 'leave_approve' || actionId === 'leave_decline') {
      const leaveId  = parseInt(value);
      const replace  = (text) => axios.post(payload.response_url, { replace_original: true, text }).catch(() => {});
      const ephemeral = (text) => axios.post(payload.response_url, { replace_original: false, response_type: 'ephemeral', text }).catch(() => {});

      // Only an active sys-admin may finalise from Slack.
      const [actor] = await pool.execute(
        "SELECT id, name, email, portal_role FROM portal_users WHERE slack_user_id=? AND status='active' LIMIT 1",
        [userId]
      );
      if (!actor[0] || actor[0].portal_role !== 'sys-admin') {
        await ephemeral('⚠️ Only an admin can approve or decline leave requests.');
        return;
      }

      const [lrRows] = await pool.execute(
        `SELECT lr.*, pu.name AS employee_name, pu.department, pu.email AS employee_email
           FROM leave_requests lr JOIN portal_users pu ON lr.employee_id = pu.id
          WHERE lr.id=?`, [leaveId]
      );
      const lr = lrRows[0];
      if (!lr) { await replace('This leave request no longer exists.'); return; }
      if (!['pending', 'approved_tl'].includes(lr.status)) {
        await replace(`This request was already handled (status: ${String(lr.status).replace('_', ' ')}).`);
        return;
      }

      const approved    = actionId === 'leave_approve';
      const finalStatus = approved ? 'approved' : 'declined_admin';
      const history = JSON.parse(lr.action_history || '[]');
      history.push({ actor: 'Admin', role: 'admin', action: approved ? 'approved' : 'declined', via: 'slack', note: null, ts: new Date().toISOString() });
      await pool.execute('UPDATE leave_requests SET status=?, action_history=? WHERE id=?', [finalStatus, JSON.stringify(history), leaveId]);

      await logEvent(pool, {
        employee_id: lr.employee_id, employee_name: lr.employee_name, department: lr.department, role: null,
        event: approved ? 'leave_approved' : 'leave_declined_admin',
        detail: `Admin ${approved ? 'approved' : 'declined'} ${lr.leave_type} from ${lr.start_date} to ${lr.end_date} (via Slack)`,
      });

      // Notify the employee — Slack DM + in-app — exactly like the web decision.
      const fmtDate = d => (typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10));
      const summary = `*${lr.leave_type}*  ·  ${fmtDate(lr.start_date)} → ${fmtDate(lr.end_date)}`;
      await notify(pool, {
        recipient_user_id: lr.employee_id,
        type: approved ? 'leave_approved' : 'leave_declined',
        title: approved ? `✅ ${lr.leave_type} approved` : `❌ ${lr.leave_type} declined by Admin`,
        body:  approved ? 'Your leave has been approved.' : 'Your leave was declined.',
        link:  LEAVE_LINK(leaveId),
        slackText: approved
          ? `✅ *${lr.leave_type}* — Your leave request has been *approved* by Admin.`
          : `❌ *${lr.leave_type}* — Your leave request was *declined* by Admin.`,
        slackBlocks: [{ type: 'section', text: { type: 'mrkdwn', text: summary } }],
      });

      await recordAuditActor({
        actorId: actor[0].id, actorEmail: actor[0].email, actorRole: 'sys-admin',
        action: `leave.${approved ? 'approved' : 'declined'}`, target: { type: 'leave_request', id: leaveId },
        after: { status: finalStatus, via: 'slack' },
      });

      // Collapse the admin's message so the buttons can't be clicked twice.
      await replace(`${approved ? '✅ Approved' : '❌ Declined'} — *${lr.leave_type}* for *${lr.employee_name}* (${fmtDate(lr.start_date)} → ${fmtDate(lr.end_date)}). The employee has been notified.`);
      return;
    }

    // ── Team-lead first-stage approve / decline (Growth two-stage flow) ───
    if (actionId === 'leave_tl_approve' || actionId === 'leave_tl_decline') {
      const leaveId   = parseInt(value);
      const replace   = (text) => axios.post(payload.response_url, { replace_original: true, text }).catch(() => {});
      const ephemeral = (text) => axios.post(payload.response_url, { replace_original: false, response_type: 'ephemeral', text }).catch(() => {});
      const fmtDate   = d => (typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10));

      // Resolve the clicking Slack user → their employee record.
      const [clk] = await pool.execute(
        "SELECT id AS portal_user_id, employee_id, name, email FROM portal_users WHERE slack_user_id=? AND status='active' LIMIT 1",
        [userId]
      );
      const clicker = clk[0];

      const [lrRows] = await pool.execute(
        `SELECT lr.*, pu.name AS employee_name, pu.department, pu.email AS employee_email, e.reports_to
           FROM leave_requests lr
           JOIN portal_users pu ON lr.employee_id = pu.id
           JOIN employees e     ON pu.employee_id = e.id
          WHERE lr.id=?`, [leaveId]
      );
      const lr = lrRows[0];
      if (!lr) { await replace('This leave request no longer exists.'); return; }
      if (lr.status !== 'pending_tl') {
        await replace(`This request is no longer awaiting team-lead review (status: ${String(lr.status).replace('_', ' ')}).`);
        return;
      }
      // Only the requester's own team lead may review.
      if (!clicker || !clicker.employee_id || String(lr.reports_to) !== String(clicker.employee_id)) {
        await ephemeral('⚠️ Only this employee’s team lead can review this request.');
        return;
      }

      const approved  = actionId === 'leave_tl_approve';
      const tlName    = clicker.name || 'Team Lead';
      const newStatus = approved ? 'approved_tl' : 'declined_tl';
      const history   = JSON.parse(lr.action_history || '[]');
      history.push({ actor: tlName, role: 'team_lead', action: approved ? 'approve' : 'decline', via: 'slack', note: null, ts: new Date().toISOString() });
      await pool.execute('UPDATE leave_requests SET status=?, action_history=? WHERE id=?', [newStatus, JSON.stringify(history), leaveId]);

      await logEvent(pool, {
        employee_name: lr.employee_name, department: lr.department,
        event: approved ? 'leave_tl_approved' : 'leave_tl_declined',
        detail: `Team lead ${approved ? 'approved → pending admin' : 'declined'} ${lr.leave_type} (${lr.start_date} – ${lr.end_date}) (via Slack)`,
      });

      const summary = `*${lr.leave_type}*  ·  ${fmtDate(lr.start_date)} → ${fmtDate(lr.end_date)}`;
      if (approved) {
        // Forward to all sys-admins for final sign-off — with their own buttons.
        const [admins] = await pool.execute("SELECT id FROM portal_users WHERE portal_role='sys-admin' AND status='active'");
        for (const a of admins) {
          await notify(pool, {
            recipient_user_id: a.id,
            type: 'leave_tl_approved',
            title: `${tlName} approved ${lr.leave_type} for ${lr.employee_name}`,
            body:  `${fmtDate(lr.start_date)} → ${fmtDate(lr.end_date)} · awaiting your final approval`,
            link:  LEAVE_LINK(leaveId),
            slackText: `✅ *${tlName}* approved a *${lr.leave_type}* request from *${lr.employee_name}* — needs your final approval.`,
            slackBlocks: [{ type: 'section', text: { type: 'mrkdwn', text: summary } }],
            actionButtons: [
              { text: 'Approve', action_id: 'leave_approve', value: leaveId, style: 'primary' },
              { text: 'Decline', action_id: 'leave_decline', value: leaveId, style: 'danger' },
            ],
          });
        }
        await replace(`✅ Approved — *${lr.leave_type}* for *${lr.employee_name}* forwarded to the admin for final approval.`);
      } else {
        // Decline ends here — notify the employee.
        await notify(pool, {
          recipient_user_id: lr.employee_id,
          type: 'leave_tl_declined',
          title: `❌ ${lr.leave_type} declined by ${tlName}`,
          body:  `Reviewed by ${tlName}`,
          link:  LEAVE_LINK(leaveId),
          slackText: `❌ *${lr.leave_type}* — Your team lead *${tlName}* declined your request.`,
          slackBlocks: [{ type: 'section', text: { type: 'mrkdwn', text: summary } }],
        });
        await replace(`❌ Declined — *${lr.leave_type}* for *${lr.employee_name}*. The employee has been notified.`);
      }
      await recordAuditActor({
        actorId: clicker.portal_user_id, actorEmail: clicker.email, actorRole: 'team-lead',
        action: `leave.tl_${approved ? 'approved' : 'declined'}`, target: { type: 'leave_request', id: leaveId },
        after: { status: newStatus, via: 'slack' },
      });
      return;
    }

    // ── Attendance adjustment approve / reject from Slack ─────────────────
    if (actionId === 'adj_approve' || actionId === 'adj_reject' ||
        actionId === 'adj_tl_approve' || actionId === 'adj_tl_reject') {
      const adjId     = parseInt(value);
      const isTLstage = actionId.startsWith('adj_tl_');
      const action    = actionId.endsWith('_reject') ? 'reject' : 'approve';
      const replace   = (text) => axios.post(payload.response_url, { replace_original: true, text }).catch(() => {});
      const ephemeral = (text) => axios.post(payload.response_url, { replace_original: false, response_type: 'ephemeral', text }).catch(() => {});

      const [clk] = await pool.execute(
        "SELECT id AS portal_user_id, employee_id, name, email, portal_role, department FROM portal_users WHERE slack_user_id=? AND status='active' LIMIT 1",
        [userId]
      );
      const clicker = clk[0];
      if (!clicker) { await ephemeral('⚠️ We could not match your Slack account to a Tickin user.'); return; }

      // Lazy require avoids a load-time cycle (adjustments → notifications → slack).
      const { applyTeamLeadAdjustmentDecision, applyAdminAdjustmentDecision } = require('./adjustments');

      let result;
      if (isTLstage) {
        if (clicker.portal_role !== 'team-lead') { await ephemeral('⚠️ Only a team lead can review this adjustment.'); return; }
        result = await applyTeamLeadAdjustmentDecision(pool, {
          adjustmentId: adjId, department: clicker.department, action, note: null,
          tlPortalUserId: clicker.portal_user_id, tlName: clicker.name,
          actor: { id: clicker.portal_user_id, email: clicker.email, role: 'team-lead', via: 'slack' },
        });
      } else {
        if (clicker.portal_role !== 'sys-admin') { await ephemeral('⚠️ Only an admin can finalise this adjustment.'); return; }
        result = await applyAdminAdjustmentDecision(pool, {
          adjustmentId: adjId, action, note: null, adminPortalUserId: clicker.portal_user_id,
          actor: { id: clicker.portal_user_id, email: clicker.email, role: 'sys-admin', via: 'slack' },
        });
      }

      if (!result.ok) { await replace(result.error || 'This adjustment is no longer actionable.'); return; }
      const verb = action === 'approve'
        ? (isTLstage ? '✅ Approved → sent to admin' : '✅ Approved')
        : '❌ Rejected';
      await replace(`${verb} — attendance adjustment for *${result.adj.requester_name}*. The employee has been notified.`);
      return;
    }

    const timeEntryId = parseInt(value);

    if (actionId === 'ot_continue') {
      await pool.execute(
        'UPDATE portal_time_entries SET ot_decision = ? WHERE id = ?',
        ['continue', timeEntryId]
      );

      const { daily_hours: dh1 } = await getBusinessConfig(pool);
      await axios.post(payload.response_url, {
        replace_original: true,
        text: `✅ *Overtime Approved*\n\nYou chose to continue working. All time after ${dh1.toFixed(1)} hours will be tracked as overtime.\n\nClock out when you're done!`,
      });

      console.log(`✅ Employee chose to continue working (OT approved) - Entry ${timeEntryId}`);

    } else if (actionId === 'ot_clockout') {
      // Employee chose to clock out at the daily threshold
      const [entry] = await pool.execute(
        'SELECT * FROM portal_time_entries WHERE id = ?',
        [timeEntryId]
      );

      if (entry.length > 0 && !entry[0].clock_out) {
        const { daily_hours: dh, daily_ms } = await getBusinessConfig(pool);
        const clockIn  = new Date(entry[0].clock_in);
        const clockOut = new Date(clockIn.getTime() + daily_ms);

        await pool.execute(
          'UPDATE portal_time_entries SET clock_out = ?, ot_decision = ? WHERE id = ?',
          [clockOut, 'stopped', timeEntryId]
        );

        const [puRows] = await pool.execute(
          'SELECT * FROM portal_users WHERE id = ?',
          [entry[0].portal_user_id]
        );
        const pu = puRows[0];

        await logEvent(pool, {
          employee_id: pu?.employee_id || null,
          employee_name: pu?.name,
          department: pu?.department,
          role: pu?.role,
          event: 'clock_out',
          detail: `Clocked out at ${dh.toFixed(1)}h via OT prompt`
        });

        const tz = await getSlackUserTz(userId);
        const clockOutTimestamp = Math.floor(clockOut.getTime() / 1000);
        await postToSlack(`🔴 *${pu?.name}* (${pu?.department}) clocked out (auto at ${dh.toFixed(1)}h) at <!date^${clockOutTimestamp}^{time}|${fmtTimeInZone(clockOut, tz)}>`);

        await axios.post(payload.response_url, {
          replace_original: true,
          text: `✅ *Clocked Out*\n\nYou've been automatically clocked out after exactly *${dh.toFixed(1)} hours*.\n\nNo overtime recorded. Great work today!`,
        });

        console.log(`✅ Employee clocked out at ${dh.toFixed(1)}h (no OT) - ${pu?.name}`);
      }

    } else if (actionId === 'ot_clockout_yes' || actionId === 'ot_clockout_no') {
      const decision = actionId === 'ot_clockout_yes' ? 'continue' : 'stopped';

      await pool.execute(
        'UPDATE portal_time_entries SET ot_decision = ? WHERE id = ?',
        [decision, timeEntryId]
      );

      if (decision === 'stopped') {
        const [entry] = await pool.execute('SELECT * FROM portal_time_entries WHERE id = ?', [timeEntryId]);
        if (entry.length > 0) {
          const { daily_hours: dh, daily_ms } = await getBusinessConfig(pool);
          const clockIn  = new Date(entry[0].clock_in);
          const clockOut = new Date(clockIn.getTime() + daily_ms);

          await pool.execute('UPDATE portal_time_entries SET clock_out = ? WHERE id = ?', [clockOut, timeEntryId]);

          await axios.post(payload.response_url, {
            replace_original: true,
            text: `✅ Hours capped at *${dh.toFixed(1)}h*. No overtime recorded.`,
          });
        }
      } else {
        await axios.post(payload.response_url, {
          replace_original: true,
          text: `✅ Full hours recorded including overtime.`,
        });
      }
    }

  } catch (e) {
    console.error('❌ Slack interactive error:', e.message);
    // Try to surface the error back to the user in Slack
    if (payload?.response_url) {
      await axios.post(payload.response_url, {
        replace_original: false,
        text: `❌ Something went wrong: ${e.message}`,
      }).catch(() => {});
    }
  }
});

module.exports = router;
