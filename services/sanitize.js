// ─────────────────────────────────────────────────────────────────────────────
// Response sanitizers
//
// Strip credential-bearing columns from rows before serializing them to JSON.
// `SELECT pu.*` or `SELECT e.*` is a footgun: every new column added to the
// table silently becomes part of every response. These helpers establish a
// single chokepoint per entity type so a new sensitive column added to the
// schema is opt-in to leakage, not opt-out.
//
// `password_hash` is the obvious one. `invite_token` and `reset_token` are
// also active credentials — possession of either grants account access until
// expiry, so they must never appear in any list/read response. The token is
// returned exactly once at creation time, via an explicit field on that
// specific endpoint (see routes/portal.js POST /portal-users).
//
// `google_sub` is Google's stable user ID; not a credential but unique-PII,
// not useful to clients, and best kept server-side.
// ─────────────────────────────────────────────────────────────────────────────

const PORTAL_USER_SENSITIVE = [
  'password_hash',
  'invite_token',
  'invite_expires_at',
  'reset_token',
  'reset_expires_at',
  'google_sub',
];

const EMPLOYEE_SENSITIVE = [
  'password_hash',
];

function strip(row, keys) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  for (const k of keys) delete out[k];
  return out;
}

function sanitizePortalUser(row)  { return strip(row, PORTAL_USER_SENSITIVE); }
function sanitizePortalUsers(rows) {
  return Array.isArray(rows) ? rows.map(sanitizePortalUser) : rows;
}

function sanitizeEmployee(row)  { return strip(row, EMPLOYEE_SENSITIVE); }
function sanitizeEmployees(rows) {
  return Array.isArray(rows) ? rows.map(sanitizeEmployee) : rows;
}

module.exports = {
  sanitizePortalUser, sanitizePortalUsers,
  sanitizeEmployee,  sanitizeEmployees,
  PORTAL_USER_SENSITIVE,
  EMPLOYEE_SENSITIVE,
};
