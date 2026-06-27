const express = require('express');
const router  = express.Router();
const { getDB } = require('../db');
const { initTenantSchema } = require('../db/init');
const { requireAdmin } = require('../middleware/auth');
const { CURRENCIES, COUNTRIES, COUNTRY_DEFAULT_CURRENCY } = require('../services/locales');
const { getPreset } = require('../services/taxModules');
const { DAY_KEYS, parseWorkingDays, isValidTimezone, COUNTRY_TZ, getTenantTimezone } = require('../config/business');

// POST /api/settings/daily-report/test — send the daily Leave & WFH report NOW,
// in the tenant's resolved timezone, bypassing the once-a-day schedule guard.
// Lets an admin verify the Slack webhook + format on demand without waiting for
// the scheduled hour.
router.post('/settings/daily-report/test', requireAdmin, async (req, res, next) => {
  try {
    const pool = await getDB();
    const tz = await getTenantTimezone(pool);
    const { sendDailyLeaveReport } = require('../services/scheduler');
    await sendDailyLeaveReport(tz);
    res.json({ ok: true, timezone: tz });
  } catch (e) { next(e); }
});

// GET /api/settings/locales — public lists for the picker UI
router.get('/settings/locales', (req, res) => {
  res.json({
    currencies: CURRENCIES,
    countries:  COUNTRIES,
    country_default_currency: COUNTRY_DEFAULT_CURRENCY,
    // country → representative IANA timezone, so the FE can auto-pick a sensible
    // zone when the admin chooses a country (they can still override it).
    country_timezone: COUNTRY_TZ,
  });
});

// GET /api/settings/workspace — admin-only
router.get('/settings/workspace', requireAdmin, async (req, res, next) => {
  try {
    const pool = await getDB();
    const [rows] = await pool.execute('SELECT * FROM tenant_settings WHERE singleton_key = 1 LIMIT 1');
    if (rows.length === 0) {
      // Initialize a default row if for some reason migration missed this tenant
      await pool.execute(
        `INSERT INTO tenant_settings (singleton_key, currency, country_code, slip_title)
         VALUES (1, 'USD', 'US', 'Salary Slip')`
      );
      const [again] = await pool.execute('SELECT * FROM tenant_settings WHERE singleton_key = 1 LIMIT 1');
      return res.json(again[0]);
    }
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// PUT /api/settings/workspace — admin-only
router.put('/settings/workspace', requireAdmin, async (req, res, next) => {
  try {
    const pool = await getDB();
    const {
      currency, country_code,
      company_name, company_address, company_logo_url,
      slip_title, slip_signatory_name, slip_signatory_title,
      daily_working_hours, working_days, monthly_required_hours_override,
      daily_report_hour, daily_report_enabled, timezone, weekly_report_day,
    } = req.body || {};

    // Daily Leave & WFH report on/off. Optional; null = leave unchanged.
    let nextReportEnabled = null;
    if (daily_report_enabled !== undefined && daily_report_enabled !== null && daily_report_enabled !== '') {
      nextReportEnabled = (daily_report_enabled === true || daily_report_enabled === 1
        || daily_report_enabled === '1' || daily_report_enabled === 'true') ? 1 : 0;
    }

    // Weekly email-digest day (mon..sun). Optional.
    let nextWeeklyDay = null;
    if (weekly_report_day != null && weekly_report_day !== '') {
      const d = String(weekly_report_day).toLowerCase().slice(0, 3);
      if (!DAY_KEYS.includes(d)) {
        return res.status(400).json({ error: 'weekly_report_day must be one of: ' + DAY_KEYS.join(', ') });
      }
      nextWeeklyDay = d;
    }

    // Daily Leave & WFH report send hour (0–23, tenant-local). Optional.
    let nextReportHour = null;
    if (daily_report_hour != null && daily_report_hour !== '') {
      const h = Number(daily_report_hour);
      if (!Number.isInteger(h) || h < 0 || h > 23) {
        return res.status(400).json({ error: 'daily_report_hour must be an integer 0–23' });
      }
      nextReportHour = h;
    }

    // Explicit IANA timezone. undefined = leave alone; '' / null = clear (revert
    // to country-derived); a string = must be a valid zone.
    let timezoneOp; // undefined = no-op; otherwise the value to store (string | null)
    if (timezone !== undefined) {
      if (timezone === null || timezone === '') {
        timezoneOp = null;
      } else if (isValidTimezone(timezone)) {
        timezoneOp = timezone;
      } else {
        return res.status(400).json({ error: `Invalid timezone: ${timezone}` });
      }
    }

    const [rows] = await pool.execute('SELECT * FROM tenant_settings WHERE singleton_key = 1 LIMIT 1');
    if (rows.length === 0) return res.status(404).json({ error: 'Settings not initialized' });
    const current = rows[0];

    if (country_code && !COUNTRIES.some(c => c.code === country_code)) {
      return res.status(400).json({ error: `Unknown country: ${country_code}` });
    }

    // Validate workday settings when supplied.
    let nextDailyHours = null;
    if (daily_working_hours != null && daily_working_hours !== '') {
      const v = Number(daily_working_hours);
      if (!Number.isFinite(v) || v <= 0 || v > 24) {
        return res.status(400).json({ error: 'daily_working_hours must be between 0 and 24' });
      }
      nextDailyHours = v;
    }

    let nextWorkingDays = null;
    if (working_days != null) {
      // Accept either CSV string or array; normalize to CSV in DAY_KEYS order.
      const raw = Array.isArray(working_days) ? working_days.join(',') : String(working_days);
      const parsed = parseWorkingDays(raw);
      if (parsed.size === 0) {
        return res.status(400).json({ error: 'working_days must include at least one day' });
      }
      nextWorkingDays = DAY_KEYS.filter(d => parsed.has(d)).join(',');
    }

    let nextMonthlyOverride; // undefined = leave alone, null = clear, number = set
    if (monthly_required_hours_override !== undefined) {
      if (monthly_required_hours_override === null || monthly_required_hours_override === '') {
        nextMonthlyOverride = null;
      } else {
        const v = Number(monthly_required_hours_override);
        if (!Number.isFinite(v) || v < 0 || v > 744) {
          return res.status(400).json({ error: 'monthly_required_hours_override must be 0–744' });
        }
        nextMonthlyOverride = v;
      }
    }

    // Currency follows country by default. If the admin didn't supply an
    // explicit currency override, and the country changed, derive currency
    // from the country's default. Currency lock is intentionally not enforced
    // — admins can change either field any time.
    let nextCurrency = current.currency;
    if (currency) {
      if (!CURRENCIES.some(c => c.code === currency)) {
        return res.status(400).json({ error: `Unknown currency: ${currency}` });
      }
      nextCurrency = currency;
    } else if (country_code && country_code !== current.country_code) {
      const auto = COUNTRY_DEFAULT_CURRENCY[country_code];
      if (auto && CURRENCIES.some(c => c.code === auto)) nextCurrency = auto;
    }

    const updateSql = `UPDATE tenant_settings SET
         currency             = ?,
         country_code         = COALESCE(?, country_code),
         company_name         = COALESCE(?, company_name),
         company_address      = COALESCE(?, company_address),
         company_logo_url     = COALESCE(?, company_logo_url),
         slip_title           = COALESCE(NULLIF(?, ''), slip_title),
         slip_signatory_name  = COALESCE(?, slip_signatory_name),
         slip_signatory_title = COALESCE(?, slip_signatory_title),
         daily_working_hours  = COALESCE(?, daily_working_hours),
         working_days         = COALESCE(?, working_days),
         daily_report_hour    = COALESCE(?, daily_report_hour),
         daily_report_enabled = COALESCE(?, daily_report_enabled),
         weekly_report_day    = COALESCE(?, weekly_report_day),
         monthly_required_hours_override = ${nextMonthlyOverride === undefined ? 'monthly_required_hours_override' : '?'}
       WHERE singleton_key = 1`;
    const updateParams = [
      nextCurrency,
      country_code   || null,
      company_name   ?? null,
      company_address ?? null,
      company_logo_url ?? null,
      slip_title     ?? null,
      slip_signatory_name  ?? null,
      slip_signatory_title ?? null,
      nextDailyHours,
      nextWorkingDays,
      nextReportHour,
      nextReportEnabled,
      nextWeeklyDay,
      ...(nextMonthlyOverride === undefined ? [] : [nextMonthlyOverride]),
    ];

    try {
      await pool.execute(updateSql, updateParams);
    } catch (e) {
      // Self-heal: a tenant DB the boot migration missed can lack newer columns
      // (e.g. daily_report_hour) → "Unknown column ... in 'field list'". Re-run
      // the canonical idempotent schema to add whatever's missing, then retry.
      if (e && e.code === 'ER_BAD_FIELD_ERROR') {
        await initTenantSchema(pool);
        await pool.execute(updateSql, updateParams);
      } else {
        throw e;
      }
    }

    // Timezone is updated separately (not COALESCE) so it can be explicitly
    // cleared, and so an unrelated settings save never touches it.
    if (timezoneOp !== undefined) {
      await pool.execute('UPDATE tenant_settings SET timezone = ? WHERE singleton_key = 1', [timezoneOp]);
    }

    // Auto-load tax preset on country change — only when the admin hasn't
    // confirmed brackets yet (so we don't overwrite hand-edited ones).
    const countryChanged = country_code && country_code !== current.country_code;
    if (countryChanged) {
      try {
        const [meta] = await pool.execute('SELECT confirmed FROM tax_bracket_meta WHERE singleton_key = 1 LIMIT 1');
        const isConfirmed = meta.length > 0 && meta[0].confirmed === 1;
        if (!isConfirmed) {
          const preset = getPreset(country_code);
          if (preset) {
            await pool.execute('DELETE FROM tax_brackets');
            for (let i = 0; i < preset.brackets.length; i++) {
              const b = preset.brackets[i];
              await pool.execute(
                `INSERT INTO tax_brackets (band_from, band_to, rate, sort_order)
                 VALUES (?, ?, ?, ?)`,
                [Number(b.band_from), b.band_to == null ? null : Number(b.band_to), Number(b.rate), (i + 1) * 10]
              );
            }
            await pool.execute(
              `INSERT INTO tax_bracket_meta (singleton_key, source_country, preset_year, confirmed)
               VALUES (1, ?, ?, 0)
               ON DUPLICATE KEY UPDATE
                 source_country = VALUES(source_country),
                 preset_year    = VALUES(preset_year),
                 confirmed      = VALUES(confirmed)`,
              [country_code, preset.year]
            );
          }
        }
      } catch (e) { console.error('[auto-load tax preset]', e.message); }
    }

    const [updated] = await pool.execute('SELECT * FROM tenant_settings WHERE singleton_key = 1 LIMIT 1');
    res.json(updated[0]);
  } catch (e) { next(e); }
});

module.exports = router;
