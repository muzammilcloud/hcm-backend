const express = require('express');
const router  = express.Router();
const { getDB, logEvent } = require('../db');
const { requireAdmin, requireEmployee } = require('../middleware/auth');
const { sendLeaveRequestEmail, sendLeaveStatusEmail } = require('../services/email');
const { notify, getTeamLeadOf } = require('../services/notifications');
const { postToSlack } = require('../services/slack');
const { tenantHas } = require('../services/features');
const { getTenantToday, getBusinessConfig, getLeaveYearRange, countLeaveDays, getLeaveCalc } = require('../config/business');

const LEAVE_LINK = id => `/leaves?request=${id}`;

function buildLeaveSlackBlocks(lr, requesterName, department) {
  const fmtDate = d => (typeof d === 'string' ? d.slice(0,10) : new Date(d).toISOString().slice(0,10));
  const text = `📩 *${lr.leave_type} Request*\n*Employee:* ${requesterName} · ${department}\n*Dates:* ${fmtDate(lr.start_date)} → ${fmtDate(lr.end_date)} (${lr.duration})\n*Reason:* ${lr.reason || '—'}`;
  return [{ type: 'section', text: { type: 'mrkdwn', text } }];
}

// Helper: count used leave days within a date range (anniversary-based leave year).
// Counts working days only, excluding public holidays (via countLeaveDays).
async function getUsedLeaveDays(pool, employeeId, leaveType, yearStart = null, yearEnd = null) {
  let q = `SELECT DATE_FORMAT(start_date,'%Y-%m-%d') AS s, DATE_FORMAT(end_date,'%Y-%m-%d') AS e, duration
           FROM leave_requests
           WHERE employee_id=? AND leave_type=? AND status='approved'`;
  const params = [employeeId, leaveType];
  if (yearStart && yearEnd) {
    q += ' AND start_date >= ? AND start_date <= ?';
    params.push(yearStart, yearEnd);
  } else {
    q += ' AND YEAR(start_date) = YEAR(NOW())';
  }
  const [rows] = await pool.execute(q, params);
  const { workingDaySet, holidaySet } = await getLeaveCalc(pool);
  return rows.reduce((sum, r) => sum + countLeaveDays(r.s, r.e, r.duration, workingDaySet, holidaySet), 0);
}

// getLeaveYearRange is shared from config/business.js (used by the balance,
// admin quota, and team-lead quota so all three agree on the anniversary window).

// Helper: determine which leave types an employee is eligible for
function getEligibleLeaveTypes(emp) {
  const eligible = new Set();
  eligible.add('Sick Leave'); // probation and permanent both get Sick Leave

  if (emp.employment_status === 'permanent') {
    eligible.add('Work From Home');
    eligible.add('Unpaid Leave');
    eligible.add('Casual Leave');

    if (emp.join_date) {
      const join = new Date(emp.join_date.toString().slice(0, 10) + 'T00:00:00');
      const yearsOfService = (Date.now() - join.getTime()) / (365.25 * 24 * 3600 * 1000);
      if (yearsOfService >= 1) eligible.add('Annual Leave');
    }

    if (emp.marital_status === 'Married') {
      if (emp.gender === 'Male')   eligible.add('Paternity Leave');
      if (emp.gender === 'Female') eligible.add('Maternity Leave');
    }
  }

  return eligible;
}

// Helper: get effective quota (employee override or global policy)
async function getEffectiveQuota(pool, employeeId, leaveType) {
  // Check for employee-specific override
  const [override] = await pool.execute(
    'SELECT quota FROM employee_quota_overrides WHERE employee_id=? AND leave_type=?',
    [employeeId, leaveType]
  );
  if (override.length > 0) return override[0].quota;

  // Fall back to global policy
  const [policy] = await pool.execute(
    'SELECT annual_quota FROM leave_policies WHERE leave_type=?',
    [leaveType]
  );
  return policy.length > 0 ? policy[0].annual_quota : null;
}

// GET /api/leave-policies
router.get('/leave-policies', requireAdmin, async (req, res) => {
  try {
    const pool = await getDB();
    const [rows] = await pool.execute('SELECT * FROM leave_policies');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/leave-policies/:id
router.put('/leave-policies/:id', requireAdmin, async (req, res) => {
  const { annual_quota, is_unlimited } = req.body;
  try {
    const pool = await getDB();
    await pool.execute('UPDATE leave_policies SET annual_quota=?, is_unlimited=? WHERE id=?',
      [annual_quota || null, is_unlimited ? 1 : 0, req.params.id]);
    const [rows] = await pool.execute('SELECT * FROM leave_policies WHERE id=?', [req.params.id]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/employees/:id/quota-overrides
router.get('/employees/:id/quota-overrides', requireAdmin, async (req, res) => {
  try {
    const pool = await getDB();
    const [rows] = await pool.execute(
      'SELECT * FROM employee_quota_overrides WHERE employee_id=?',
      [req.params.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/employees/:id/quota-override
router.put('/employees/:id/quota-override', requireAdmin, async (req, res) => {
  const { leave_type, quota } = req.body;
  if (!leave_type || quota === undefined) {
    return res.status(400).json({ error: 'leave_type and quota required' });
  }
  try {
    const pool = await getDB();
    await pool.execute(
      'INSERT INTO employee_quota_overrides (employee_id, leave_type, quota) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE quota=?',
      [req.params.id, leave_type, quota, quota]
    );
    const [rows] = await pool.execute(
      'SELECT * FROM employee_quota_overrides WHERE employee_id=? AND leave_type=?',
      [req.params.id, leave_type]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/employees/:id/quota-override/:leaveType
router.delete('/employees/:id/quota-override/:leaveType', requireAdmin, async (req, res) => {
  try {
    const pool = await getDB();
    await pool.execute(
      'DELETE FROM employee_quota_overrides WHERE employee_id=? AND leave_type=?',
      [req.params.id, req.params.leaveType]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/leave-quotas?year= — per-employee leave balances for ALL active staff.
// Mirrors the team-lead /team/leave-quotas shape but spans the whole org so a
// sys admin can see every employee's quota / used / remaining at a glance and
// export it. Dual IDs handled explicitly: leave_requests key off portal_users.id,
// quota overrides off employees.id.
router.get('/leave-quotas', requireAdmin, async (req, res) => {
  try {
    const pool = await getDB();
    const year = req.query.year || new Date().getFullYear();

    const [members] = await pool.execute(
      `SELECT pu.id AS portal_user_id, pu.name, pu.department, e.id AS employee_db_id, e.emp_code, e.join_date
       FROM portal_users pu
       JOIN employees e ON pu.employee_id = e.id
       WHERE pu.status = 'active'
       ORDER BY pu.name`
    );

    const [policies] = await pool.execute('SELECT * FROM leave_policies');
    const quotaTypes = policies.filter(
      p => p.leave_type !== 'Public Holiday' && p.leave_type !== 'Unpaid Leave'
    );

    // Working-day + holiday calendar, loaded once for the whole table.
    const { workingDaySet, holidaySet } = await getLeaveCalc(pool);

    const result = await Promise.all(members.map(async (m) => {
      // Count used days within the employee's anniversary leave-year (matches the
      // employee's own balance), not a calendar year.
      const jd = m.join_date ? m.join_date.toString().slice(0, 10) : null;
      const { start: lyStart, end: lyEnd } = jd
        ? getLeaveYearRange(jd)
        : { start: `${year}-01-01`, end: `${year}-12-31` };
      // Working days only, excluding holidays (consistent with the employee balance).
      const [usedRows] = await pool.execute(
        `SELECT leave_type, DATE_FORMAT(start_date,'%Y-%m-%d') AS s, DATE_FORMAT(end_date,'%Y-%m-%d') AS e, duration
         FROM leave_requests
         WHERE employee_id = ? AND status = 'approved' AND start_date BETWEEN ? AND ?`,
        [m.portal_user_id, lyStart, lyEnd]
      );
      const usedMap = {};
      for (const r of usedRows) {
        usedMap[r.leave_type] = (usedMap[r.leave_type] || 0) + countLeaveDays(r.s, r.e, r.duration, workingDaySet, holidaySet);
      }

      let overrideMap = {};
      if (m.employee_db_id) {
        const [overrides] = await pool.execute(
          `SELECT leave_type, quota FROM employee_quota_overrides WHERE employee_id = ?`,
          [m.employee_db_id]
        );
        overrideMap = Object.fromEntries(overrides.map(r => [r.leave_type, r.quota]));
      }

      const quotas = quotaTypes.map(p => {
        const quota     = p.is_unlimited ? null : (overrideMap[p.leave_type] ?? p.annual_quota);
        const used_days = usedMap[p.leave_type] || 0;
        return {
          leave_type:   p.leave_type,
          is_unlimited: !!p.is_unlimited,
          quota,
          used_days,
          remaining:    p.is_unlimited ? null : Math.max(0, (quota || 0) - used_days),
        };
      });

      return {
        portal_user_id: m.portal_user_id,
        name:           m.name,
        department:     m.department,
        emp_code:       m.emp_code,
        quotas,
      };
    }));

    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/public-holidays (public)
router.get('/public-holidays', async (req, res) => {
  try {
    const pool = await getDB();
    const [rows] = await pool.execute('SELECT * FROM public_holidays ORDER BY date ASC');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/public-holidays
router.post('/public-holidays', requireAdmin, async (req, res) => {
  const { name, date, is_paid } = req.body;
  try {
    const pool = await getDB();
    const [result] = await pool.execute(
      'INSERT INTO public_holidays (name, date, is_paid) VALUES (?,?,?)',
      [name, date, is_paid !== false ? 1 : 0]
    );
    const [rows] = await pool.execute('SELECT * FROM public_holidays WHERE id=?', [result.insertId]);

    // Announce on Slack channel + create in-app notification for every active portal user
    const fmtNice = new Date(date + 'T00:00:00').toLocaleDateString('en-PK', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
    const headline = `🎉 *New Public Holiday Added* — *${name}*\n📅 ${fmtNice}${is_paid !== false ? '  ·  Paid' : '  ·  Unpaid'}`;
    postToSlack(headline, [
      { type: 'section', text: { type: 'mrkdwn', text: headline } },
    ]).catch(() => {});

    // Notify all active portal users (in-app bell, no individual Slack DM since channel covers that)
    const [users] = await pool.execute(
      "SELECT id FROM portal_users WHERE status='active'"
    );
    for (const u of users) {
      await notify(pool, {
        recipient_user_id: u.id,
        type: 'public_holiday_added',
        title: `Public Holiday: ${name}`,
        body:  fmtNice,
        link:  '/calendar',
        sendSlack: false, // channel post already covers Slack
      });
    }

    res.json(rows[0]);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'A holiday already exists on that date' });
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/public-holidays/:id
router.delete('/public-holidays/:id', requireAdmin, async (req, res) => {
  try {
    const pool = await getDB();
    const [rows] = await pool.execute('SELECT date FROM public_holidays WHERE id=?', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Holiday not found' });
    const holidayDate = new Date(rows[0].date + 'T23:59:59');
    if (holidayDate < new Date()) {
      return res.status(403).json({ error: 'Past public holidays are locked and cannot be removed.' });
    }
    await pool.execute('DELETE FROM public_holidays WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/leave-requests — Admin: get all
router.get('/leave-requests', requireAdmin, async (req, res) => {
  const { status, employee_id, date } = req.query;
  try {
    const pool = await getDB();
    let q = `SELECT lr.*, pu.name as employee_name, pu.department, pu.role
             FROM leave_requests lr JOIN portal_users pu ON lr.employee_id = pu.id WHERE 1=1`;
    const params = [];
    if (status)      { q += ' AND lr.status=?'; params.push(status); }
    // No default filter — admin sees all statuses (but buttons are disabled for pending_tl etc)
    if (employee_id) { q += ' AND lr.employee_id=?';                         params.push(employee_id); }
    if (date)        { q += ' AND ? BETWEEN lr.start_date AND lr.end_date';  params.push(date); }
    q += ' ORDER BY lr.created_at DESC';
    const [rows] = await pool.execute(q, params);
    const { workingDaySet, holidaySet } = await getLeaveCalc(pool);
    rows.forEach(r => { r.chargeable_days = countLeaveDays(r.start_date, r.end_date, r.duration, workingDaySet, holidaySet); });
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/leave-requests/:id — Admin: delete
router.delete('/leave-requests/:id', requireAdmin, async (req, res) => {
  try {
    const pool = await getDB();
    const [lr] = await pool.execute('SELECT lr.*, pu.name as employee_name, pu.department FROM leave_requests lr JOIN portal_users pu ON lr.employee_id = pu.id WHERE lr.id=?', [req.params.id]);
    if (lr.length === 0) return res.status(404).json({ error: 'Leave request not found' });

    await pool.execute('DELETE FROM leave_requests WHERE id=?', [req.params.id]);

    const leave = lr[0];
    await logEvent(pool, {
      employee_id: leave.employee_id,
      employee_name: leave.employee_name,
      department: leave.department,
      role: null,
      event: 'leave_deleted',
      detail: `Admin deleted ${leave.leave_type} from ${leave.start_date} to ${leave.end_date} (Status: ${leave.status})`
    });

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/leave-requests — Admin: create on behalf of employee
router.post('/leave-requests', requireAdmin, async (req, res) => {
  const { employee_id, leave_type, start_date, end_date, duration, reason, status } = req.body;
  if (!employee_id || !leave_type || !start_date || !end_date) {
    return res.status(400).json({ error: 'employee_id, leave_type, start_date, and end_date required' });
  }

  try {
    const pool = await getDB();
    const [emp] = await pool.execute('SELECT * FROM employees WHERE id=?', [employee_id]);
    if (emp.length === 0) return res.status(404).json({ error: 'Employee not found' });

    // Check for overlaps
    const [overlap] = await pool.execute(`
      SELECT leave_type, start_date, end_date FROM leave_requests
      WHERE employee_id=? AND status IN ('pending','approved')
      AND start_date <= ? AND end_date >= ?
    `, [employee_id, end_date, start_date]);
    if (overlap.length > 0) {
      return res.status(400).json({
        error: `Cannot add leave. Employee already has ${overlap[0].leave_type} from ${overlap[0].start_date} to ${overlap[0].end_date}.`
      });
    }

    const finalStatus = status || 'approved';
    const [result] = await pool.execute(
      'INSERT INTO leave_requests (employee_id, leave_type, start_date, end_date, duration, reason, status, admin_note) VALUES (?,?,?,?,?,?,?,?)',
      [employee_id, leave_type, start_date, end_date, duration || 'full', reason || null, finalStatus, 'Created by admin']
    );

    await logEvent(pool, {
      employee_id,
      employee_name: emp[0].name,
      department: emp[0].department,
      role: emp[0].role,
      event: 'leave_created',
      detail: `Admin added ${leave_type} from ${start_date} to ${end_date} (Status: ${finalStatus})`
    });

    const [rows] = await pool.execute('SELECT * FROM leave_requests WHERE id=?', [result.insertId]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/leave-requests/:id — Admin: edit
router.patch('/leave-requests/:id', requireAdmin, async (req, res) => {
  const { leave_type, start_date, end_date, duration, reason, status } = req.body;
  try {
    const pool = await getDB();
    const [existing] = await pool.execute('SELECT lr.*, pu.name as employee_name, pu.department FROM leave_requests lr JOIN portal_users pu ON lr.employee_id = pu.id WHERE lr.id=?', [req.params.id]);
    if (existing.length === 0) return res.status(404).json({ error: 'Leave request not found' });

    const old = existing[0];
    const updates = {};
    const changes = [];

    if (leave_type && leave_type !== old.leave_type) { updates.leave_type = leave_type; changes.push(`type: ${old.leave_type} → ${leave_type}`); }
    if (start_date && start_date !== old.start_date) { updates.start_date = start_date; changes.push(`start: ${old.start_date} → ${start_date}`); }
    if (end_date && end_date !== old.end_date) { updates.end_date = end_date; changes.push(`end: ${old.end_date} → ${end_date}`); }
    if (duration && duration !== old.duration) { updates.duration = duration; changes.push(`duration: ${old.duration} → ${duration}`); }
    if (reason !== undefined) updates.reason = reason;
    if (status && status !== old.status) { updates.status = status; changes.push(`status: ${old.status} → ${status}`); }

    if (Object.keys(updates).length === 0) return res.json(old);

    const setClause = Object.keys(updates).map(k => `${k}=?`).join(', ');
    const values = [...Object.values(updates), req.params.id];
    await pool.execute(`UPDATE leave_requests SET ${setClause} WHERE id=?`, values);

    await logEvent(pool, {
      employee_id: old.employee_id,
      employee_name: old.employee_name,
      department: old.department,
      role: null,
      event: 'leave_edited',
      detail: `Admin edited ${old.leave_type}: ${changes.join(', ')}`
    });

    const [rows] = await pool.execute('SELECT * FROM leave_requests WHERE id=?', [req.params.id]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/leave-requests/:id — Admin: approve or deny
router.put('/leave-requests/:id', requireAdmin, async (req, res) => {
  const { status, admin_note } = req.body;
  if (!['approved','denied'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    const pool = await getDB();
    // Admin can only act on requests that have cleared team lead, or direct (no TL) requests
    const [existing] = await pool.execute('SELECT * FROM leave_requests WHERE id=?', [req.params.id]);
    if (!existing[0]) return res.status(404).json({ error: 'Not found' });
    const actionable = ['approved_tl', 'pending']; // approved_tl = TL cleared it; pending = no TL
    if (!actionable.includes(existing[0].status)) {
      return res.status(403).json({ error: 'Action not allowed. Request must be approved by the team lead first (or be a direct request with no team lead).' });
    }

    const finalStatus = status === 'approved' ? 'approved' : 'declined_admin';

    // Append to action history
    const history = JSON.parse(existing[0].action_history || '[]');
    history.push({ actor: 'Admin', role: 'admin', action: status === 'approved' ? 'approved' : 'declined', note: admin_note || null, ts: new Date().toISOString() });

    await pool.execute('UPDATE leave_requests SET status=?, admin_note=?, action_history=? WHERE id=?',
      [finalStatus, admin_note || null, JSON.stringify(history), req.params.id]);

    const [rows] = await pool.execute(`
      SELECT lr.*, pu.name as employee_name, pu.department, pu.email as employee_email
      FROM leave_requests lr JOIN portal_users pu ON lr.employee_id = pu.id WHERE lr.id=?
    `, [req.params.id]);

    if (rows[0]) {
      await logEvent(pool, {
        employee_id: rows[0].employee_id,
        employee_name: rows[0].employee_name,
        department: rows[0].department,
        role: null,
        event: finalStatus === 'approved' ? 'leave_approved' : 'leave_declined_admin',
        detail: `Admin ${finalStatus === 'approved' ? 'approved' : 'declined'} ${rows[0].leave_type} from ${rows[0].start_date} to ${rows[0].end_date}${admin_note ? ` · Note: ${admin_note}` : ''}`
      });

      await sendLeaveStatusEmail({
        employeeEmail: rows[0].employee_email, employeeName: rows[0].employee_name,
        status: finalStatus === 'approved' ? 'approved' : 'denied',
        leaveType: rows[0].leave_type,
        startDate: rows[0].start_date, endDate: rows[0].end_date, adminNote: admin_note,
      });

      // Slack DM + in-app notification to the employee
      const isApproved = finalStatus === 'approved';
      const fmtDate = d => (typeof d === 'string' ? d.slice(0,10) : new Date(d).toISOString().slice(0,10));
      const summary = `*${rows[0].leave_type}*  ·  ${fmtDate(rows[0].start_date)} → ${fmtDate(rows[0].end_date)}${admin_note ? `\n*Note:* ${admin_note}` : ''}`;
      await notify(pool, {
        recipient_user_id: rows[0].employee_id,
        type: isApproved ? 'leave_approved' : 'leave_declined',
        title: isApproved
          ? `✅ ${rows[0].leave_type} approved`
          : `❌ ${rows[0].leave_type} declined by Admin`,
        body:  admin_note || (isApproved ? 'Your leave has been approved.' : 'Your leave was declined.'),
        link:  LEAVE_LINK(rows[0].id),
        slackText: isApproved
          ? `✅ *${rows[0].leave_type}* — Your leave request has been *approved* by Admin.`
          : `❌ *${rows[0].leave_type}* — Your leave request was *declined* by Admin.`,
        slackBlocks: [{ type: 'section', text: { type: 'mrkdwn', text: summary } }],
      });
    }
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/employee/leave-request — Employee: submit
router.post('/employee/leave-request', requireEmployee, async (req, res) => {
  const { leave_type, start_date, end_date, duration, reason } = req.body;
  try {
    const pool = await getDB();

    // Get employee context for eligibility + anniversary-based leave year
    const [empRows] = await pool.execute(`
      SELECT e.join_date, e.employment_status, e.marital_status, e.gender
      FROM portal_users pu
      LEFT JOIN employees e ON pu.employee_id = e.id
      WHERE pu.id = ?
    `, [req.employeeId]);
    const emp = empRows[0] || {};
    const eligibleTypes = getEligibleLeaveTypes(emp);

    if (!eligibleTypes.has(leave_type)) {
      return res.status(403).json({ error: `You are not eligible for ${leave_type} based on your current employment status or profile.` });
    }

    // Sick Leave is reported as it happens — it can only be applied for a PAST
    // date or TODAY, never a future date. (Past ranges ending today are fine;
    // a same-day request is just today.) Dates are 'YYYY-MM-DD', so a lexical
    // compare against the tenant-local date is correct.
    if (leave_type === 'Sick Leave') {
      const today = await getTenantToday(pool);
      if ((start_date && start_date > today) || (end_date && end_date > today)) {
        return res.status(400).json({ error: 'Sick Leave can only be applied for today or a past date — future sick leave is not allowed.' });
      }
    }

    const joinDateStr = emp.join_date ? emp.join_date.toString().slice(0, 10) : null;
    const { start: yearStart, end: yearEnd } = joinDateStr
      ? getLeaveYearRange(joinDateStr)
      : { start: `${new Date().getFullYear()}-01-01`, end: `${new Date().getFullYear()}-12-31` };

    // Check quota for limited leave types. Count working days only (excl. holidays),
    // so a range spanning a weekend/holiday doesn't over-charge the quota.
    const [policies] = await pool.execute('SELECT * FROM leave_policies WHERE leave_type=?', [leave_type]);
    const { workingDaySet: subWD, holidaySet: subHol } = await getLeaveCalc(pool);
    const days = countLeaveDays(start_date, end_date, duration, subWD, subHol);

    if (policies.length > 0 && !policies[0].is_unlimited) {
      const effectiveQuota = await getEffectiveQuota(pool, req.employeeId, leave_type);
      if (effectiveQuota !== null) {
        const used = await getUsedLeaveDays(pool, req.employeeId, leave_type, yearStart, yearEnd);
        if (used + days > effectiveQuota) {
          return res.status(400).json({
            error: `Insufficient ${leave_type} balance. Used: ${used}, Quota: ${effectiveQuota}. Contact admin to request additional quota.`
          });
        }
      }
    }

    // WFH: per-month cap from the configured quota (employee override → policy),
    // not a hardcoded 2. Unlimited policy → no cap.
    if (leave_type === 'Work From Home') {
      const [wfhPolicy] = await pool.execute("SELECT is_unlimited FROM leave_policies WHERE leave_type='Work From Home' LIMIT 1");
      const wfhUnlimited = !!wfhPolicy[0]?.is_unlimited;
      if (!wfhUnlimited) {
        const wfhCap = (await getEffectiveQuota(pool, req.employeeId, 'Work From Home')) ?? 2;
        const [wfhThisMonth] = await pool.execute(`
          SELECT SUM(CASE duration WHEN 'full' THEN DATEDIFF(end_date,start_date)+1 ELSE 0.5 END) as used
          FROM leave_requests
          WHERE employee_id=? AND leave_type='Work From Home' AND status IN ('pending','approved')
          AND YEAR(start_date)=YEAR(?) AND MONTH(start_date)=MONTH(?)
        `, [req.employeeId, start_date, start_date]);
        const wfhUsed = parseFloat(wfhThisMonth[0]?.used || 0);
        if (wfhUsed + days > wfhCap) {
          return res.status(400).json({ error: `WFH limit reached. Max ${wfhCap} day(s) per month. You have used ${wfhUsed} this month.` });
        }
      }
    }

    // Overlap check — include pending_tl so it still blocks duplicate requests
    const [overlap] = await pool.execute(`
      SELECT leave_type, start_date, end_date FROM leave_requests
      WHERE employee_id=? AND status IN ('pending_tl','pending','approved')
      AND start_date <= ? AND end_date >= ?
    `, [req.employeeId, end_date, start_date]);
    if (overlap.length > 0) {
      const existing = overlap[0];
      return res.status(400).json({
        error: `Cannot request ${leave_type}. You already have ${existing.leave_type} from ${existing.start_date} to ${existing.end_date}. Multiple leaves on the same dates are not allowed.`
      });
    }

    // Determine initial status:
    //   - Employee with a TL → pending_tl
    //   - Employee without a TL → pending (direct to admin)
    //   - TL / sys-admin submitting their own → pending (skip TL stage, go to admin)
    // The two-stage (TL → Admin) flow only applies when the plan actually
    // includes the team-lead role. On Starter the team-lead role can't be
    // assigned, so requests must go straight to the admin — otherwise they'd
    // sit in pending_tl forever with no team lead to action them.
    const [reportsRow] = await pool.execute(
      `SELECT e.reports_to, pu.portal_role
       FROM portal_users pu LEFT JOIN employees e ON pu.employee_id = e.id
       WHERE pu.id = ?`,
      [req.employeeId]
    );
    const planHasTeamLead = tenantHas(req.tenant, 'team_lead_role');
    const hasTeamLead    = planHasTeamLead && reportsRow[0]?.reports_to != null;
    const submitterRole  = reportsRow[0]?.portal_role || 'employee';
    const submitterIsTL  = submitterRole === 'team-lead' || submitterRole === 'sys-admin';
    const initialStatus  = (hasTeamLead && !submitterIsTL) ? 'pending_tl' : 'pending';

    const initHistory = JSON.stringify([{ actor: 'Employee', role: 'employee', action: 'submitted', note: reason || null, ts: new Date().toISOString() }]);
    const [result] = await pool.execute(
      'INSERT INTO leave_requests (employee_id, leave_type, start_date, end_date, duration, reason, status, action_history) VALUES (?,?,?,?,?,?,?,?)',
      [req.employeeId, leave_type, start_date, end_date, duration || 'full', reason || null, initialStatus, initHistory]
    );
    const [rows] = await pool.execute('SELECT * FROM leave_requests WHERE id=?', [result.insertId]);

    // Email + Slack + in-app notification — recipients depend on whether the
    // submitter is an employee with a TL, an employee without a TL, or a TL/admin themselves
    const [empData] = await pool.execute(
      'SELECT name, department, portal_role FROM portal_users WHERE id=?',
      [req.employeeId]
    );
    const submitter = empData[0];
    if (submitter) {
      const slackBlocks = buildLeaveSlackBlocks(rows[0], submitter.name, submitter.department);
      const submitterIsTL = submitter.portal_role === 'team-lead' || submitter.portal_role === 'sys-admin';

      if (hasTeamLead && !submitterIsTL) {
        // Regular employee with TL → notify the TL
        const tlId = await getTeamLeadOf(pool, req.employeeId);
        if (tlId) {
          await notify(pool, {
            recipient_user_id: tlId,
            type: 'leave_submitted',
            title: `${submitter.name} requested ${leave_type}`,
            body:  `${start_date} → ${end_date}${reason ? ` · ${reason}` : ''}`,
            link:  LEAVE_LINK(rows[0].id),
            slackText: `📩 *New ${leave_type} request from ${submitter.name}* — needs your review.`,
            slackBlocks,
            // First-stage (team-lead) approve/decline from Slack. Approving
            // forwards it to the admin for final sign-off.
            actionButtons: [
              { text: 'Approve', action_id: 'leave_tl_approve', value: rows[0].id, style: 'primary' },
              { text: 'Decline', action_id: 'leave_tl_decline', value: rows[0].id, style: 'danger' },
            ],
          });
        }
      } else {
        // No TL OR submitter is themselves a TL/admin → notify all sys-admins directly
        const [admins] = await pool.execute(
          "SELECT id FROM portal_users WHERE portal_role='sys-admin' AND status='active'"
        );
        for (const a of admins) {
          await notify(pool, {
            recipient_user_id: a.id,
            type: 'leave_submitted',
            title: `${submitter.name} requested ${leave_type}`,
            body:  `${start_date} → ${end_date}${reason ? ` · ${reason}` : ''}`,
            link:  LEAVE_LINK(rows[0].id),
            slackText: submitterIsTL
              ? `📩 *${leave_type} request from Team Lead ${submitter.name}* — needs your final approval.`
              : `📩 *New ${leave_type} request from ${submitter.name}* — needs your final approval.`,
            slackBlocks,
            // Let the admin approve/decline straight from Slack (handled by
            // /api/slack/<slug>/interactive). The employee is notified on decision.
            actionButtons: [
              { text: 'Approve', action_id: 'leave_approve', value: rows[0].id, style: 'primary' },
              { text: 'Decline', action_id: 'leave_decline', value: rows[0].id, style: 'danger' },
            ],
          });
        }
        // Keep existing email-to-admin behaviour for direct-to-admin requests
        if (!hasTeamLead) {
          await sendLeaveRequestEmail({
            employeeName: submitter.name, department: submitter.department,
            leaveType: leave_type, startDate: start_date, endDate: end_date,
            duration: duration || 'full', reason,
          }).catch(() => {});
        }
      }
    }
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/employee/leave-requests — Employee: own requests
router.get('/employee/leave-requests', requireEmployee, async (req, res) => {
  try {
    const pool = await getDB();
    const [rows] = await pool.execute(
      'SELECT * FROM leave_requests WHERE employee_id=? ORDER BY created_at DESC',
      [req.employeeId]
    );
    const { workingDaySet, holidaySet } = await getLeaveCalc(pool);
    rows.forEach(r => { r.chargeable_days = countLeaveDays(r.start_date, r.end_date, r.duration, workingDaySet, holidaySet); });
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/employee/leave-balance
router.get('/employee/leave-balance', requireEmployee, async (req, res) => {
  try {
    const pool = await getDB();

    // Get employee demographic data for eligibility rules
    const [empRows] = await pool.execute(`
      SELECT e.join_date, e.employment_status, e.marital_status, e.gender
      FROM portal_users pu
      LEFT JOIN employees e ON pu.employee_id = e.id
      WHERE pu.id = ?
    `, [req.employeeId]);
    const emp = empRows[0] || {};

    const eligibleTypes = getEligibleLeaveTypes(emp);
    const joinDateStr = emp.join_date ? emp.join_date.toString().slice(0, 10) : null;
    const { start: yearStart, end: yearEnd } = joinDateStr
      ? getLeaveYearRange(joinDateStr)
      : { start: `${new Date().getFullYear()}-01-01`, end: `${new Date().getFullYear()}-12-31` };

    const [policies] = await pool.execute('SELECT * FROM leave_policies');

    // WFH is a per-month cap, counted in the TENANT's timezone (not server NOW()).
    const tToday = await getTenantToday(pool); // YYYY-MM-DD
    const tYear  = Number(tToday.slice(0, 4));
    const tMonth = Number(tToday.slice(5, 7));

    const balance = await Promise.all(
      policies
        .filter(p => eligibleTypes.has(p.leave_type))
        .map(async (p) => {
          if (p.leave_type === 'Work From Home') {
            const [wfhRows] = await pool.execute(`
              SELECT SUM(CASE duration WHEN 'full' THEN DATEDIFF(end_date,start_date)+1 ELSE 0.5 END) as used
              FROM leave_requests WHERE employee_id=? AND leave_type='Work From Home'
              AND status IN ('pending','approved') AND YEAR(start_date)=? AND MONTH(start_date)=?
            `, [req.employeeId, tYear, tMonth]);
            const used = parseFloat(wfhRows[0]?.used || 0);
            // Honor the configured WFH quota (employee override → policy), not a
            // hardcoded 2. Unlimited policy → no cap.
            const wfhQuota = p.is_unlimited
              ? null
              : ((await getEffectiveQuota(pool, req.employeeId, 'Work From Home')) ?? p.annual_quota ?? 2);
            return { leave_type: p.leave_type, color: p.color, annual_quota: wfhQuota, is_unlimited: !!p.is_unlimited, used, remaining: wfhQuota == null ? null : Math.max(0, wfhQuota - used), is_monthly: true };
          }

          if (p.leave_type === 'Unpaid Leave') {
            const used = await getUsedLeaveDays(pool, req.employeeId, p.leave_type, yearStart, yearEnd);
            return { leave_type: p.leave_type, color: p.color, annual_quota: null, is_unlimited: false, used, remaining: null, is_counter: true };
          }

          if (p.is_unlimited) return { leave_type: p.leave_type, color: p.color, annual_quota: null, is_unlimited: true, used: 0, remaining: null, is_monthly: false };

          const used = await getUsedLeaveDays(pool, req.employeeId, p.leave_type, yearStart, yearEnd);
          const effectiveQuota = await getEffectiveQuota(pool, req.employeeId, p.leave_type);
          return {
            leave_type:   p.leave_type,
            color:        p.color,
            annual_quota: effectiveQuota,
            is_unlimited: p.is_unlimited,
            used,
            remaining:    Math.max(0, (effectiveQuota || 0) - used),
            is_monthly:   false,
          };
        })
    );
    res.json(balance);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/employee/leave-request/:id — Employee: cancel pending
router.delete('/employee/leave-request/:id', requireEmployee, async (req, res) => {
  try {
    const pool = await getDB();
    const [rows] = await pool.execute(
      'SELECT * FROM leave_requests WHERE id=? AND employee_id=? AND status IN ("pending_tl","approved_tl","pending","changes_requested")',
      [req.params.id, req.employeeId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Request not found or already processed' });
    await pool.execute('DELETE FROM leave_requests WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/calendar — Admin calendar
router.get('/calendar', requireAdmin, async (req, res) => {
  const { from, to, employee_id, department } = req.query;
  try {
    const pool = await getDB();

    // Active shifts
    let shiftQ = 'SELECT s.*, e.name as employee_name, e.department FROM shifts s LEFT JOIN employees e ON (s.scope="employee" AND s.scope_id=e.id) WHERE s.is_active=1';
    const sParams = [];
    if (department)  { shiftQ += ' AND (s.scope="department" AND s.scope_id=? OR s.scope="employee" AND e.department=?)'; sParams.push(department, department); }
    if (employee_id) { shiftQ += ' AND (s.scope="employee" AND s.scope_id=? OR s.scope="department")'; sParams.push(employee_id); }
    const [shifts] = await pool.execute(shiftQ, sParams);

    // Leave requests in range — include hr_employee_id (employees.id) for FE matching
    let leaveQ = `SELECT lr.*, pu.name as employee_name, pu.department, pu.employee_id as hr_employee_id
                  FROM leave_requests lr
                  JOIN portal_users pu ON lr.employee_id = pu.id WHERE lr.status="approved"`;
    const lParams = [];
    if (from)        { leaveQ += ' AND lr.end_date >= ?';   lParams.push(from); }
    if (to)          { leaveQ += ' AND lr.start_date <= ?'; lParams.push(to); }
    if (employee_id) { leaveQ += ' AND pu.employee_id = ?'; lParams.push(employee_id); }
    if (department)  { leaveQ += ' AND pu.department = ?';  lParams.push(department); }
    const [leaves] = await pool.execute(leaveQ, lParams);

    // Public holidays
    let holQ = 'SELECT id, name, DATE_FORMAT(date, "%Y-%m-%d") as date, is_paid FROM public_holidays WHERE 1=1';
    const hParams = [];
    if (from) { holQ += ' AND date >= ?'; hParams.push(from); }
    if (to)   { holQ += ' AND date <= ?'; hParams.push(to); }
    const [holidays] = await pool.execute(holQ, hParams);

    // Pending leave requests — include hr_employee_id for FE matching
    let pendQ = `SELECT lr.*, pu.name as employee_name, pu.department, pu.employee_id as hr_employee_id
                 FROM leave_requests lr
                 JOIN portal_users pu ON lr.employee_id = pu.id WHERE lr.status="pending"`;
    const pendParams = [];
    if (from) { pendQ += ' AND lr.end_date >= ?';   pendParams.push(from); }
    if (to)   { pendQ += ' AND lr.start_date <= ?'; pendParams.push(to); }
    const [pending] = await pool.execute(pendQ, pendParams);

    // Time entries: UNION of old Slack entries (time_entries.employee_id = employees.id)
    // and portal entries (portal_time_entries → portal_users.employee_id = employees.id)
    const tDateFrom = from        ? 'AND DATE(clock_in) >= ?' : '';
    const tDateTo   = to          ? 'AND DATE(clock_in) <= ?' : '';
    const tEmpOld   = employee_id ? 'AND employee_id = ?'     : '';
    const tEmpNew   = employee_id ? 'AND pu.employee_id = ?'  : '';
    const tDeptOld  = department  ? 'AND employee_id IN (SELECT id FROM employees WHERE department = ?)' : '';
    const tDeptNew  = department  ? 'AND pu.employee_id IN (SELECT id FROM employees WHERE department = ?)' : '';

    // OT past the tenant's configured daily threshold (not a hardcoded 9).
    const { daily_hours: otThreshold } = await getBusinessConfig(pool);
    const timeQ = `
      SELECT employee_id, DATE(clock_in) as date,
        ROUND(SUM(TIMESTAMPDIFF(SECOND,clock_in,COALESCE(clock_out,NOW()))/3600),2) as total_hours,
        ROUND(GREATEST(0,SUM(TIMESTAMPDIFF(SECOND,clock_in,COALESCE(clock_out,NOW()))/3600)-?),2) as ot_hours,
        MAX(CASE WHEN clock_out IS NULL THEN clock_in ELSE NULL END) as active_clock_in,
        MAX(CASE WHEN clock_out IS NULL THEN 1 ELSE 0 END) as is_active
      FROM (
        SELECT employee_id, clock_in, clock_out FROM time_entries
        WHERE 1=1 ${tDateFrom} ${tDateTo} ${tEmpOld} ${tDeptOld}
        UNION ALL
        SELECT pu.employee_id, pte.clock_in, pte.clock_out
        FROM portal_time_entries pte JOIN portal_users pu ON pte.portal_user_id=pu.id
        WHERE pu.employee_id IS NOT NULL ${tDateFrom} ${tDateTo} ${tEmpNew} ${tDeptNew}
      ) combined
      GROUP BY employee_id, DATE(clock_in)`;

    const tParams = [Number(otThreshold) || 9]; // OT threshold for the SELECT
    if (from)        tParams.push(from);
    if (to)          tParams.push(to);
    if (employee_id) tParams.push(employee_id);
    if (department)  tParams.push(department);
    // same params for portal_time_entries half of the UNION
    if (from)        tParams.push(from);
    if (to)          tParams.push(to);
    if (employee_id) tParams.push(employee_id);
    if (department)  tParams.push(department);

    const [timeEntries] = await pool.execute(timeQ, tParams);

    // Workspace working days (CSV of day keys) so the calendar greys non-working
    // days and computes absences per the real schedule, not a hardcoded Sat/Sun.
    let working_days = 'mon,tue,wed,thu,fri';
    try {
      const [s] = await pool.execute('SELECT working_days FROM tenant_settings WHERE singleton_key = 1 LIMIT 1');
      if (s[0]?.working_days) working_days = s[0].working_days;
    } catch (_) {}

    res.json({ shifts, leaves, holidays, pending, timeEntries, working_days });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/employee/calendar — Employee calendar
router.get('/employee/calendar', requireEmployee, async (req, res) => {
  const { from, to } = req.query;
  try {
    const pool = await getDB();
    const [empRows] = await pool.execute('SELECT * FROM portal_users WHERE id=?', [req.employeeId]);
    const emp = empRows[0];

    // Shifts assigned to this employee or their department
    const [shifts] = await pool.execute(
      'SELECT * FROM shifts WHERE is_active=1 AND ((scope="employee" AND scope_id=?) OR (scope="department" AND scope_id=?))',
      [String(req.employeeId), emp.department]
    );

    // Own leave requests
    let leaveQ = 'SELECT id, employee_id, leave_type, DATE_FORMAT(start_date, "%Y-%m-%d") as start_date, DATE_FORMAT(end_date, "%Y-%m-%d") as end_date, duration, reason, status, admin_note, created_at FROM leave_requests WHERE employee_id=?';
    const lParams = [req.employeeId];
    if (from) { leaveQ += ' AND end_date >= ?';   lParams.push(from); }
    if (to)   { leaveQ += ' AND start_date <= ?'; lParams.push(to); }
    const [leaves] = await pool.execute(leaveQ, lParams);

    // Public holidays
    let holQ = 'SELECT id, name, DATE_FORMAT(date, "%Y-%m-%d") as date, is_paid FROM public_holidays WHERE 1=1';
    const hParams = [];
    if (from) { holQ += ' AND date >= ?'; hParams.push(from); }
    if (to)   { holQ += ' AND date <= ?'; hParams.push(to); }
    const [holidays] = await pool.execute(holQ, hParams);

    // Daily worked hours — from portal_time_entries (portal clock-ins). OT is
    // hours past the tenant's configured daily threshold (NOT a hardcoded 9),
    // matching every other OT path (time.js, reports.js, otReconciliation…).
    const { daily_hours: otThreshold } = await getBusinessConfig(pool);
    const [dailyHours] = await pool.execute(`
      SELECT DATE(clock_in) as date,
        ROUND(SUM(TIMESTAMPDIFF(SECOND,clock_in,COALESCE(clock_out,NOW()))/3600),2) as total_hours,
        ROUND(GREATEST(0, SUM(TIMESTAMPDIFF(SECOND,clock_in,COALESCE(clock_out,NOW()))/3600) - ?), 2) as ot_hours,
        COUNT(*) as sessions
      FROM portal_time_entries WHERE portal_user_id=? AND DATE(clock_in) BETWEEN ? AND ?
      GROUP BY DATE(clock_in)
    `, [Number(otThreshold) || 9, req.employeeId, from || '2000-01-01', to || '2099-12-31']);

    // Tenant working days (CSV of day keys: mon,tue,…) so the calendar can grey
    // out non-working days per the workspace's actual schedule instead of a
    // hardcoded Sat/Sun weekend.
    let working_days = 'mon,tue,wed,thu,fri';
    try {
      const [s] = await pool.execute('SELECT working_days FROM tenant_settings WHERE singleton_key = 1 LIMIT 1');
      if (s[0]?.working_days) working_days = s[0].working_days;
    } catch (_) {}

    res.json({ shifts, leaves, holidays, dailyHours, working_days });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
