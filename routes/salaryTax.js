const express = require('express');
const router  = express.Router();
const { getDB } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { PRESETS, getPreset, listSupportedCountries, calculateTax } = require('../services/taxModules');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function validateBrackets(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return ['brackets must be a non-empty array'];
  const errors = [];
  let lastTo = -Infinity;
  for (let i = 0; i < rows.length; i++) {
    const b = rows[i];
    const from = Number(b.band_from);
    const to   = b.band_to == null ? null : Number(b.band_to);
    const rate = Number(b.rate);
    if (isNaN(from) || from < 0)       errors.push(`row ${i+1}: band_from must be ≥ 0`);
    if (to != null && (isNaN(to) || to <= from)) errors.push(`row ${i+1}: band_to must be > band_from`);
    if (isNaN(rate) || rate < 0 || rate > 100)   errors.push(`row ${i+1}: rate must be 0–100`);
    if (i > 0 && from !== lastTo)      errors.push(`row ${i+1}: band_from (${from}) must equal previous band_to (${lastTo})`);
    lastTo = to;
  }
  // Last row must be open-ended (to = null)
  if (rows.length && rows[rows.length - 1].band_to !== null && rows[rows.length - 1].band_to !== undefined) {
    errors.push('last row must have band_to = null (open-ended)');
  }
  return errors;
}

async function readBrackets(pool) {
  const [rows] = await pool.execute(
    `SELECT id, band_from, band_to, rate, sort_order
     FROM tax_brackets ORDER BY sort_order ASC, band_from ASC`
  );
  return rows.map(r => ({
    ...r,
    band_from: Number(r.band_from),
    band_to:   r.band_to == null ? null : Number(r.band_to),
    rate:      Number(r.rate),
  }));
}

async function readMeta(pool) {
  const [rows] = await pool.execute('SELECT * FROM tax_bracket_meta WHERE singleton_key = 1 LIMIT 1');
  return rows[0] || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/salary/tax/presets — list bundled country presets
router.get('/salary/tax/presets', requireAdmin, (req, res) => {
  const list = listSupportedCountries().map(code => ({
    code,
    year:  PRESETS[code].year,
    notes: PRESETS[code].notes,
    bracket_count: PRESETS[code].brackets.length,
  }));
  res.json({ presets: list });
});

// GET /api/salary/tax/preset/:country — fetch one preset (preview, doesn't save)
router.get('/salary/tax/preset/:country', requireAdmin, (req, res) => {
  const p = getPreset(req.params.country?.toUpperCase());
  if (!p) return res.status(404).json({ error: 'No preset for this country' });
  res.json({
    country: req.params.country.toUpperCase(),
    year:    p.year,
    notes:   p.notes,
    brackets: p.brackets,
  });
});

// GET /api/salary/tax/brackets — current brackets + meta
// If the brackets table is empty AND the tenant's country has a bundled
// preset, populate it on the fly so the admin lands on a usable starting
// point (confirmed=0, so the "review and confirm" banner still appears).
router.get('/salary/tax/brackets', requireAdmin, async (req, res, next) => {
  try {
    const pool = await getDB();
    let brackets = await readBrackets(pool);

    if (brackets.length === 0) {
      try {
        const [settings] = await pool.execute(
          'SELECT country_code FROM tenant_settings WHERE singleton_key = 1 LIMIT 1'
        );
        const country = settings[0]?.country_code;
        const preset  = country ? getPreset(country) : null;
        if (preset) {
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
             ON DUPLICATE KEY UPDATE source_country = VALUES(source_country), preset_year = VALUES(preset_year)`,
            [country, preset.year]
          );
          brackets = await readBrackets(pool);
        }
      } catch (e) { console.error('[tax brackets auto-seed]', e.message); }
    }

    const meta = await readMeta(pool);
    res.json({
      brackets,
      meta: meta ? {
        source_country: meta.source_country,
        preset_year:    meta.preset_year,
        confirmed:      !!meta.confirmed,
        confirmed_at:   meta.confirmed_at,
        tax_enabled:    meta.tax_enabled == null ? true : !!meta.tax_enabled,
        updated_at:     meta.updated_at,
      } : null,
    });
  } catch (e) { next(e); }
});

// PUT /api/salary/tax/brackets — replace all brackets atomically
router.put('/salary/tax/brackets', requireAdmin, async (req, res, next) => {
  try {
    const { brackets, source_country = null, preset_year = null, confirmed = true, tax_enabled } = req.body || {};
    const errors = validateBrackets(brackets);
    if (errors.length) return res.status(400).json({ error: 'Invalid brackets', details: errors });

    const pool = await getDB();
    await pool.execute('DELETE FROM tax_brackets');
    for (let i = 0; i < brackets.length; i++) {
      const b = brackets[i];
      await pool.execute(
        `INSERT INTO tax_brackets (band_from, band_to, rate, sort_order)
         VALUES (?, ?, ?, ?)`,
        [Number(b.band_from), b.band_to == null ? null : Number(b.band_to), Number(b.rate), (i + 1) * 10]
      );
    }
    await pool.execute(
      `INSERT INTO tax_bracket_meta (singleton_key, source_country, preset_year, confirmed, confirmed_at, tax_enabled)
       VALUES (1, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         source_country = VALUES(source_country),
         preset_year    = VALUES(preset_year),
         confirmed      = VALUES(confirmed),
         confirmed_at   = VALUES(confirmed_at),
         tax_enabled    = COALESCE(VALUES(tax_enabled), tax_enabled)`,
      [source_country, preset_year, confirmed ? 1 : 0, confirmed ? new Date() : null,
       tax_enabled == null ? null : (tax_enabled ? 1 : 0)]
    );

    const rows = await readBrackets(pool);
    const meta = await readMeta(pool);
    res.json({ brackets: rows, meta });
  } catch (e) { next(e); }
});

// PUT /api/salary/tax/enabled — quick on/off toggle, doesn't touch brackets
router.put('/salary/tax/enabled', requireAdmin, async (req, res, next) => {
  try {
    const enabled = req.body?.enabled ? 1 : 0;
    const pool = await getDB();
    await pool.execute(
      `INSERT INTO tax_bracket_meta (singleton_key, tax_enabled) VALUES (1, ?)
       ON DUPLICATE KEY UPDATE tax_enabled = VALUES(tax_enabled)`,
      [enabled]
    );
    res.json({ tax_enabled: !!enabled });
  } catch (e) { next(e); }
});

// POST /api/salary/tax/preview — calculate tax for a sample income with current brackets
router.post('/salary/tax/preview', requireAdmin, async (req, res, next) => {
  try {
    const income = Number(req.body?.income);
    if (isNaN(income) || income < 0) return res.status(400).json({ error: 'income must be a non-negative number' });
    const pool = await getDB();
    const brackets = await readBrackets(pool);

    // Surface explicit reasons when the result is 0 — otherwise admins
    // see "₨ 0 · 0% effective rate" with no clue why.
    const meta = await readMeta(pool);
    let note = null;
    if (brackets.length === 0) {
      note = 'No tax brackets configured. Save brackets first (or pick a country in Settings — its preset auto-loads here).';
    } else if (meta && meta.tax_enabled === 0) {
      note = 'Income tax is disabled for this workspace. Enable it at the top of this page to apply brackets.';
    } else if (brackets.every(b => Number(b.rate) === 0)) {
      note = 'All bracket rates are 0% — this workspace is configured as tax-free.';
    }

    const tax = calculateTax(income, brackets);
    res.json({
      income, tax,
      effective_rate: income > 0 ? Math.round((tax / income) * 10000) / 100 : 0,
      note,
      brackets_count: brackets.length,
    });
  } catch (e) { next(e); }
});

module.exports = router;
