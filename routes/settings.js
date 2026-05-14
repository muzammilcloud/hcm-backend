const express = require('express');
const router  = express.Router();
const { getDB } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { CURRENCIES, COUNTRIES, COUNTRY_DEFAULT_CURRENCY } = require('../services/locales');

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

    // Currency lock: once currency_locked=1, the field can't change without
    // going through the (future) reset-payroll-history flow.
    let nextCurrency = current.currency;
    if (currency && currency !== current.currency) {
      if (current.currency_locked) {
        return res.status(400).json({
          error: 'Currency is locked. Changing it would invalidate generated salary slips. Reset payroll history first.',
          code:  'CURRENCY_LOCKED',
        });
      }
      // Validate the currency exists in our list
      if (!CURRENCIES.some(c => c.code === currency)) {
        return res.status(400).json({ error: `Unknown currency: ${currency}` });
      }
      nextCurrency = currency;
    }

    if (country_code && !COUNTRIES.some(c => c.code === country_code)) {
      return res.status(400).json({ error: `Unknown country: ${country_code}` });
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

    const [updated] = await pool.execute('SELECT * FROM tenant_settings WHERE singleton_key = 1 LIMIT 1');
    res.json(updated[0]);
  } catch (e) { next(e); }
});

module.exports = router;
