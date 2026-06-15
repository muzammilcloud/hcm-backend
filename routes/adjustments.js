const express = require('express');
const router  = express.Router();
const { getDB, logEvent } = require('../db');
const { requireEmployee, requireTeamLead, requireAdmin } = require('../middleware/auth');
const { dmUser, dmRoleInDept, dmAllSysAdmins, notify } = require('../services/notifications');
const { getBusinessConfig } = require('../config/business');
const { tenantHas } = require('../services/features');

const toMySQL = iso => new Date(iso).toISOString().slice(0, 19).replace('T', ' ');

const ADJ_LINK = id => `/adjustments?request=${id}`;

// ── Recalculate OT after time entry is updated ───────────────────────────────
async function recalcOT(pool, entryId, portalUserId) {
  try {
    const [rows] = await pool.execute('SELECT * FROM portal_time_entries WHERE id=?', [entryId]);
    if (!rows[0] || !rows[0].clock_out) return;
    const entry = rows[0];
    const sessionHours = (new Date(entry.clock_out) - new Date(entry.clock_in)) / 3600000;

    const { daily_hours: dailyHours } = await getBusinessConfig(pool);
    if (sessionHours > dailyHours) {
      const otHours = parseFloat((sessionHours - dailyHours).toFixed(2));
      if (otHours > 0) {
        await pool.execute(
          `INSERT INTO ot_requests (time_entry_id, employee_id, date, total_hours, ot_hours, idle_deducted)
           VALUES (?,?,DATE(?),?,?,0)
           ON DUPLICATE KEY UPDATE total_hours=VALUES(total_hours), ot_hours=VALUES(ot_hours), idle_deducted=0`,
          [entryId, portalUserId, entry.clock_in, parseFloat(sessionHours.toFixed(2)), otHours]
        );
      } else {
        await pool.execute('DELETE FROM ot_requests WHERE time_entry_id=?', [entryId]);
      }
    } else {
      await pool.execute('DELETE FROM ot_requests WHERE time_entry_id=?', [entryId]);
    }
  } catch (_) {}
}

// ── Rich Slack block builder ──────────────────────────────────────────────────
function buildRequestBlock(adj, requesterName, action, note) {
  const typeLabel  = adj.type === 'missing' ? 'Missing Attendance' : 'Time Adjustment';
  const dateStr    = adj.requested_date;
  const inStr      = adj.requested_clock_in  ? new Date(adj.requested_clock_in).toLocaleTimeString('en-PK',  { hour: '2-digit', minute: '2-digit' }) : '—';
  const outStr     = adj.requested_clock_out ? new Date(adj.requested_clock_out).toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' }) : '—';

  const statusEmoji = { approved: '✅', rejected: '❌', needs_correction: '🔄', pending_tl: '⏳', pending_admin: '⏳' };
  const emoji = statusEmoji[adj.status] || '📋';

  let text = `${emoji} *Attendance Adjustment — ${typeLabel}*\n*Employee:* ${requesterName} · ${adj.department}\n*Date:* ${dateStr}  |  *In:* ${inStr}  |  *Out:* ${outStr}\n*Reason:* ${adj.reason}`;
  if (action) text += `\n*Action:* ${action}`;
  if (note)   text += `\n*Note:* ${note}`;
  return text;
}

// ════════════════════════════════════════════════════════════════════════════
// EMPLOYEE — submit & list own requests
// ════════════════════════════════════════════════════════════════════════════

// POST /api/employee/attendance-adjustments
router.post('/employee/attendance-adjustments', requireEmployee, async (req, res) => {
  const { type, time_entry_id, requested_date, requested_clock_in, requested_clock_out, reason } = req.body;
  if (!requested_date || !reason) return res.status(400).json({ error: 'Date and reason are required' });
  if (type === 'adjust' && !requested_clock_in) return res.status(400).json({ error: 'Clock-in time required for adjustment' });
  try {
    const pool = await getDB();
    const [puRows] = await pool.execute('SELECT * FROM portal_users WHERE id=?', [req.portalUserId]);
    if (!puRows[0]) return res.status(404).json({ error: 'User not found' });
    const pu = puRows[0];

    // Team leads skip TL review — go straight to pending_admin.
    const isTL = pu.portal_role === 'team-lead' || pu.portal_role === 'sys-admin';

    // Only route through the team-lead stage when the plan includes it AND an
    // active team lead actually exists in the employee's department. On Starter
    // (no team-lead role) or a department with no team lead, send the request
    // straight to the sys-admin so it never gets stranded in pending_tl.
    const planHasTeamLead = tenantHas(req.tenant, 'team_lead_role');
    let deptTLs = [];
    if (planHasTeamLead && !isTL) {
      const [tls] = await pool.execute(
        "SELECT id FROM portal_users WHERE department=? AND portal_role='team-lead' AND status='active'",
        [pu.department]
      );
      deptTLs = tls;
    }
    const routeToTL  = !isTL && planHasTeamLead && deptTLs.length > 0;
    const initStatus = routeToTL ? 'pending_tl' : 'pending_admin';

    const [result] = await pool.execute(
      `INSERT INTO attendance_adjustments
         (portal_user_id, department, type, time_entry_id, requested_date,
          requested_clock_in, requested_clock_out, reason, status)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        req.portalUserId, pu.department, type || 'adjust',
        time_entry_id || null, requested_date,
        requested_clock_in ? toMySQL(requested_clock_in) : null,
        requested_clock_out ? toMySQL(requested_clock_out) : null,
        reason, initStatus,
      ]
    );

    const [adj] = await pool.execute('SELECT * FROM attendance_adjustments WHERE id=?', [result.insertId]);
    const msgText = buildRequestBlock(adj[0], pu.name, null, null);

    if (routeToTL) {
      // Goes through the team-lead stage → notify team leads in their department
      for (const t of deptTLs) {
        await notify(pool, {
          recipient_user_id: t.id,
          type: 'adjustment_submitted',
          title: `Adjustment from ${pu.name}`,
          body:  `${pu.department} · ${requested_date}`,
          link:  ADJ_LINK(adj[0].id),
          slackText: `📋 *New attendance adjustment request from ${pu.name}* (${pu.department}) — needs your review.`,
          slackBlocks: [{ type: 'section', text: { type: 'mrkdwn', text: msgText } }],
        });
      }
    } else {
      // No team-lead stage (own request, Starter plan, or no TL in dept) →
      // notify sys-admins directly; the request is already pending_admin.
      const who = isTL ? `Team Lead ${pu.name}` : pu.name;
      const [admins] = await pool.execute(
        "SELECT id FROM portal_users WHERE portal_role='sys-admin' AND status='active'"
      );
      for (const a of admins) {
        await notify(pool, {
          recipient_user_id: a.id,
          type: 'adjustment_submitted',
          title: `Adjustment from ${pu.name}`,
          body:  `${pu.department} · ${requested_date}`,
          link:  ADJ_LINK(adj[0].id),
          slackText: `📋 *Attendance adjustment request from ${who}* (${pu.department}) — needs your review.`,
          slackBlocks: [{ type: 'section', text: { type: 'mrkdwn', text: msgText } }],
        });
      }
    }

    await logEvent(pool, { employee_name: pu.name, department: pu.department, role: pu.role, event: 'adjustment_requested', detail: `${type === 'missing' ? 'Missing attendance' : 'Time adjustment'} for ${requested_date}` });
    res.json(adj[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/employee/attendance-adjustments
router.get('/employee/attendance-adjustments', requireEmployee, async (req, res) => {
  try {
    const pool = await getDB();
    const [rows] = await pool.execute(
      `SELECT aa.*,
              tl.name AS tl_reviewer_name,
              adm.name AS admin_reviewer_name
       FROM attendance_adjustments aa
       LEFT JOIN portal_users tl  ON aa.tl_reviewed_by    = tl.id
       LEFT JOIN portal_users adm ON aa.admin_reviewed_by = adm.id
       WHERE aa.portal_user_id = ?
       ORDER BY aa.created_at DESC`,
      [req.portalUserId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// TEAM LEAD — view team pending requests + review
// ════════════════════════════════════════════════════════════════════════════

// GET /api/teamlead/attendance-adjustments
router.get('/teamlead/attendance-adjustments', requireTeamLead, async (req, res) => {
  const { status } = req.query;
  try {
    const pool = await getDB();
    let sql = `
      SELECT aa.*, pu.name AS requester_name, pu.email AS requester_email,
             e.emp_code,
             tl.name  AS tl_reviewer_name,
             adm.name AS admin_reviewer_name
      FROM attendance_adjustments aa
      JOIN portal_users pu  ON aa.portal_user_id   = pu.id
      LEFT JOIN employees e ON pu.employee_id       = e.id
      LEFT JOIN portal_users tl  ON aa.tl_reviewed_by    = tl.id
      LEFT JOIN portal_users adm ON aa.admin_reviewed_by = adm.id
      WHERE aa.department = ?
        AND aa.portal_user_id != ?`; // exclude own requests (they skip to admin)
    const params = [req.teamDepartment, req.portalUserId];
    if (status === 'all') { /* no filter — show every request */ }
    else if (status)      { sql += ' AND aa.status = ?'; params.push(status); }
    else                  { sql += " AND aa.status IN ('pending_tl','needs_correction')"; }
    sql += ' ORDER BY aa.created_at DESC';
    const [rows] = await pool.execute(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/teamlead/attendance-adjustments/:id — approve / reject / needs_correction
router.put('/teamlead/attendance-adjustments/:id', requireTeamLead, async (req, res) => {
  const { action, note } = req.body; // action: 'approve' | 'reject' | 'needs_correction'
  if (!['approve', 'reject', 'needs_correction'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
  try {
    const pool = await getDB();
    const [rows] = await pool.execute(
      `SELECT aa.*, pu.name AS requester_name, pu.department
       FROM attendance_adjustments aa
       JOIN portal_users pu ON aa.portal_user_id = pu.id
       WHERE aa.id=? AND aa.department=? AND aa.status IN ('pending_tl','needs_correction')`,
      [req.params.id, req.teamDepartment]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Request not found or not actionable' });
    const adj = rows[0];

    const newStatus = action === 'approve' ? 'pending_admin' : action === 'reject' ? 'rejected' : 'needs_correction';
    await pool.execute(
      `UPDATE attendance_adjustments
       SET status=?, tl_note=?, tl_reviewed_by=?, tl_reviewed_at=NOW(), updated_at=NOW()
       WHERE id=?`,
      [newStatus, note || null, req.portalUserId, adj.id]
    );

    const [tlRows] = await pool.execute('SELECT name FROM portal_users WHERE id=?', [req.portalUserId]);
    const tlName   = tlRows[0]?.name || 'Team Lead';
    const [updated] = await pool.execute('SELECT * FROM attendance_adjustments WHERE id=?', [adj.id]);
    const msgText   = buildRequestBlock(updated[0], adj.requester_name, action.replace('_', ' '), note);

    if (action === 'approve') {
      // Notify sys-admins
      const [admins] = await pool.execute(
        "SELECT id FROM portal_users WHERE portal_role='sys-admin' AND status='active'"
      );
      for (const a of admins) {
        await notify(pool, {
          recipient_user_id: a.id,
          type: 'adjustment_tl_approved',
          title: `${tlName} approved adjustment from ${adj.requester_name}`,
          body:  `${adj.department} · awaiting your final approval`,
          link:  ADJ_LINK(adj.id),
          slackText: `✅ *${tlName}* approved an adjustment request from *${adj.requester_name}* — needs your final approval.`,
          slackBlocks: [{ type: 'section', text: { type: 'mrkdwn', text: msgText } }],
        });
      }
    } else {
      // Notify employee
      const actionLabel = action === 'reject' ? 'Rejected' : 'Needs Correction';
      const emoji       = action === 'reject' ? '❌' : '🔄';
      await notify(pool, {
        recipient_user_id: adj.portal_user_id,
        type: action === 'reject' ? 'adjustment_rejected' : 'adjustment_needs_correction',
        title: `${emoji} Adjustment ${actionLabel} by ${tlName}`,
        body:  note || `Reviewed by ${tlName}`,
        link:  ADJ_LINK(adj.id),
        slackText: `${emoji} ${actionLabel} — Your attendance adjustment request was reviewed by *${tlName}*.`,
        slackBlocks: [{ type: 'section', text: { type: 'mrkdwn', text: msgText } }],
      });
    }

    res.json(updated[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// ADMIN — view all pending_admin + final review
// ════════════════════════════════════════════════════════════════════════════

// GET /api/attendance-adjustments
router.get('/attendance-adjustments', requireAdmin, async (req, res) => {
  const { status } = req.query;
  try {
    const pool = await getDB();
    let sql = `
      SELECT aa.*, pu.name AS requester_name, pu.email AS requester_email,
             e.emp_code,
             tl.name  AS tl_reviewer_name,
             adm.name AS admin_reviewer_name
      FROM attendance_adjustments aa
      JOIN portal_users pu  ON aa.portal_user_id   = pu.id
      LEFT JOIN employees e ON pu.employee_id       = e.id
      LEFT JOIN portal_users tl  ON aa.tl_reviewed_by    = tl.id
      LEFT JOIN portal_users adm ON aa.admin_reviewed_by = adm.id
      WHERE 1=1`;
    const params = [];
    if (status === 'all') { /* no filter — show every request */ }
    else if (status)      { sql += ' AND aa.status = ?'; params.push(status); }
    else                  { sql += " AND aa.status IN ('pending_admin','needs_correction')"; }
    sql += ' ORDER BY aa.created_at DESC';
    const [rows] = await pool.execute(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/attendance-adjustments/:id — final review
router.put('/attendance-adjustments/:id', requireAdmin, async (req, res) => {
  const { action, note } = req.body; // action: 'approve' | 'reject' | 'needs_correction'
  if (!['approve', 'reject', 'needs_correction'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
  try {
    const pool = await getDB();
    const [rows] = await pool.execute(
      `SELECT aa.*, pu.name AS requester_name
       FROM attendance_adjustments aa
       JOIN portal_users pu ON aa.portal_user_id = pu.id
       WHERE aa.id=? AND aa.status IN ('pending_admin','needs_correction')`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Request not found or not actionable' });
    const adj = rows[0];

    const newStatus = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'needs_correction';
    await pool.execute(
      `UPDATE attendance_adjustments
       SET status=?, admin_note=?, admin_reviewed_by=?, admin_reviewed_at=NOW(), updated_at=NOW()
       WHERE id=?`,
      [newStatus, note || null, req.adminId, adj.id]
    );

    // ── On approval: update / create time entry + recalc OT ────────────
    if (action === 'approve') {
      if (adj.type === 'adjust' && adj.time_entry_id) {
        // Update existing entry
        const sets = [];
        const vals = [];
        if (adj.requested_clock_in)  { sets.push('clock_in=?');  vals.push(toMySQL(adj.requested_clock_in)); }
        if (adj.requested_clock_out) { sets.push('clock_out=?'); vals.push(toMySQL(adj.requested_clock_out)); }
        if (sets.length > 0) {
          vals.push(adj.time_entry_id);
          await pool.execute(`UPDATE portal_time_entries SET ${sets.join(',')} WHERE id=?`, vals);
          await recalcOT(pool, adj.time_entry_id, adj.portal_user_id);
        }
      } else if (adj.type === 'missing') {
        // Default the clock-in to the employee's assigned shift start_time (not a
        // hardcoded 09:00) when the request didn't specify one.
        let defaultClockIn = `${adj.requested_date} 09:00:00`;
        try {
          const [pu] = await pool.execute('SELECT department FROM portal_users WHERE id=?', [adj.portal_user_id]);
          const dept = pu[0]?.department || null;
          const [sh] = await pool.execute(
            `SELECT start_time FROM shifts
               WHERE is_active=1 AND ((scope='employee' AND scope_id=?) OR (scope='department' AND scope_id=?))
             ORDER BY (scope='employee') DESC LIMIT 1`,
            [String(adj.portal_user_id), dept]
          );
          if (sh[0]?.start_time) defaultClockIn = `${adj.requested_date} ${sh[0].start_time}`;
        } catch (_) {}

        // Create new entry
        const [ins] = await pool.execute(
          `INSERT INTO portal_time_entries (portal_user_id, clock_in, clock_out, notes)
           VALUES (?,?,?,?)`,
          [
            adj.portal_user_id,
            adj.requested_clock_in  ? toMySQL(adj.requested_clock_in)  : defaultClockIn,
            adj.requested_clock_out ? toMySQL(adj.requested_clock_out) : null,
            'Created via attendance adjustment request',
          ]
        );
        await recalcOT(pool, ins.insertId, adj.portal_user_id);
        // Link time entry to adjustment for audit trail
        await pool.execute('UPDATE attendance_adjustments SET time_entry_id=? WHERE id=?', [ins.insertId, adj.id]);
      }
    }

    const [updated] = await pool.execute('SELECT * FROM attendance_adjustments WHERE id=?', [adj.id]);
    const msgText   = buildRequestBlock(updated[0], adj.requester_name, action.replace('_', ' '), note);

    const labelMap = {
      approve: { txt: 'Approved',         emoji: '✅', type: 'adjustment_approved' },
      reject:  { txt: 'Rejected',         emoji: '❌', type: 'adjustment_rejected' },
      needs_correction: { txt: 'Needs Correction', emoji: '🔄', type: 'adjustment_needs_correction' },
    };
    const lbl = labelMap[action];
    await notify(pool, {
      recipient_user_id: adj.portal_user_id,
      type: lbl.type,
      title: `${lbl.emoji} Adjustment ${lbl.txt} by Admin`,
      body:  note || 'Reviewed by HR/Admin',
      link:  ADJ_LINK(adj.id),
      slackText: `${lbl.emoji} ${lbl.txt} — Your attendance adjustment request has been reviewed by HR/Admin.`,
      slackBlocks: [{ type: 'section', text: { type: 'mrkdwn', text: msgText } }],
    });

    await logEvent(pool, {
      employee_name: adj.requester_name, department: adj.department, role: '',
      event: `adjustment_${newStatus}`, detail: `Attendance adjustment for ${adj.requested_date} — ${newStatus}`
    });

    res.json(updated[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/attendance-adjustments/all — admin full history with filters
router.get('/attendance-adjustments/all', requireAdmin, async (req, res) => {
  const { status, department, from, to } = req.query;
  try {
    const pool = await getDB();
    let sql = `
      SELECT aa.*, pu.name AS requester_name, e.emp_code,
             tl.name  AS tl_reviewer_name,
             adm.name AS admin_reviewer_name
      FROM attendance_adjustments aa
      JOIN portal_users pu  ON aa.portal_user_id   = pu.id
      LEFT JOIN employees e ON pu.employee_id       = e.id
      LEFT JOIN portal_users tl  ON aa.tl_reviewed_by    = tl.id
      LEFT JOIN portal_users adm ON aa.admin_reviewed_by = adm.id
      WHERE 1=1`;
    const params = [];
    if (status)     { sql += ' AND aa.status=?';               params.push(status); }
    if (department) { sql += ' AND aa.department=?';           params.push(department); }
    if (from)       { sql += ' AND aa.requested_date >= ?';    params.push(from); }
    if (to)         { sql += ' AND aa.requested_date <= ?';    params.push(to); }
    sql += ' ORDER BY aa.created_at DESC LIMIT 300';
    const [rows] = await pool.execute(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
