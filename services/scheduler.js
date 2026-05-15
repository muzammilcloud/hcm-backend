const { getDB, getPlatformDB, tenantContext } = require('../db');
const { sendReportEmail, sendSalarySlipEmail, sendBirthdayReminderEmail, sendBirthdayGreetingEmail, sendAnniversaryReminderEmail, sendAnniversaryGreetingEmail } = require('./email');
const { postLeaveReportToSlack } = require('./slack');

// Read wall-clock hour/minute in a given IANA timezone (server may run in any tz).
function nowIn(tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  return {
    hour: parseInt(parts.find(p => p.type === 'hour').value, 10),
    min:  parseInt(parts.find(p => p.type === 'minute').value, 10),
  };
}

// Tracks the last-fired date for daily jobs so the 30-min check loop doesn't
// fire the same job twice within its trigger window.
const lastFired = {};
function firedToday(jobId, tz) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date()); // YYYY-MM-DD
  if (lastFired[jobId] === today) return true;
  lastFired[jobId] = today;
  return false;
}

async function sendWeeklyReports() {
  console.log('📧 Sending weekly reports...');
  try {
    const pool = await getDB();
    const [employees] = await pool.execute('SELECT * FROM employees WHERE is_active=1');
    for (const emp of employees) {
      const [rows] = await pool.execute(`
        SELECT DATE(clock_in) as date,
          GROUP_CONCAT(CONCAT(TIME_FORMAT(clock_in,'%H:%i'),'-',IF(clock_out IS NULL,'active',TIME_FORMAT(clock_out,'%H:%i'))) ORDER BY clock_in SEPARATOR ', ') as sessions,
          ROUND(SUM(TIMESTAMPDIFF(SECOND,clock_in,COALESCE(clock_out,NOW()))/3600),2) as hours
        FROM time_entries WHERE employee_id=? AND YEARWEEK(clock_in,1)=YEARWEEK(DATE_SUB(NOW(),INTERVAL 7 DAY),1)
        GROUP BY DATE(clock_in) ORDER BY date ASC
      `, [emp.id]);
      if (rows.length > 0) {
        await sendReportEmail({ to: emp.email, subject: '📊 Your Weekly Time Report — Tickin',
          title: 'Weekly Time Report', subtitle: `${emp.name} · ${emp.department}`,
          columns: [{ key:'date', label:'Date' },{ key:'sessions', label:'Sessions' },{ key:'hours', label:'Hours' }],
          rows });
      }
    }
    // Admin summary
    const adminEmail = process.env.ADMIN_EMAIL;
    if (adminEmail) {
      const [summary] = await pool.execute(`
        SELECT e.name, e.department, COUNT(te.id) as sessions,
          ROUND(SUM(TIMESTAMPDIFF(SECOND,te.clock_in,COALESCE(te.clock_out,NOW()))/3600),2) as hours
        FROM employees e LEFT JOIN time_entries te ON e.id=te.employee_id
          AND YEARWEEK(te.clock_in,1)=YEARWEEK(DATE_SUB(NOW(),INTERVAL 7 DAY),1)
        WHERE e.is_active=1 GROUP BY e.id ORDER BY hours DESC
      `);
      await sendReportEmail({ to: adminEmail, subject: '📊 Weekly Team Report — Tickin',
        title: 'Weekly Team Report', subtitle: 'All Employees Summary',
        columns: [{ key:'name', label:'Employee' },{ key:'department', label:'Dept' },{ key:'sessions', label:'Sessions' },{ key:'hours', label:'Hours' }],
        rows: summary });
    }
  } catch(e) { console.error('Weekly report error:', e.message); }
}

async function sendMonthlyReports() {
  console.log('📧 Sending monthly reports...');
  try {
    const pool = await getDB();
    const [employees] = await pool.execute('SELECT * FROM employees WHERE is_active=1');
    for (const emp of employees) {
      const [rows] = await pool.execute(`
        SELECT DATE(clock_in) as date,
          GROUP_CONCAT(CONCAT(TIME_FORMAT(clock_in,'%H:%i'),'-',IF(clock_out IS NULL,'active',TIME_FORMAT(clock_out,'%H:%i'))) ORDER BY clock_in SEPARATOR ', ') as sessions,
          ROUND(SUM(TIMESTAMPDIFF(SECOND,clock_in,COALESCE(clock_out,NOW()))/3600),2) as hours
        FROM time_entries WHERE employee_id=?
          AND MONTH(clock_in)=MONTH(DATE_SUB(NOW(),INTERVAL 1 MONTH))
          AND YEAR(clock_in)=YEAR(DATE_SUB(NOW(),INTERVAL 1 MONTH))
        GROUP BY DATE(clock_in) ORDER BY date ASC
      `, [emp.id]);
      if (rows.length > 0) {
        await sendReportEmail({ to: emp.email, subject: '📊 Your Monthly Time Report — Tickin',
          title: 'Monthly Time Report', subtitle: `${emp.name} · ${emp.department}`,
          columns: [{ key:'date', label:'Date' },{ key:'sessions', label:'Sessions' },{ key:'hours', label:'Hours' }],
          rows });
      }
    }
    const adminEmail = process.env.ADMIN_EMAIL;
    if (adminEmail) {
      const [summary] = await pool.execute(`
        SELECT e.name, e.department, COUNT(te.id) as sessions,
          ROUND(SUM(TIMESTAMPDIFF(SECOND,te.clock_in,COALESCE(te.clock_out,NOW()))/3600),2) as hours
        FROM employees e LEFT JOIN time_entries te ON e.id=te.employee_id
          AND MONTH(te.clock_in)=MONTH(DATE_SUB(NOW(),INTERVAL 1 MONTH))
          AND YEAR(te.clock_in)=YEAR(DATE_SUB(NOW(),INTERVAL 1 MONTH))
        WHERE e.is_active=1 GROUP BY e.id ORDER BY hours DESC
      `);
      await sendReportEmail({ to: adminEmail, subject: '📊 Monthly Team Report — Tickin',
        title: 'Monthly Team Report', subtitle: 'All Employees — Previous Month',
        columns: [{ key:'name', label:'Employee' },{ key:'department', label:'Dept' },{ key:'sessions', label:'Sessions' },{ key:'hours', label:'Hours' }],
        rows: summary });
    }
  } catch(e) { console.error('Monthly report error:', e.message); }
}

async function sendMonthlySalarySlips() {
  console.log('📧 Sending monthly salary slips...');
  try {
    const pool = await getDB();

    // Previous month as YYYY-MM-01
    const now       = new Date();
    const prevDate  = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevMonth = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}-01`;
    const monthLabel = prevDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    const [employees] = await pool.execute('SELECT * FROM employees WHERE is_active = 1');

    let sent = 0;
    for (const emp of employees) {
      const [history] = await pool.execute(
        'SELECT * FROM salary_history WHERE employee_id = ? AND month = ?',
        [emp.id, prevMonth]
      );

      if (history.length === 0) {
        console.log(`⚠️  No salary history for ${emp.name} (${monthLabel}) — skipping`);
        continue;
      }

      try {
        await sendSalarySlipEmail(emp, history[0], monthLabel);
        console.log(`✅ Salary slip sent to ${emp.name} <${emp.email}>`);
        sent++;
      } catch (e) {
        console.error(`❌ Failed to send slip to ${emp.name}:`, e.message);
      }
    }

    console.log(`📧 Salary slips done — ${sent}/${employees.length} sent for ${monthLabel}`);
  } catch (e) {
    console.error('Monthly salary slip job error:', e.message);
  }
}

async function checkBirthdays() {
  console.log('🎂 Checking birthdays...');
  try {
    const pool = await getDB();
    // Greetings to employees with birthday TODAY
    const [todayRows] = await pool.execute(
      `SELECT name, email FROM employees
       WHERE MONTH(date_of_birth) = MONTH(CURDATE()) AND DAY(date_of_birth) = DAY(CURDATE())
       AND is_active = 1 AND date_of_birth IS NOT NULL`
    );
    for (const emp of todayRows) {
      await sendBirthdayGreetingEmail({ name: emp.name, email: emp.email });
    }
    // Reminder to admin for birthdays TOMORROW
    const [tomorrowRows] = await pool.execute(
      `SELECT name, email, department, date_of_birth FROM employees
       WHERE MONTH(date_of_birth) = MONTH(DATE_ADD(CURDATE(), INTERVAL 1 DAY))
       AND DAY(date_of_birth) = DAY(DATE_ADD(CURDATE(), INTERVAL 1 DAY))
       AND is_active = 1 AND date_of_birth IS NOT NULL`
    );
    if (tomorrowRows.length > 0) {
      const adminEmail = process.env.ADMIN_EMAIL || process.env.SMTP_USER;
      await sendBirthdayReminderEmail({ adminEmail, employees: tomorrowRows });
    }
    console.log(`🎂 Birthday check done — ${todayRows.length} greeting(s), ${tomorrowRows.length} reminder(s)`);

    // Work anniversary greetings (today)
    const [todayAnn] = await pool.execute(
      `SELECT name, email, YEAR(CURDATE()) - YEAR(join_date) AS years
       FROM employees
       WHERE MONTH(join_date) = MONTH(CURDATE()) AND DAY(join_date) = DAY(CURDATE())
       AND is_active = 1 AND join_date IS NOT NULL`
    );
    for (const emp of todayAnn) {
      await sendAnniversaryGreetingEmail({ name: emp.name, email: emp.email, years: emp.years });
    }

    // Work anniversary reminder to admin (tomorrow)
    const [tomorrowAnn] = await pool.execute(
      `SELECT name, email, department, join_date,
        YEAR(DATE_ADD(CURDATE(), INTERVAL 1 DAY)) - YEAR(join_date) AS years
       FROM employees
       WHERE MONTH(join_date) = MONTH(DATE_ADD(CURDATE(), INTERVAL 1 DAY))
       AND DAY(join_date) = DAY(DATE_ADD(CURDATE(), INTERVAL 1 DAY))
       AND is_active = 1 AND join_date IS NOT NULL`
    );
    if (tomorrowAnn.length > 0) {
      const adminEmail = process.env.ADMIN_EMAIL || process.env.SMTP_USER;
      await sendAnniversaryReminderEmail({ adminEmail, employees: tomorrowAnn });
    }
    console.log(`🏆 Anniversary check done — ${todayAnn.length} greeting(s), ${tomorrowAnn.length} reminder(s)`);
  } catch (e) { console.error('Birthday check error:', e.message); }
}

// Daily leave + WFH report — fires after 12:00 PKT, posts to a dedicated Slack channel.
// Includes Annual / Sick / Casual / WFH / Paternity / Maternity. Excludes Public Holiday and Unpaid Leave.
async function sendDailyLeaveReport() {
  console.log('📊 Sending daily leave & WFH report...');
  try {
    const pool = await getDB();

    const TYPES = ['Work From Home', 'Sick Leave', 'Casual Leave', 'Annual Leave', 'Paternity Leave', 'Maternity Leave'];
    const placeholders = TYPES.map(() => '?').join(',');

    // Today in PKT — pin the comparison to Asia/Karachi rather than the server's own clock.
    const todayPkt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date()); // YYYY-MM-DD

    const [rows] = await pool.execute(`
      SELECT
        e.emp_code,
        e.name,
        e.department,
        lr.leave_type,
        lr.duration
      FROM leave_requests lr
      JOIN employees e ON lr.employee_id = e.id
      WHERE lr.status = 'approved'
        AND lr.leave_type IN (${placeholders})
        AND ? BETWEEN lr.start_date AND lr.end_date
        AND e.is_active = 1
      ORDER BY FIELD(lr.leave_type, ${placeholders}), e.name
    `, [...TYPES, todayPkt, ...TYPES]);

    const dateLabel = new Date(todayPkt + 'T00:00:00').toLocaleDateString('en-GB', {
      day: '2-digit', month: 'long', year: 'numeric',
    }); // "04 May 2026"

    if (rows.length === 0) {
      const text = `*📊 Daily Leave & WFH Report — ${dateLabel}*\n\nEveryone is in today. No approved leave or WFH requests on the books for the day.`;
      await postLeaveReportToSlack(text);
      console.log('📊 Daily report sent (no leaves/WFH today).');
      return;
    }

    // Group by leave_type, preserving the TYPES order.
    const grouped = {};
    for (const r of rows) {
      (grouped[r.leave_type] ||= []).push(r);
    }

    // Slack mrkdwn message: header + per-type sections + summary.
    const sections = [];
    for (const type of TYPES) {
      const list = grouped[type];
      if (!list || list.length === 0) continue;
      const lines = list.map(r => {
        const code = r.emp_code || '—';
        const half = r.duration === 'half_am' ? '  _(½ AM)_'
                   : r.duration === 'half_pm' ? '  _(½ PM)_'
                   : '';
        return `• \`${code}\`  ${r.name} — ${r.department}${half}`;
      });
      sections.push(`*${type}* (${list.length})\n${lines.join('\n')}`);
    }

    const summary = TYPES
      .filter(t => grouped[t]?.length)
      .map(t => `${t}: ${grouped[t].length}`)
      .join('  ·  ');

    const text = [
      `*📊 Daily Leave & WFH Report — ${dateLabel}*`,
      '',
      sections.join('\n\n'),
      '',
      `_Summary — ${summary}  ·  Total ${rows.length}_`,
    ].join('\n');

    await postLeaveReportToSlack(text);
    console.log(`📊 Daily report sent — ${rows.length} on leave/WFH today.`);
  } catch (e) {
    console.error('Daily leave report error:', e.message);
  }
}

// Scheduled report jobs
// Run a function once per active tenant, inside that tenant's
// AsyncLocalStorage context so getDB() targets its DB pool.
async function forEachActiveTenant(label, fn) {
  let tenants = [];
  try {
    const platform = getPlatformDB();
    const [rows] = await platform.execute(
      `SELECT id, slug, db_name FROM tenants WHERE status = 'active'`
    );
    tenants = rows;
  } catch (e) {
    console.error(`[${label}] could not list tenants:`, e.message);
    return;
  }
  for (const t of tenants) {
    try {
      await tenantContext.run(
        { dbName: t.db_name, slug: t.slug, tenantId: t.id },
        () => fn(t)
      );
    } catch (e) {
      console.error(`[${label}] ${t.slug}:`, e.message);
    }
  }
}

function scheduleReports() {
  // Check every 30 minutes
  setInterval(async () => {
    const now  = new Date();
    const day  = now.getDay();   // 0=Sun,1=Mon
    const date = now.getDate();
    const hour = now.getHours();
    const min  = now.getMinutes();

    // Each scheduled email/report is per-tenant — wrap the call in
    // tenant context iteration so getDB() inside the function returns
    // each tenant's pool in turn.

    if (day === 1 && hour === 8 && min < 30) {
      await forEachActiveTenant('weekly-report', () => sendWeeklyReports());
    }
    if (date === 1 && hour === 8 && min < 30) {
      await forEachActiveTenant('monthly-report', () => sendMonthlyReports());
    }
    if (date === 3 && hour === 9 && min < 30) {
      await forEachActiveTenant('monthly-salary-slips', () => sendMonthlySalarySlips());
    }
    if (hour === 8 && min < 30) {
      await forEachActiveTenant('birthdays', () => checkBirthdays());
    }
    const pkt = nowIn('Asia/Karachi');
    if (pkt.hour >= 12 && pkt.hour < 24 && !firedToday('dailyLeaveReport', 'Asia/Karachi')) {
      await forEachActiveTenant('daily-leave-report', () => sendDailyLeaveReport());
    }

    // Platform-level — runs against the platform DB directly, NOT
    // wrapped in tenant context. Reads tenants table, drops expired DBs.
    if (hour === 3 && min < 30 && !firedToday('tenantLifecycle', 'UTC')) {
      await runTenantLifecycle();
    }
  }, 30 * 60 * 1000);
}

// ─── Tenant lifecycle ────────────────────────────────────────────────────────
// Demo plan: 7-day trial.  After trial_ends_at:
//   - mark 'expired' (login still works for 7 more days, read-only ideally)
//   - 7 days later (14 days post-signup): hard-delete tenant DB
async function runTenantLifecycle() {
  try {
    const { getPlatformDB } = require('../db');
    const { deleteTenant, audit } = require('./tenant');
    const platform = getPlatformDB();

    // 1. Demo trials that ended → mark expired
    const [expiring] = await platform.execute(`
      SELECT id, slug FROM tenants
      WHERE status = 'active' AND plan = 'demo'
        AND trial_ends_at IS NOT NULL
        AND trial_ends_at <= NOW()
    `);
    for (const t of expiring) {
      await platform.execute(`UPDATE tenants SET status = 'expired' WHERE id = ?`, [t.id]);
      audit({ actorType: 'system', tenantId: t.id, action: 'tenant.expire', detail: { slug: t.slug } });
      console.log(`⏳ Tenant ${t.slug} expired (demo trial ended).`);
    }

    // 2. Expired tenants past grace window → hard delete
    const graceDays = Number(process.env.DEMO_GRACE_DAYS) || 7;
    const [toDelete] = await platform.execute(`
      SELECT id, slug FROM tenants
      WHERE status = 'expired' AND plan = 'demo'
        AND trial_ends_at IS NOT NULL
        AND trial_ends_at < DATE_SUB(NOW(), INTERVAL ? DAY)
    `, [graceDays]);
    for (const t of toDelete) {
      try {
        await deleteTenant(t.id);
        audit({ actorType: 'system', tenantId: t.id, action: 'tenant.auto_delete', detail: { slug: t.slug } });
        console.log(`🗑  Tenant ${t.slug} auto-deleted (grace window expired).`);
      } catch (e) {
        console.error(`Failed to delete tenant ${t.slug}:`, e.message);
      }
    }
  } catch (e) {
    console.error('runTenantLifecycle failed:', e.message);
  }
}

module.exports = { sendWeeklyReports, sendMonthlyReports, sendMonthlySalarySlips, sendDailyLeaveReport, scheduleReports, runTenantLifecycle };
