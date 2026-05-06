const express = require('express');
const router  = express.Router();
const { getDB, logEvent } = require('../db');
const { requireTeamLead } = require('../middleware/auth');
const { sendLeaveStatusEmail } = require('../services/email');
const { notify } = require('../services/notifications');
const { OT_THRESHOLD_HOURS } = require('../config/business');

const LEAVE_LINK = id => `/leaves?request=${id}`;

// GET /api/teamlead/me
router.get('/teamlead/me', requireTeamLead, async (req, res) => {
  try {
    const pool = await getDB();
    const [rows] = await pool.execute(
      `SELECT pu.id, pu.name, pu.email, pu.role, pu.department, pu.portal_role,
              e.emp_code, e.id AS employee_db_id
       FROM portal_users pu
       LEFT JOIN employees e ON pu.employee_id = e.id
       WHERE pu.id = ?`,
      [req.portalUserId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/teamlead/team — employees who report to this team lead
router.get('/teamlead/team', requireTeamLead, async (req, res) => {
  try {
    if (!req.teamLeadEmployeeId) return res.json([]);
    const pool = await getDB();
    const [rows] = await pool.execute(
      `SELECT e.id, e.name, e.email, e.role, e.department, e.emp_code, e.join_date AS joining_date,
              pu.id AS portal_user_id, pu.portal_role, pu.status AS hcm_status
       FROM employees e
       LEFT JOIN portal_users pu ON e.id = pu.employee_id
       WHERE e.reports_to = ?
       ORDER BY e.name`,
      [req.teamLeadEmployeeId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/teamlead/team/attendance/live — who's clocked in right now
router.get('/teamlead/team/attendance/live', requireTeamLead, async (req, res) => {
  try {
    if (!req.teamLeadEmployeeId) return res.json([]);
    const pool = await getDB();
    const [rows] = await pool.execute(
      `SELECT pte.id, pte.clock_in, pte.portal_user_id,
              pu.name, pu.role, pu.department,
              e.emp_code,
              TIMESTAMPDIFF(MINUTE, pte.clock_in, NOW()) AS minutes_worked
       FROM portal_time_entries pte
       JOIN portal_users pu ON pte.portal_user_id = pu.id
       JOIN employees e ON pu.employee_id = e.id
       WHERE pte.clock_out IS NULL
         AND e.reports_to = ?
       ORDER BY pte.clock_in`,
      [req.teamLeadEmployeeId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/teamlead/team/time-entries?from=&to=&employee_id=
router.get('/teamlead/team/time-entries', requireTeamLead, async (req, res) => {
  try {
    if (!req.teamLeadEmployeeId) return res.json([]);
    const pool = await getDB();
    const { from, to, employee_id } = req.query;
    let sql = `
      SELECT pte.*, pu.name, pu.role, pu.department, e.emp_code,
             TIMESTAMPDIFF(MINUTE, pte.clock_in, COALESCE(pte.clock_out, NOW())) AS duration_minutes
      FROM portal_time_entries pte
      JOIN portal_users pu ON pte.portal_user_id = pu.id
      JOIN employees e ON pu.employee_id = e.id
      WHERE e.reports_to = ?`;
    const params = [req.teamLeadEmployeeId];
    if (from)        { sql += ' AND DATE(pte.clock_in) >= ?'; params.push(from); }
    if (to)          { sql += ' AND DATE(pte.clock_in) <= ?'; params.push(to); }
    if (employee_id) { sql += ' AND e.id = ?';                params.push(employee_id); }
    sql += ' ORDER BY pte.clock_in DESC LIMIT 200';
    const [rows] = await pool.execute(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/teamlead/team/leave-requests?status=
router.get('/teamlead/team/leave-requests', requireTeamLead, async (req, res) => {
  try {
    if (!req.teamLeadEmployeeId) return res.json([]);
    const pool = await getDB();
    const { status } = req.query;
    // leave_requests.employee_id references portal_users.id
    let sql = `
      SELECT lr.*, pu.name, pu.department, e.emp_code
      FROM leave_requests lr
      JOIN portal_users pu ON lr.employee_id = pu.id
      JOIN employees e ON pu.employee_id = e.id
      WHERE e.reports_to = ?`;
    const params = [req.teamLeadEmployeeId];
    if (status) { sql += ' AND lr.status = ?'; params.push(status); }
    sql += ' ORDER BY lr.created_at DESC LIMIT 200';
    const [rows] = await pool.execute(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/teamlead/team/leave-requests/:id — team lead approve, decline, or request change
router.put('/teamlead/team/leave-requests/:id', requireTeamLead, async (req, res) => {
  const { action, note } = req.body; // action: 'approve' | 'decline' | 'request_change'
  if (!['approve', 'decline', 'request_change'].includes(action)) {
    return res.status(400).json({ error: 'Invalid action. Use approve, decline, or request_change.' });
  }
  if (action === 'request_change' && !note?.trim()) {
    return res.status(400).json({ error: 'A note explaining the required changes is mandatory.' });
  }
  try {
    const pool = await getDB();
    const [rows] = await pool.execute(
      `SELECT lr.*, pu.name AS emp_name, pu.department, pu.email AS emp_email,
              tl.name AS tl_name
       FROM leave_requests lr
       JOIN portal_users pu ON lr.employee_id = pu.id
       JOIN employees e     ON pu.employee_id = e.id
       JOIN employees tl    ON e.reports_to = tl.id
       WHERE lr.id = ? AND e.reports_to = ? AND lr.status = 'pending_tl'`,
      [req.params.id, req.teamLeadEmployeeId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Request not found or not awaiting your approval' });

    const lr = rows[0];
    const tlName = lr.tl_name || 'Team Lead';
    const newStatus = action === 'approve' ? 'approved_tl'
                    : action === 'decline' ? 'declined_tl'
                    : 'changes_requested';

    // Append to action history
    const history = JSON.parse(lr.action_history || '[]');
    history.push({ actor: tlName, role: 'team_lead', action, note: note || null, ts: new Date().toISOString() });

    await pool.execute(
      'UPDATE leave_requests SET status=?, tl_note=?, action_history=? WHERE id=?',
      [newStatus, note || null, JSON.stringify(history), req.params.id]
    );

    const eventLabel = action === 'approve' ? 'leave_tl_approved' : action === 'decline' ? 'leave_tl_declined' : 'leave_tl_changes_requested';
    await logEvent(pool, {
      employee_name: lr.emp_name,
      department: lr.department,
      event: eventLabel,
      detail: `Team lead ${action === 'approve' ? 'approved → pending admin' : action === 'decline' ? 'declined' : 'requested changes for'} ${lr.leave_type} (${lr.start_date} – ${lr.end_date})${note ? ` · ${note}` : ''}`
    });

    // Email employee if declined or changes requested
    if (action === 'decline' || action === 'request_change') {
      await sendLeaveStatusEmail({
        employeeEmail: lr.emp_email, employeeName: lr.emp_name,
        status: 'denied', leaveType: lr.leave_type,
        startDate: lr.start_date, endDate: lr.end_date,
        adminNote: action === 'decline'
          ? `Your request was declined by your team lead.${note ? ' Reason: ' + note : ''}`
          : `Your team lead has requested changes.${note ? ' Note: ' + note : ''} Please cancel this request and resubmit with the required changes.`,
      }).catch(() => {});
    }

    // Slack DM + in-app notification
    const fmtDate = d => (typeof d === 'string' ? d.slice(0,10) : new Date(d).toISOString().slice(0,10));
    const summary = `*${lr.leave_type}*  ·  ${fmtDate(lr.start_date)} → ${fmtDate(lr.end_date)}${note ? `\n*Note:* ${note}` : ''}`;

    if (action === 'approve') {
      // Notify all sys-admins → final approval needed
      const [admins] = await pool.execute(
        "SELECT id FROM portal_users WHERE portal_role='sys-admin' AND status='active'"
      );
      for (const a of admins) {
        await notify(pool, {
          recipient_user_id: a.id,
          type: 'leave_tl_approved',
          title: `${tlName} approved ${lr.leave_type} for ${lr.emp_name}`,
          body:  `${fmtDate(lr.start_date)} → ${fmtDate(lr.end_date)} · awaiting your final approval`,
          link:  LEAVE_LINK(lr.id),
          slackText: `✅ *${tlName}* approved a *${lr.leave_type}* request from *${lr.emp_name}* — needs your final approval.`,
          slackBlocks: [{ type: 'section', text: { type: 'mrkdwn', text: summary } }],
        });
      }
    } else {
      // Notify the employee
      const isDecline = action === 'decline';
      await notify(pool, {
        recipient_user_id: lr.employee_id,
        type: isDecline ? 'leave_tl_declined' : 'leave_tl_changes_requested',
        title: isDecline
          ? `❌ ${lr.leave_type} declined by ${tlName}`
          : `🔄 ${lr.leave_type} — changes requested by ${tlName}`,
        body:  note || `Reviewed by ${tlName}`,
        link:  LEAVE_LINK(lr.id),
        slackText: isDecline
          ? `❌ *${lr.leave_type}* — Your team lead *${tlName}* declined your request.`
          : `🔄 *${lr.leave_type}* — Your team lead *${tlName}* requested changes. Please update and resubmit.`,
        slackBlocks: [{ type: 'section', text: { type: 'mrkdwn', text: summary } }],
      });
    }

    const [updated] = await pool.execute('SELECT * FROM leave_requests WHERE id=?', [req.params.id]);
    res.json(updated[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/teamlead/team/calendar?month=YYYY-MM
router.get('/teamlead/team/calendar', requireTeamLead, async (req, res) => {
  try {
    if (!req.teamLeadEmployeeId) return res.json({ leaves: [], holidays: [] });
    const pool = await getDB();
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const [from, to] = [`${month}-01`, `${month}-31`];

    // leave_requests.employee_id references portal_users.id
    const [leaveRows] = await pool.execute(
      `SELECT lr.*, pu.name, pu.department, e.emp_code
       FROM leave_requests lr
       JOIN portal_users pu ON lr.employee_id = pu.id
       JOIN employees e ON pu.employee_id = e.id
       WHERE e.reports_to = ?
         AND lr.status = 'approved'
         AND lr.start_date <= ? AND lr.end_date >= ?
       ORDER BY lr.start_date`,
      [req.teamLeadEmployeeId, to, from]
    );

    const [holidayRows] = await pool.execute(
      'SELECT * FROM public_holidays WHERE date >= ? AND date <= ? ORDER BY date',
      [from, to]
    );

    res.json({ leaves: leaveRows, holidays: holidayRows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/teamlead/team/leave-quotas?year= — leave balance for each team member
router.get('/teamlead/team/leave-quotas', requireTeamLead, async (req, res) => {
  try {
    if (!req.teamLeadEmployeeId) return res.json([]);
    const pool = await getDB();
    const year = req.query.year || new Date().getFullYear();

    // Get all active portal users who report to this team lead
    const [members] = await pool.execute(
      `SELECT pu.id AS portal_user_id, pu.name, pu.department, e.id AS employee_db_id, e.emp_code
       FROM portal_users pu
       JOIN employees e ON pu.employee_id = e.id
       WHERE e.reports_to = ? AND pu.status = 'active'
       ORDER BY pu.name`,
      [req.teamLeadEmployeeId]
    );

    // Get leave policies
    const [policies] = await pool.execute('SELECT * FROM leave_policies');

    const result = await Promise.all(members.map(async (m) => {
      // Used days per leave type (leave_requests.employee_id = portal_users.id)
      const [used] = await pool.execute(
        `SELECT leave_type,
                SUM(CASE duration WHEN 'full' THEN DATEDIFF(end_date, start_date) + 1 ELSE 0.5 END) AS days_used
         FROM leave_requests
         WHERE employee_id = ? AND status = 'approved' AND YEAR(start_date) = ?
         GROUP BY leave_type`,
        [m.portal_user_id, year]
      );
      const usedMap = Object.fromEntries(used.map(r => [r.leave_type, parseFloat(r.days_used)]));

      // Quota overrides — employee_quota_overrides.employee_id references employees.id
      let overrideMap = {};
      if (m.employee_db_id) {
        const [overrides] = await pool.execute(
          `SELECT leave_type, quota FROM employee_quota_overrides WHERE employee_id = ?`,
          [m.employee_db_id]
        );
        overrideMap = Object.fromEntries(overrides.map(r => [r.leave_type, r.quota]));
      }

      const quotas = policies.map(p => {
        const quota     = overrideMap[p.leave_type] ?? p.days_per_year;
        const used_days = usedMap[p.leave_type] || 0;
        return { leave_type: p.leave_type, quota, used_days, remaining: Math.max(0, quota - used_days) };
      });

      return { ...m, quotas };
    }));

    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/teamlead/team/portal-users — team members with session totals
router.get('/teamlead/team/portal-users', requireTeamLead, async (req, res) => {
  try {
    if (!req.teamLeadEmployeeId) return res.json([]);
    const pool = await getDB();
    const [rows] = await pool.execute(
      `SELECT pu.*,
         e.emp_code, e.name AS linked_employee_name,
         (SELECT COUNT(*) FROM portal_time_entries pte WHERE pte.portal_user_id = pu.id) AS total_sessions,
         (SELECT ROUND(COALESCE(SUM(TIMESTAMPDIFF(SECOND, clock_in, COALESCE(clock_out, clock_in))/3600),0),2)
          FROM portal_time_entries WHERE portal_user_id = pu.id) AS total_hours
       FROM portal_users pu
       JOIN employees e ON pu.employee_id = e.id
       WHERE e.reports_to = ?
       ORDER BY pu.name`,
      [req.teamLeadEmployeeId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/teamlead/team/portal-users/:id/time-entries
router.get('/teamlead/team/portal-users/:id/time-entries', requireTeamLead, async (req, res) => {
  try {
    if (!req.teamLeadEmployeeId) return res.json([]);
    const pool = await getDB();
    const [rows] = await pool.execute(
      `SELECT pte.*, ROUND(TIMESTAMPDIFF(SECOND, pte.clock_in, COALESCE(pte.clock_out, NOW()))/3600, 2) AS hours
       FROM portal_time_entries pte
       JOIN portal_users pu ON pte.portal_user_id = pu.id
       JOIN employees e ON pu.employee_id = e.id
       WHERE pte.portal_user_id = ? AND e.reports_to = ?
       ORDER BY pte.clock_in DESC`,
      [req.params.id, req.teamLeadEmployeeId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/teamlead/team/portal-users/:id/idle-sessions
router.get('/teamlead/team/portal-users/:id/idle-sessions', requireTeamLead, async (req, res) => {
  try {
    if (!req.teamLeadEmployeeId) return res.json([]);
    const pool = await getDB();
    const [rows] = await pool.execute(
      `SELECT ids.*
       FROM idle_sessions ids
       JOIN portal_users pu ON ids.portal_user_id = pu.id
       JOIN employees e ON pu.employee_id = e.id
       WHERE ids.portal_user_id = ? AND e.reports_to = ?
       ORDER BY ids.idle_start DESC`,
      [req.params.id, req.teamLeadEmployeeId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/teamlead/team/logs — activity log scoped to team members
// GET /api/teamlead/team/ot-requests?status=&employee_id=
// Read-only — TL views OT requests for their team. Action stays with admin.
router.get('/teamlead/team/ot-requests', requireTeamLead, async (req, res) => {
  try {
    if (!req.teamLeadEmployeeId) return res.json([]);
    const pool = await getDB();
    const { status, employee_id } = req.query;
    let sql = `
      SELECT otr.id, otr.time_entry_id, otr.employee_id,
             DATE_FORMAT(otr.date, '%Y-%m-%d') AS date,
             otr.total_hours, otr.ot_hours, otr.status, otr.admin_note,
             otr.created_at, otr.updated_at,
             e.name, e.department, e.role, e.emp_code
      FROM ot_requests otr
      JOIN employees e ON otr.employee_id = e.id
      WHERE e.reports_to = ?`;
    const params = [req.teamLeadEmployeeId];
    if (status)      { sql += ' AND otr.status = ?';      params.push(status); }
    if (employee_id) { sql += ' AND otr.employee_id = ?'; params.push(employee_id); }
    sql += ' ORDER BY otr.created_at DESC';
    const [rows] = await pool.execute(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/teamlead/team/reports/overtime?from=&to=&employee_id=
// Derived per-day OT report (mirrors /api/reports/overtime), team-scoped.
router.get('/teamlead/team/reports/overtime', requireTeamLead, async (req, res) => {
  try {
    if (!req.teamLeadEmployeeId) return res.json([]);
    const pool = await getDB();
    const { from, to, employee_id } = req.query;
    let sql = `
      SELECT
        e.id AS employee_id, e.name, e.department, e.role, e.emp_code,
        DATE_FORMAT(te.clock_in, '%Y-%m-%d') AS date,
        ROUND(SUM(TIMESTAMPDIFF(SECOND, te.clock_in, COALESCE(te.clock_out, NOW())) / 3600), 2) AS total_hours,
        ROUND(GREATEST(0, SUM(TIMESTAMPDIFF(SECOND, te.clock_in, COALESCE(te.clock_out, NOW())) / 3600) - ${OT_THRESHOLD_HOURS}), 2) AS ot_hours
      FROM employees e
      JOIN time_entries te ON e.id = te.employee_id
      WHERE te.clock_out IS NOT NULL
        AND e.reports_to = ?`;
    const params = [req.teamLeadEmployeeId];
    if (from)        { sql += ' AND DATE(te.clock_in) >= ?'; params.push(from); }
    if (to)          { sql += ' AND DATE(te.clock_in) <= ?'; params.push(to); }
    if (employee_id) { sql += ' AND e.id = ?';               params.push(employee_id); }
    sql += ` GROUP BY e.id, e.name, e.department, e.role, e.emp_code, DATE_FORMAT(te.clock_in, '%Y-%m-%d')
             HAVING ot_hours > 0
             ORDER BY date DESC, ot_hours DESC`;
    const [rows] = await pool.execute(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/teamlead/team/logs', requireTeamLead, async (req, res) => {
  try {
    if (!req.teamLeadEmployeeId) return res.json([]);
    const pool = await getDB();
    const { event, search } = req.query;
    let sql = `
      SELECT el.*
      FROM employee_logs el
      WHERE el.employee_name IN (
        SELECT e.name FROM employees e WHERE e.reports_to = ?
      )`;
    const params = [req.teamLeadEmployeeId];
    if (event)  { sql += ' AND el.event = ?';                params.push(event); }
    if (search) { sql += ' AND el.employee_name LIKE ?';     params.push(`%${search}%`); }
    sql += ' ORDER BY el.created_at DESC LIMIT 300';
    const [rows] = await pool.execute(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
