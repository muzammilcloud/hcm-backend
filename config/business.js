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

module.exports = {
  OT_THRESHOLD_HOURS,
  OT_THRESHOLD_MS,
  MONTHLY_TARGET_HOURS,
  DEFAULT_WORKING_DAYS,
  DAY_KEYS,
  getBusinessConfig,
  parseWorkingDays,
  workingDaysInMonth,
  monthlyRequiredHours,
};
