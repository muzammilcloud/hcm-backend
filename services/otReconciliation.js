const { getBusinessConfig, monthlyRequiredHours, DAY_KEYS } = require('../config/business');

// ─────────────────────────────────────────────────────────────────────────────
// Monthly OT Reconciliation
//
// For each portal_user in the workspace, compute:
//
//   required_hours = workspace_monthly_required
//                  − (approved leave days in month × daily_hours)   [half = ÷2]
//                  − (paid public holidays in month × daily_hours)
//
//   worked_net = sum(time_entries) − sum(breaks)            (within the month)
//   ot_approved = sum(ot_requests.ot_hours where status='approved')   (in month)
//   idle = sum(idle_sessions.duration_minutes) / 60                   (in month)
//
//   gap            = max(0, required_hours − worked_net)
//   ot_gap_fill    = min(ot_approved, gap)
//   ot_after_step1 = ot_approved − ot_gap_fill
//   ot_idle_cover  = min(ot_after_step1, idle)
//   ot_payable     = ot_after_step1 − ot_idle_cover
//
// This is a *report*: it does NOT modify any pay or override the per-session
// approval flow. It snapshots the breakdown on the 1st of the following month
// and stores one row per (portal_user, year, month).
// ─────────────────────────────────────────────────────────────────────────────

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

// Days a leave request contributes to a given calendar month, accounting for
// half-day duration. Days outside `working_days` (e.g. Sunday in a Mon-Fri
// workspace) don't deduct — the employee wasn't expected to work anyway.
function leaveDaysInMonth(leave, year, month, workingDaysSet) {
  const monthStart = new Date(year, month - 1, 1);
  const monthEnd   = new Date(year, month, 0);
  const start = new Date(leave.start_date);
  const end   = new Date(leave.end_date);
  const from = start > monthStart ? start : monthStart;
  const to   = end   < monthEnd   ? end   : monthEnd;
  if (from > to) return 0;

  let days = 0;
  const cur = new Date(from);
  while (cur <= to) {
    const dow = cur.getDay();
    if (workingDaysSet.has(DAY_KEYS[dow])) {
      days += leave.duration === 'half_am' || leave.duration === 'half_pm' ? 0.5 : 1;
    }
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

// Compute reconciliation for a single portal_user for a given month.
// Returns the snapshot object (NOT persisted — caller chooses to write or read).
async function computeForPortalUser(pool, portalUserId, year, month, biz) {
  const dailyHours = biz.daily_hours;

  // 1. Workspace baseline required
  const workspaceRequired = monthlyRequiredHours(biz, year, month);

  // 2. Approved leave days in the month (portal_user-scoped; column is mis-named
  //    employee_id but stores portal_user_id, matching how leaves.js inserts it).
  const [leaves] = await pool.execute(
    `SELECT start_date, end_date, duration
       FROM leave_requests
      WHERE employee_id = ?
        AND status = 'approved'
        AND start_date <= LAST_DAY(?)
        AND end_date   >= DATE(?)`,
    [portalUserId, `${year}-${String(month).padStart(2,'0')}-01`, `${year}-${String(month).padStart(2,'0')}-01`]
  );
  let leaveDaysFull = 0;
  for (const l of leaves) {
    leaveDaysFull += leaveDaysInMonth(l, year, month, biz.working_days);
  }

  // 3. Paid public holidays falling on a working day in the month
  const [holidays] = await pool.execute(
    `SELECT date FROM public_holidays
      WHERE is_paid = 1
        AND YEAR(date) = ? AND MONTH(date) = ?`,
    [year, month]
  );
  let paidHolidayDays = 0;
  for (const h of holidays) {
    const dow = new Date(h.date).getDay();
    if (biz.working_days.has(DAY_KEYS[dow])) paidHolidayDays += 1;
  }

  const requiredHours = Math.max(
    0,
    workspaceRequired - (leaveDaysFull * dailyHours) - (paidHolidayDays * dailyHours)
  );

  // 4. Net worked hours in the month — gross minus break duration
  const [workedRows] = await pool.execute(
    `SELECT
       COALESCE(SUM(TIMESTAMPDIFF(SECOND, pte.clock_in, COALESCE(pte.clock_out, NOW()))) / 3600, 0) AS gross_hours,
       COALESCE((
         SELECT SUM(
           CASE WHEN pb.break_end IS NULL
                  THEN TIMESTAMPDIFF(SECOND, pb.break_start, NOW())
                ELSE pb.duration_seconds
           END
         ) / 3600
         FROM portal_breaks pb
         JOIN portal_time_entries pte2 ON pb.time_entry_id = pte2.id
         WHERE pte2.portal_user_id = ?
           AND YEAR(pte2.clock_in) = ? AND MONTH(pte2.clock_in) = ?
       ), 0) AS break_hours
     FROM portal_time_entries pte
     WHERE pte.portal_user_id = ?
       AND YEAR(pte.clock_in) = ? AND MONTH(pte.clock_in) = ?`,
    [portalUserId, year, month, portalUserId, year, month]
  );
  const grossHours = Number(workedRows[0]?.gross_hours || 0);
  const breakHours = Number(workedRows[0]?.break_hours || 0);
  const workedNet  = Math.max(0, grossHours - breakHours);

  // 5. Approved OT hours in the month (ot_requests.employee_id stores portal_user_id)
  const [otRows] = await pool.execute(
    `SELECT COALESCE(SUM(ot_hours), 0) AS ot_hours
       FROM ot_requests
      WHERE employee_id = ?
        AND status = 'approved'
        AND YEAR(date) = ? AND MONTH(date) = ?`,
    [portalUserId, year, month]
  );
  const otApproved = Number(otRows[0]?.ot_hours || 0);

  // 6. Idle hours in the month
  const [idleRows] = await pool.execute(
    `SELECT COALESCE(SUM(duration_minutes), 0) / 60 AS idle_hours
       FROM idle_sessions
      WHERE portal_user_id = ?
        AND YEAR(idle_start) = ? AND MONTH(idle_start) = ?`,
    [portalUserId, year, month]
  );
  const idleHours = Number(idleRows[0]?.idle_hours || 0);

  // 7. Three-step reconciliation
  const gap          = Math.max(0, requiredHours - workedNet);
  const otGapFill    = Math.min(otApproved, gap);
  const otAfterStep1 = otApproved - otGapFill;
  const otIdleCover  = Math.min(otAfterStep1, idleHours);
  const otPayable    = otAfterStep1 - otIdleCover;

  return {
    portal_user_id:     portalUserId,
    year,
    month,
    required_hours:     round2(requiredHours),
    leave_days_full:    round2(leaveDaysFull),
    paid_holiday_days:  round2(paidHolidayDays),
    worked_net_hours:   round2(workedNet),
    ot_approved_hours:  round2(otApproved),
    idle_hours:         round2(idleHours),
    ot_gap_fill:        round2(otGapFill),
    ot_idle_cover:      round2(otIdleCover),
    ot_payable_surplus: round2(otPayable),
    daily_hours_used:   round2(dailyHours),
  };
}

// Persist (upsert) a single reconciliation snapshot.
async function upsertSnapshot(pool, snap) {
  await pool.execute(
    `INSERT INTO monthly_ot_reconciliation
       (portal_user_id, year, month, required_hours, leave_days_full, paid_holiday_days,
        worked_net_hours, ot_approved_hours, idle_hours,
        ot_gap_fill, ot_idle_cover, ot_payable_surplus, daily_hours_used, computed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, NOW())
     ON DUPLICATE KEY UPDATE
       required_hours     = VALUES(required_hours),
       leave_days_full    = VALUES(leave_days_full),
       paid_holiday_days  = VALUES(paid_holiday_days),
       worked_net_hours   = VALUES(worked_net_hours),
       ot_approved_hours  = VALUES(ot_approved_hours),
       idle_hours         = VALUES(idle_hours),
       ot_gap_fill        = VALUES(ot_gap_fill),
       ot_idle_cover      = VALUES(ot_idle_cover),
       ot_payable_surplus = VALUES(ot_payable_surplus),
       daily_hours_used   = VALUES(daily_hours_used),
       computed_at        = NOW()`,
    [
      snap.portal_user_id, snap.year, snap.month,
      snap.required_hours, snap.leave_days_full, snap.paid_holiday_days,
      snap.worked_net_hours, snap.ot_approved_hours, snap.idle_hours,
      snap.ot_gap_fill, snap.ot_idle_cover, snap.ot_payable_surplus,
      snap.daily_hours_used,
    ]
  );
}

// Run reconciliation for the previous month for every active portal_user
// (employees + team leads). Sys-admins are skipped — they're not paid through
// the time-tracker. Called by the scheduler on day 1.
async function runForPreviousMonth(pool) {
  const now = new Date();
  // Previous month, year-rolled if January
  let year = now.getFullYear();
  let month = now.getMonth(); // 0-indexed current → previous month, 1-indexed
  if (month === 0) { year -= 1; month = 12; }

  await runForMonth(pool, year, month);
  return { year, month };
}

// Run reconciliation for a specific month (1-12). Idempotent — repeated calls
// overwrite the snapshot row, useful for manual re-runs after data fixes.
async function runForMonth(pool, year, month) {
  const biz = await getBusinessConfig(pool);
  const [users] = await pool.execute(
    `SELECT id FROM portal_users
      WHERE status = 'active'
        AND portal_role IN ('employee','team-lead')`
  );
  for (const u of users) {
    try {
      const snap = await computeForPortalUser(pool, u.id, year, month, biz);
      await upsertSnapshot(pool, snap);
    } catch (e) {
      console.error(`[reconciliation] portal_user=${u.id} ${year}-${month}:`, e.message);
    }
  }
  return { year, month, users: users.length };
}

module.exports = {
  computeForPortalUser,
  upsertSnapshot,
  runForMonth,
  runForPreviousMonth,
};
