const express = require('express');
const router  = express.Router();
const { getDB } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { requireFeature } = require('../middleware/features');

// Mutation routes (create / update / delete / reorder) require the
// custom_salary_components feature. GET is unconditional so Starter
// admins can still see what's configured at the workspace level.
const gateMutations = requireFeature('custom_salary_components');

// ─────────────────────────────────────────────────────────────────────────────
// Validation helpers
// ─────────────────────────────────────────────────────────────────────────────
const KINDS    = new Set(['earning', 'deduction']);
const METHODS  = new Set(['fixed', 'percent_of_basic', 'percent_of_gross', 'percent_of_ctc']);

function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50);
}

function validate(body, { allowSystemManaged = false } = {}) {
  const errors = [];
  const { name, kind, calc_method, amount, percent, cap_amount } = body;

  if (!name || String(name).trim().length < 2) errors.push('name (min 2 chars)');
  if (!KINDS.has(kind))      errors.push('kind (earning|deduction)');
  if (!METHODS.has(calc_method)) errors.push('calc_method');

  if (calc_method === 'fixed') {
    if (amount == null || isNaN(+amount) || +amount < 0) errors.push('amount must be a non-negative number for fixed method');
  } else {
    if (percent == null || isNaN(+percent) || +percent < 0 || +percent > 100) {
      errors.push('percent must be 0–100 for percent_of_* methods');
    }
  }

  if (cap_amount != null && cap_amount !== '' && (isNaN(+cap_amount) || +cap_amount < 0)) {
    errors.push('cap_amount must be a non-negative number');
  }

  return errors;
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/salary/components — list (active first, then by sort_order then name)
router.get('/salary/components', requireAdmin, async (req, res, next) => {
  try {
    const pool = await getDB();
    const [rows] = await pool.execute(`
      SELECT id, code, name, kind, calc_method, amount, percent, cap_amount,
             taxable, show_on_slip, sort_order, system_managed, active,
             created_at, updated_at
      FROM salary_components
      ORDER BY active DESC, sort_order ASC, name ASC
    `);
    res.json({ components: rows });
  } catch (e) { next(e); }
});

// POST /api/salary/components — create
router.post('/salary/components', requireAdmin, gateMutations, async (req, res, next) => {
  try {
    const errors = validate(req.body);
    if (errors.length) return res.status(400).json({ error: 'Invalid input', details: errors });

    const pool = await getDB();
    const {
      name, kind, calc_method,
      amount = null, percent = null, cap_amount = null,
      taxable = false, show_on_slip = true, sort_order,
    } = req.body;

    // Derive a unique code from the name
    const base = slugify(name) || 'component';
    let code = base;
    for (let i = 2; i < 100; i++) {
      const [exists] = await pool.execute('SELECT 1 FROM salary_components WHERE code = ?', [code]);
      if (exists.length === 0) break;
      code = `${base}_${i}`;
    }

    // Default sort_order: end of list
    let order = sort_order;
    if (order == null) {
      const [[{ max_order }]] = await pool.execute(
        `SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM salary_components`
      );
      order = Number(max_order) + 10;
    }

    const [ins] = await pool.execute(
      `INSERT INTO salary_components
         (code, name, kind, calc_method, amount, percent, cap_amount,
          taxable, show_on_slip, sort_order, system_managed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        code, String(name).trim(), kind, calc_method,
        calc_method === 'fixed' ? Number(amount)  : null,
        calc_method !== 'fixed' ? Number(percent) : null,
        cap_amount === '' || cap_amount == null ? null : Number(cap_amount),
        taxable ? 1 : 0, show_on_slip ? 1 : 0, order,
      ]
    );

    const [[row]] = await pool.execute('SELECT * FROM salary_components WHERE id = ?', [ins.insertId]);
    res.status(201).json(row);
  } catch (e) { next(e); }
});

// PUT /api/salary/components/:id — update
router.put('/salary/components/:id', requireAdmin, gateMutations, async (req, res, next) => {
  try {
    const pool = await getDB();
    const [rows] = await pool.execute('SELECT * FROM salary_components WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Component not found' });
    const existing = rows[0];

    // Allow renaming + reorder + active toggle on system-managed; block
    // changing kind/method on system components.
    if (existing.system_managed) {
      const lockedFields = ['kind', 'calc_method'];
      for (const f of lockedFields) {
        if (req.body[f] != null && req.body[f] !== existing[f]) {
          return res.status(400).json({ error: `Cannot change ${f} on a system-managed component` });
        }
      }
    }

    const merged = { ...existing, ...req.body };
    const errors = validate(merged);
    if (errors.length) return res.status(400).json({ error: 'Invalid input', details: errors });

    const {
      name, kind, calc_method,
      amount, percent, cap_amount,
      taxable, show_on_slip, sort_order, active,
    } = merged;

    await pool.execute(
      `UPDATE salary_components SET
         name = ?, kind = ?, calc_method = ?,
         amount = ?, percent = ?, cap_amount = ?,
         taxable = ?, show_on_slip = ?, sort_order = ?, active = ?
       WHERE id = ?`,
      [
        String(name).trim(), kind, calc_method,
        calc_method === 'fixed' ? Number(amount)  : null,
        calc_method !== 'fixed' ? Number(percent) : null,
        cap_amount === '' || cap_amount == null ? null : Number(cap_amount),
        taxable ? 1 : 0, show_on_slip ? 1 : 0,
        Number(sort_order) || 0,
        active ? 1 : 0,
        req.params.id,
      ]
    );

    const [[updated]] = await pool.execute('SELECT * FROM salary_components WHERE id = ?', [req.params.id]);
    res.json(updated);
  } catch (e) { next(e); }
});

// DELETE /api/salary/components/:id — delete (refuses system-managed)
router.delete('/salary/components/:id', requireAdmin, gateMutations, async (req, res, next) => {
  try {
    const pool = await getDB();
    const [rows] = await pool.execute('SELECT * FROM salary_components WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Component not found' });
    if (rows[0].system_managed) {
      return res.status(400).json({ error: 'This component is required and cannot be deleted. You can rename it or deactivate it instead.' });
    }
    await pool.execute('DELETE FROM salary_components WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /api/salary/components/reorder — accepts { order: [ids...] }
router.post('/salary/components/reorder', requireAdmin, gateMutations, async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.order) ? req.body.order : null;
    if (!ids || ids.length === 0) return res.status(400).json({ error: 'order must be a non-empty array of component ids' });

    const pool = await getDB();
    for (let i = 0; i < ids.length; i++) {
      await pool.execute(
        `UPDATE salary_components SET sort_order = ? WHERE id = ?`,
        [(i + 1) * 10, Number(ids[i])]
      );
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
