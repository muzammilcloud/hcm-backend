const express = require('express');
const router  = express.Router();
const { getDB } = require('../db');
const { requireAdmin } = require('../middleware/auth');

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/audit
// Paginated, filterable timeline of audit events for the current tenant.
// Sys-admin only.
//
// Query params:
//   action       — exact match OR prefix match if ending in *
//                  (e.g. "integration.*" matches "integration.slack.saved")
//   actor_email  — substring match
//   target_type  — exact match
//   from         — ISO date string, inclusive
//   to           — ISO date string, exclusive (next day)
//   page         — 1-based, default 1
//   page_size    — default 50, max 200
// ─────────────────────────────────────────────────────────────────────────────

router.get('/audit', requireAdmin, async (req, res, next) => {
  try {
    const {
      action, actor_email, target_type, from, to,
    } = req.query;
    const page      = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize  = Math.min(200, Math.max(1, parseInt(req.query.page_size, 10) || 50));
    const offset    = (page - 1) * pageSize;

    const where = [];
    const params = [];

    if (action) {
      if (action.endsWith('*')) {
        where.push('action LIKE ?');
        params.push(action.slice(0, -1) + '%');
      } else {
        where.push('action = ?');
        params.push(action);
      }
    }
    if (actor_email) {
      where.push('actor_email LIKE ?');
      params.push(`%${actor_email}%`);
    }
    if (target_type) {
      where.push('target_type = ?');
      params.push(target_type);
    }
    if (from) {
      where.push('created_at >= ?');
      params.push(from);
    }
    if (to) {
      where.push('created_at < ?');
      params.push(to);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const pool = await getDB();

    const [rows] = await pool.execute(
      `SELECT id, actor_user_id, actor_email, actor_role,
              action, target_type, target_id,
              before_json, after_json, ip, user_agent, created_at
       FROM audit_logs ${whereSql}
       ORDER BY created_at DESC, id DESC
       LIMIT ${pageSize} OFFSET ${offset}`,
      params
    );

    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS total FROM audit_logs ${whereSql}`,
      params
    );

    // Distinct actions + target_types for filter dropdowns (cheap, indexed)
    const [actions] = await pool.execute(
      `SELECT DISTINCT action FROM audit_logs ORDER BY action`
    );
    const [targetTypes] = await pool.execute(
      `SELECT DISTINCT target_type FROM audit_logs WHERE target_type IS NOT NULL ORDER BY target_type`
    );

    // before_json / after_json come back as parsed JS objects via mysql2 when
    // the column is JSON. We keep them as-is for the client.
    res.json({
      rows,
      total: countRows[0].total,
      page,
      page_size: pageSize,
      facets: {
        actions:      actions.map(r => r.action),
        target_types: targetTypes.map(r => r.target_type),
      },
    });
  } catch (e) { next(e); }
});

module.exports = router;
