const { getDB, getPlatformDB, tenantContext } = require('../db');
const { sendReportEmail, sendSalarySlipEmail, sendBirthdayReminderEmail, sendBirthdayGreetingEmail, sendAnniversaryReminderEmail, sendAnniversaryGreetingEmail } = require('./email');
const { postLeaveReportToSlack } = require('./slack');
const { runForPreviousMonth: runOtReconciliationForPreviousMonth } = require('./otReconciliation');
const { tenantHas } = require('./features');
const { getBusinessConfig, COUNTRY_TZ, DEFAULT_TZ, isValidTimezone, getTenantTimezone } = require('../config/business');

// Tenant-local calendar parts (weekday 'mon'…'sun', day-of-month 1–31) in a tz.
function localParts(tz) {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' })
    .format(new Date()).toLowerCase().slice(0, 3);
  const dayOfMonth = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, day: 'numeric' })
    .format(new Date()));
  return { weekday, dayOfMonth };
}

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

    // Tenant settings drive the slip's currency / company name / title / signatory.
    let settings = {};
    try {
      const [s] = await pool.execute('SELECT * FROM tenant_settings WHERE singleton_key = 1 LIMIT 1');
      settings = s[0] || {};
    } catch (_) {}

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
        await sendSalarySlipEmail(emp, history[0], monthLabel, settings);
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
async function sendDailyLeaveReport(tz = 'Asia/Karachi') {
  console.log('📊 Sending daily leave & WFH report...');
  try {
    const pool = await getDB();

    const TYPES = ['Work From Home', 'Sick Leave', 'Casual Leave', 'Annual Leave', 'Paternity Leave', 'Maternity Leave'];
    const placeholders = TYPES.map(() => '?').join(',');

    // "Today" in the TENANT's timezone (passed from maybeSendDailyLeaveReport),
    // not a hardcoded Asia/Karachi.
    const todayPkt = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date()); // YYYY-MM-DD

    // NOTE: leave_requests.employee_id references portal_users.id (NOT employees.id).
    // Joining employees directly matched nothing, hence the old "everyone is in"
    // bug even with approved leave on the books. Join portal_users; LEFT JOIN
    // employees only for the emp_code.
    const [rows] = await pool.execute(`
      SELECT
        e.emp_code,
        pu.name,
        pu.department,
        lr.leave_type,
        lr.duration
      FROM leave_requests lr
      JOIN portal_users pu ON lr.employee_id = pu.id
      LEFT JOIN employees e ON pu.employee_id = e.id
      WHERE lr.status = 'approved'
        AND lr.leave_type IN (${placeholders})
        AND ? BETWEEN lr.start_date AND lr.end_date
        AND pu.status = 'active'
      ORDER BY FIELD(lr.leave_type, ${placeholders}), pu.name
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

// Per-tenant gate for the daily Leave & WFH report. Sends EXACTLY once per day,
// at noon in the tenant's local timezone, only on the tenant's configured
// working days, and never on a public holiday. The once-per-day guard is
// DB-backed (tenants.daily_report_last_sent) so app restarts or multiple
// instances can't re-send within the day.
async function maybeSendDailyLeaveReport(tenant) {
  const pool = await getDB();

  // Resolve the tenant's timezone (from country) and the admin-chosen send hour
  // (0–23, tenant-local; default noon) in a single read.
  let explicitTz = null, countryCode = null, reportHour = 12;
  try {
    const [s] = await pool.execute(
      'SELECT timezone, country_code, daily_report_hour FROM tenant_settings WHERE singleton_key = 1 LIMIT 1'
    );
    explicitTz  = s[0]?.timezone || null;
    countryCode = s[0]?.country_code || null;
    const h = Number(s[0]?.daily_report_hour);
    if (Number.isInteger(h) && h >= 0 && h <= 23) reportHour = h;
  } catch (_) { /* defaults below */ }
  // Explicit admin-picked timezone wins; else derive from country; else default.
  const tz = isValidTimezone(explicitTz)
    ? explicitTz
    : ((countryCode && COUNTRY_TZ[countryCode]) || DEFAULT_TZ);

  // Fire at the configured hour OR LATER the same day (catch-up), local time.
  // A single exact-hour match was fragile: a deploy/restart that shifts the
  // 30-min ticks, or an admin setting the hour after it already passed today,
  // could miss the HH:00–HH:59 window entirely and skip the whole day. Firing
  // at "hour >= reportHour" together with the DB once-per-day guard means the
  // report still goes out (slightly late at worst) instead of never.
  const { hour } = nowIn(tz);
  if (hour < reportHour) return;

  // Tenant-local calendar date (YYYY-MM-DD) and weekday (sun/mon/…).
  const todayLocal = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' })
    .format(new Date()).toLowerCase().slice(0, 3); // 'mon','tue',…

  // Working day? working_days is a Set of DAY_KEYS ('mon','tue',…).
  const { working_days } = await getBusinessConfig(pool);
  if (!working_days.has(weekday)) return;

  // Skip public holidays (per-tenant public_holidays table).
  try {
    const [hol] = await pool.execute(
      'SELECT 1 FROM public_holidays WHERE date = ? LIMIT 1', [todayLocal]
    );
    if (hol.length) return;
  } catch (_) { /* if the lookup fails, don't block the report */ }

  // Atomic, persistent once-per-day guard. The UPDATE only succeeds (affectedRows
  // === 1) the first time today — concurrent instances racing the same tenant
  // will see affectedRows === 0 and skip. Survives restarts (unlike the old
  // in-memory map that reset on every boot and caused repeated sends).
  const platform = getPlatformDB();
  let won = false;
  try {
    const [res] = await platform.execute(
      `UPDATE tenants SET daily_report_last_sent = ?
       WHERE id = ? AND (daily_report_last_sent IS NULL OR daily_report_last_sent <> ?)`,
      [todayLocal, tenant.id, todayLocal]
    );
    won = res.affectedRows === 1;
  } catch (e) {
    console.error('[daily-leave-report] guard update failed:', e.message);
    return; // don't risk a spam loop if the guard can't be written
  }
  if (!won) return; // already sent today

  await sendDailyLeaveReport(tz);
}

// Scheduled report jobs
// Run a function once per active tenant, inside that tenant's
// AsyncLocalStorage context so getDB() targets its DB pool.
async function forEachActiveTenant(label, fn) {
  let tenants = [];
  try {
    const platform = getPlatformDB();
    // Include `plan` so callbacks can do plan-based feature gating
    // (tenantHas reads tenant.plan).
    const [rows] = await platform.execute(
      `SELECT id, slug, db_name, plan FROM tenants WHERE status = 'active'`
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
    const hour = now.getHours();   // server-local — used only by platform jobs below
    const min  = now.getMinutes();

    // ── Per-tenant scheduled jobs, evaluated in EACH TENANT'S timezone ──────
    // One pass over active tenants; every report fires at the tenant's own local
    // hour (e.g. weekly = Monday 08:00 local), not a fixed server hour. A per
    // tenant + tenant-local-date guard (firedToday) de-dupes within the window.
    await forEachActiveTenant('scheduled-reports', async (tenant) => {
      const pool = await getDB();
      const tz   = await getTenantTimezone(pool);
      const { hour: lh } = nowIn(tz);
      const { weekday, dayOfMonth } = localParts(tz);
      const fired = (job) => firedToday(`${job}-${tenant.id}`, tz); // marks + dedupes per local day

      // Reconcile the previous month BEFORE the monthly report (1st, 01:00 local).
      // Growth-only. Runs first so the snapshot is ready when the email goes out.
      if (dayOfMonth === 1 && lh === 1 && tenantHas(tenant, 'monthly_reconciliation') && !fired('monthly-ot-recon')) {
        await runOtReconciliationForPreviousMonth(pool);
      }
      // Weekly report — Monday 08:00 local.
      if (weekday === 'mon' && lh === 8 && !fired('weekly')) {
        await sendWeeklyReports();
      }
      // Monthly report — 1st, 08:00 local. Growth-only.
      if (dayOfMonth === 1 && lh === 8 && tenantHas(tenant, 'monthly_reports') && !fired('monthly')) {
        await sendMonthlyReports();
      }
      // Monthly salary slips — 3rd, 09:00 local.
      if (dayOfMonth === 3 && lh === 9 && !fired('salary-slips')) {
        await sendMonthlySalarySlips();
      }
      // Birthday / anniversary greetings — daily, 08:00 local.
      if (lh === 8 && !fired('birthdays')) {
        await checkBirthdays();
      }
      // Daily Leave & WFH report — fires at the admin-chosen hour (catch-up),
      // tenant timezone, working days only. Own DB-backed once-per-day guard.
      await maybeSendDailyLeaveReport(tenant);
    });

    // Platform-level — runs against the platform DB directly, NOT
    // wrapped in tenant context. Reads tenants table, drops expired DBs.
    if (hour === 3 && min < 30 && !firedToday('tenantLifecycle', 'UTC')) {
      await runTenantLifecycle();
    }

    // Past-due dunning — every 6 hours, fires day-2/5 reminders and
    // suspends at day 8. Day-0 fires from the webhook handler.
    if (hour % 6 === 0 && min < 30 && !firedToday(`dunning-${hour}`, 'UTC')) {
      await runDunning();
    }

    // Billing safety net — every 6 hours, re-sync paying tenants from Polar so
    // cancellations / plan changes / payment status stay accurate even if a
    // webhook is missed. (Real-time sync is the webhook; trials reconcile lazily
    // when their admin opens the billing page.) Platform-level — not per tenant.
    if (hour % 6 === 0 && min < 30 && !firedToday(`billing-reconcile-${hour}`, 'UTC')) {
      try {
        const { reconcileActiveSubscriptions } = require('./billing');
        await reconcileActiveSubscriptions();
      } catch (e) { console.error('[scheduler] billing reconcile failed:', e.message); }
    }
  }, 30 * 60 * 1000);
}

// ─── Past-due dunning ────────────────────────────────────────────────────────
// For every tenant with past_due_at set:
//   - day 2 from past_due_at → send day-2 reminder (if not already sent)
//   - day 5 → send day-5 reminder
//   - day 8 → suspend (status='suspended'), final notice in the suspension UI
async function runDunning() {
  try {
    const { getPlatformDB } = require('../db');
    const { sendDunningEmail } = require('./email');
    const { getCustomerPortalUrl } = require('./billing');
    const platform = getPlatformDB();

    const [tenants] = await platform.execute(`
      SELECT id, slug, company_name, contact_email,
             past_due_at, dunning_emails_sent, polar_customer_id, status
      FROM tenants
      WHERE past_due_at IS NOT NULL
        AND status NOT IN ('suspended','deleted')
    `);
    if (!tenants.length) return;

    console.log(`[dunning] checking ${tenants.length} tenant(s) in past-due state`);

    for (const t of tenants) {
      const daysSince = Math.floor((Date.now() - new Date(t.past_due_at).getTime()) / 86_400_000);
      const already = Array.isArray(t.dunning_emails_sent) ? t.dunning_emails_sent : [];

      // Day 8: stop emailing, suspend access. The wall takes over from here.
      if (daysSince >= 8) {
        await platform.execute(
          `UPDATE tenants SET status = 'suspended' WHERE id = ? AND status = 'active'`,
          [t.id]
        );
        console.log(`[dunning]   ${t.slug}: day ${daysSince} → suspended`);
        continue;
      }

      // Pick the next due reminder, if any.
      let day = null;
      if (daysSince >= 5 && !already.includes(5))      day = 5;
      else if (daysSince >= 2 && !already.includes(2)) day = 2;
      else if (daysSince >= 0 && !already.includes(0)) day = 0; // safety net; day-0 normally fires from the webhook
      if (day == null) continue;

      try {
        const portalUrl = await getCustomerPortalUrl({ polar_customer_id: t.polar_customer_id });
        const graceEndsAt = new Date(new Date(t.past_due_at).getTime() + 8 * 86_400_000)
          .toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        const sent = await sendDunningEmail({
          to: t.contact_email,
          companyName: t.company_name,
          daysSinceFailure: day,
          billingUrl: portalUrl || `https://${t.slug}.${process.env.APEX_DOMAIN || 'tickin.pro'}/`,
          graceEndsAt,
        });
        if (sent) {
          await platform.execute(
            `UPDATE tenants SET dunning_emails_sent = JSON_ARRAY_APPEND(
               COALESCE(dunning_emails_sent, JSON_ARRAY()), '$', ?
             ) WHERE id = ?`,
            [day, t.id]
          );
          console.log(`[dunning]   ${t.slug}: day-${day} reminder sent`);
        }
      } catch (e) {
        console.error(`[dunning]   ${t.slug}: day-${day} send failed:`, e.message);
      }
    }
  } catch (e) {
    console.error('runDunning failed:', e.message);
  }
}

// ─── Tenant lifecycle ────────────────────────────────────────────────────────
// Demo plan: 14-day trial. After trial_ends_at:
//   - mark 'expired' (login still works for 7 more days, read-only ideally)
//   - 7 days later (21 days post-signup): hard-delete tenant DB
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

module.exports = { sendWeeklyReports, sendMonthlyReports, sendMonthlySalarySlips, sendDailyLeaveReport, scheduleReports, runTenantLifecycle, runDunning };
