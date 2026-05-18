const { getDB } = require('../db');

// ─────────────────────────────────────────────────────────────────────────────
// Per-tenant audit log.
//
// recordAudit(req, { action, target?, before?, after? })
//   action  — string of the form "domain.verb", e.g. "employee.deleted",
//             "integration.slack.saved", "tax.brackets.updated".
//   target  — { type: 'employee', id: 42 } or null.
//   before  — JSON-serializable snapshot before the change. null for create.
//   after   — JSON-serializable snapshot after the change. null for delete.
//
// Audit failures are SWALLOWED (logged to console) so that an audit table
// being missing or unreachable never breaks the underlying business action.
// We'd rather lose an audit entry than block a payroll change.
//
// Reads actor identity from req. Falls back to NULL if the route is
// somehow auth-less (shouldn't happen for the routes we audit, but defensive).
// ─────────────────────────────────────────────────────────────────────────────

const MAX_JSON_BYTES = 65000; // MySQL JSON allows ~1GB but we cap pragmatically

function safeStringify(obj) {
  if (obj == null) return null;
  try {
    const s = JSON.stringify(obj);
    if (s.length > MAX_JSON_BYTES) {
      return JSON.stringify({ _truncated: true, preview: s.slice(0, 1000) });
    }
    return s;
  } catch {
    return null;
  }
}

async function recordAudit(req, { action, target, before, after }) {
  if (!action) return;
  try {
    const pool = await getDB();
    const actor = req?.user || {};
    const ip = req?.ip
      || req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
      || null;
    const ua = (req?.headers?.['user-agent'] || '').slice(0, 500) || null;

    await pool.execute(
      `INSERT INTO audit_logs
         (actor_user_id, actor_email, actor_role, action,
          target_type, target_id, before_json, after_json, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        actor.id || req?.portalUserId || null,
        actor.email || null,
        actor.role || (req?.isSysAdmin ? 'sys-admin' : null),
        action,
        target?.type || null,
        target?.id != null ? String(target.id) : null,
        safeStringify(before),
        safeStringify(after),
        ip,
        ua,
      ]
    );
  } catch (e) {
    // Don't fail the parent request just because audit logging failed.
    // Most common cause: the audit_logs table doesn't exist yet on a freshly
    // upgraded tenant DB — boot-time migrations will fix it on next deploy.
    console.error('[audit] write failed:', e.message);
  }
}

module.exports = { recordAudit };
