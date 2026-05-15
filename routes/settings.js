const express = require('express');
const router  = express.Router();
const { getDB } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { CURRENCIES, COUNTRIES, COUNTRY_DEFAULT_CURRENCY } = require('../services/locales');
const { getPreset } = require('../services/taxModules');

// GET /api/settings/locales — public lists for the picker UI
router.get('/settings/locales', (req, res) => {
  res.json({
    currencies: CURRENCIES,
    countries:  COUNTRIES,
    country_default_currency: COUNTRY_DEFAULT_CURRENCY,
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
    } = req.body || {};

    const [rows] = await pool.execute('SELECT * FROM tenant_settings WHERE singleton_key = 1 LIMIT 1');
    if (rows.length === 0) return res.status(404).json({ error: 'Settings not initialized' });
    const current = rows[0];

    if (country_code && !COUNTRIES.some(c => c.code === country_code)) {
      return res.status(400).json({ error: `Unknown country: ${country_code}` });
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

    await pool.execute(
      `UPDATE tenant_settings SET
         currency             = ?,
         country_code         = COALESCE(?, country_code),
         company_name         = COALESCE(?, company_name),
         company_address      = COALESCE(?, company_address),
         company_logo_url     = COALESCE(?, company_logo_url),
         slip_title           = COALESCE(NULLIF(?, ''), slip_title),
         slip_signatory_name  = COALESCE(?, slip_signatory_name),
         slip_signatory_title = COALESCE(?, slip_signatory_title)
       WHERE singleton_key = 1`,
      [
        nextCurrency,
        country_code   || null,
        company_name   ?? null,
        company_address ?? null,
        company_logo_url ?? null,
        slip_title     ?? null,
        slip_signatory_name  ?? null,
        slip_signatory_title ?? null,
      ]
    );

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
