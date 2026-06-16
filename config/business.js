// Business rules — defaults + per-tenant resolver.
// Tenants override `daily_working_hours`, `working_days`, and
// `monthly_required_hours_override` in their `tenant_settings` row.
// The constants below remain the fallback when a tenant has no setting.

const OT_THRESHOLD_HOURS = 9;
const OT_THRESHOLD_MS    = OT_THRESHOLD_HOURS * 60 * 60 * 1000;

const MONTHLY_TARGET_HOURS = 180;

const DAY_KEYS = ['sun','mon','tue','wed','thu','fri','sat'];
const DEFAULT_WORKING_DAYS = 'mon,tue,wed,thu,fri';

function parseWorkingDays(csv) {
  const set = new Set(
    String(csv || DEFAULT_WORKING_DAYS)
      .toLowerCase()
      .split(',')
      .map(s => s.trim())
      .filter(s => DAY_KEYS.includes(s))
  );
  if (set.size === 0) DAY_KEYS.slice(1, 6).forEach(d => set.add(d));
  return set;
}

function workingDaysInMonth(year, month, workingDaysSet) {
  const days = new Date(year, month, 0).getDate();
  let count = 0;
  for (let d = 1; d <= days; d++) {
    const dow = new Date(year, month - 1, d).getDay();
    if (workingDaysSet.has(DAY_KEYS[dow])) count++;
  }
  return count;
}

async function getBusinessConfig(pool) {
  try {
    const [rows] = await pool.execute(
      `SELECT daily_working_hours, working_days, monthly_required_hours_override
         FROM tenant_settings WHERE singleton_key = 1 LIMIT 1`
    );
    const row = rows[0] || {};
    const daily_hours = Number(row.daily_working_hours) > 0
      ? Number(row.daily_working_hours)
      : OT_THRESHOLD_HOURS;
    const working_days = parseWorkingDays(row.working_days);
    const monthly_override = row.monthly_required_hours_override == null
      ? null
      : Number(row.monthly_required_hours_override);
    return {
      daily_hours,
      daily_ms: daily_hours * 60 * 60 * 1000,
      working_days,
      monthly_override,
    };
  } catch (_) {
    return {
      daily_hours: OT_THRESHOLD_HOURS,
      daily_ms: OT_THRESHOLD_MS,
      working_days: parseWorkingDays(DEFAULT_WORKING_DAYS),
      monthly_override: null,
    };
  }
}

function monthlyRequiredHours(config, year, month) {
  if (config.monthly_override != null && Number.isFinite(config.monthly_override)) {
    return config.monthly_override;
  }
  return config.daily_hours * workingDaysInMonth(year, month, config.working_days);
}

// Representative IANA timezone per country (ISO-3166 alpha-2). Used to resolve a
// tenant's local "today"/noon for scheduling + date validation — close enough
// for day-granularity decisions; falls back to Asia/Karachi (the product's
// original default) for anything not listed.
const COUNTRY_TZ = {
  PK: 'Asia/Karachi',   IN: 'Asia/Kolkata',     BD: 'Asia/Dhaka',      LK: 'Asia/Colombo',
  AE: 'Asia/Dubai',     SA: 'Asia/Riyadh',      QA: 'Asia/Qatar',      KW: 'Asia/Kuwait',
  OM: 'Asia/Muscat',    BH: 'Asia/Bahrain',     JO: 'Asia/Amman',      EG: 'Africa/Cairo',
  TR: 'Europe/Istanbul',GB: 'Europe/London',    IE: 'Europe/Dublin',   DE: 'Europe/Berlin',
  FR: 'Europe/Paris',   ES: 'Europe/Madrid',    IT: 'Europe/Rome',     NL: 'Europe/Amsterdam',
  SE: 'Europe/Stockholm',PL: 'Europe/Warsaw',   US: 'America/New_York', CA: 'America/Toronto',
  MX: 'America/Mexico_City', BR: 'America/Sao_Paulo', AR: 'America/Argentina/Buenos_Aires',
  AU: 'Australia/Sydney',NZ: 'Pacific/Auckland', SG: 'Asia/Singapore',  MY: 'Asia/Kuala_Lumpur',
  ID: 'Asia/Jakarta',   PH: 'Asia/Manila',      TH: 'Asia/Bangkok',    VN: 'Asia/Ho_Chi_Minh',
  JP: 'Asia/Tokyo',     KR: 'Asia/Seoul',       CN: 'Asia/Shanghai',   HK: 'Asia/Hong_Kong',
  ZA: 'Africa/Johannesburg', NG: 'Africa/Lagos', KE: 'Africa/Nairobi',
};
const DEFAULT_TZ = 'Asia/Karachi';

// Resolve a tenant's timezone from its country_code (tenant_settings).
// Is this a valid IANA timezone the runtime can resolve?
function isValidTimezone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; }
  catch (_) { return false; }
}

// Resolve a tenant's timezone. Preference order:
//   1. explicit `timezone` (admin-picked IANA zone) — exact, multi-tz safe
//   2. country_code → representative zone (COUNTRY_TZ)
//   3. DEFAULT_TZ
async function getTenantTimezone(pool) {
  try {
    const [rows] = await pool.execute(
      'SELECT timezone, country_code FROM tenant_settings WHERE singleton_key = 1 LIMIT 1'
    );
    const explicit = rows[0]?.timezone;
    if (isValidTimezone(explicit)) return explicit;
    const code = rows[0]?.country_code;
    return (code && COUNTRY_TZ[code]) || DEFAULT_TZ;
  } catch (_) {
    return DEFAULT_TZ;
  }
}

// Tenant-local calendar date as 'YYYY-MM-DD'.
async function getTenantToday(pool) {
  const tz = await getTenantTimezone(pool);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}

// Chargeable leave days for a single request. Half-day = 0.5. Full-day = the
// number of WORKING days (per tenant working_days) in [start,end] that are NOT
// public holidays — so a range spanning a weekend/holiday doesn't over-charge.
function countLeaveDays(startStr, endStr, duration, workingDaySet, holidaySet) {
  if (duration && duration !== 'full') return 0.5;
  const start = new Date(String(startStr).slice(0, 10) + 'T00:00:00');
  const end   = new Date(String(endStr).slice(0, 10)   + 'T00:00:00');
  if (isNaN(start) || isNaN(end) || end < start) return 0;
  let n = 0;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const key = DAY_KEYS[d.getDay()];
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (workingDaySet.has(key) && !(holidaySet && holidaySet.has(iso))) n++;
  }
  return n;
}

// Load the inputs countLeaveDays needs: the tenant working-day set + the set of
// public-holiday dates (YYYY-MM-DD) for the current tenant.
async function getLeaveCalc(pool) {
  const { working_days } = await getBusinessConfig(pool);
  let holidaySet = new Set();
  try {
    const [hrows] = await pool.execute(`SELECT DATE_FORMAT(date, '%Y-%m-%d') AS d FROM public_holidays`);
    holidaySet = new Set(hrows.map(r => r.d));
  } catch (_) {}
  return { workingDaySet: working_days, holidaySet };
}

// Current leave-year window based on the joining anniversary (shared by the
// employee balance, admin quota table, and team-lead quota table so all three
// agree). Returns { start, end } as YYYY-MM-DD.
function getLeaveYearRange(joinDateStr) {
  const join = new Date(joinDateStr + 'T00:00:00');
  const today = new Date();
  let yr = today.getFullYear();
  let start = new Date(yr, join.getMonth(), join.getDate());
  if (start > today) { yr--; start = new Date(yr, join.getMonth(), join.getDate()); }
  const end = new Date(yr + 1, join.getMonth(), join.getDate());
  end.setDate(end.getDate() - 1);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

module.exports = {
  OT_THRESHOLD_HOURS,
  OT_THRESHOLD_MS,
  MONTHLY_TARGET_HOURS,
  DEFAULT_WORKING_DAYS,
  DAY_KEYS,
  COUNTRY_TZ,
  DEFAULT_TZ,
  isValidTimezone,
  getBusinessConfig,
  getTenantTimezone,
  getTenantToday,
  parseWorkingDays,
  workingDaysInMonth,
  monthlyRequiredHours,
  getLeaveYearRange,
  countLeaveDays,
  getLeaveCalc,
};
