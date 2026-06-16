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
  const actor = req?.user || {};
  return recordAuditActor({
    actorId:   actor.id || req?.portalUserId || null,
    actorEmail: actor.email || null,
    actorRole:  actor.role || (req?.isSysAdmin ? 'sys-admin' : null),
    ip: req?.ip || req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || null,
    userAgent: (req?.headers?.['user-agent'] || '').slice(0, 500) || null,
    action, target, before, after,
  });
}

// Same audit write, but with an explicitly-supplied actor instead of an Express
// request. Used by non-HTTP paths — e.g. Slack interactive button handlers,
// where the actor is resolved from the Slack user, not a session.
async function recordAuditActor({ actorId = null, actorEmail = null, actorRole = null, ip = null, userAgent = null, action, target, before, after }) {
  if (!action) return;
  try {
    const pool = await getDB();
    await pool.execute(
      `INSERT INTO audit_logs
         (actor_user_id, actor_email, actor_role, action,
          target_type, target_id, before_json, after_json, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        actorId || null,
        actorEmail || null,
        actorRole || null,
        action,
        target?.type || null,
        target?.id != null ? String(target.id) : null,
        safeStringify(before),
        safeStringify(after),
        ip,
        userAgent,
      ]
    );
  } catch (e) {
    // Don't fail the parent action just because audit logging failed.
    console.error('[audit] write failed:', e.message);
  }
}

module.exports = { recordAudit, recordAuditActor };
