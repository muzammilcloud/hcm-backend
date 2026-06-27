// ─────────────────────────────────────────────────────────────────────────────
// Desktop add-on + tracking-enforcement helpers
//
// The Desktop app is a paid add-on. When a tenant has it AND the admin turns on
// `enforce_desktop_tracking` (Workspace Settings), every employee / team-lead
// must have the desktop app open and READY (idle hook running, Accessibility
// granted on macOS) in order to clock in — no matter where they clock in from
// (web, Slack, or the desktop's own button). This guarantees idle time is always
// captured by the desktop. Sys-admins don't track idle and are exempt.
//
// "Running + ready" is proven by a periodic heartbeat the desktop app POSTs to
// /employee/desktop/heartbeat; we store the last beat + ready flag on
// portal_users and consider it active if the beat is fresh.
// ─────────────────────────────────────────────────────────────────────────────

// Test/QA tenants that get Desktop access without buying the add-on.
const DESKTOP_TEST_SLUGS = new Set(
  (process.env.DESKTOP_TEST_SLUGS || 'qa-starter')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
);

// A heartbeat older than this means the desktop app isn't running right now.
const HEARTBEAT_FRESH_MS = 90 * 1000;

// `addons` arrives parsed (web middleware) or as a raw JSON string (Slack reads
// the platform row directly) — normalise both.
function parseAddons(tenant) {
  let a = tenant && tenant.addons;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = []; } }
  return Array.isArray(a) ? a : [];
}

function tenantHasDesktop(tenant) {
  const slug = String(tenant?.slug || '').toLowerCase();
  return parseAddons(tenant).includes('desktop_standard') || DESKTOP_TEST_SLUGS.has(slug);
}

// Is this user's desktop app running AND ready to track idle right now?
async function isDesktopTrackingActive(pool, portalUserId) {
  try {
    const [rows] = await pool.execute(
      'SELECT desktop_ready, desktop_last_seen FROM portal_users WHERE id = ?',
      [portalUserId]
    );
    const u = rows[0];
    if (!u || !u.desktop_ready || !u.desktop_last_seen) return false;
    const age = Date.now() - new Date(u.desktop_last_seen).getTime();
    return age >= 0 && age <= HEARTBEAT_FRESH_MS;
  } catch { return false; }
}

// Decide whether a clock-in should be blocked because desktop tracking is
// required but not active. Returns a {status, body} error to send, or null when
// clock-in is allowed. Fails OPEN on any unexpected error (never locks someone
// out due to a schema/query hiccup).
async function checkDesktopClockInAllowed(pool, tenant, portalUserId) {
  try {
    if (!tenantHasDesktop(tenant)) return null;            // tenant didn't buy desktop
    const [[s]] = await pool.execute(
      'SELECT enforce_desktop_tracking FROM tenant_settings WHERE singleton_key = 1'
    );
    if (!s || !s.enforce_desktop_tracking) return null;    // admin hasn't turned it on

    const [[u]] = await pool.execute(
      'SELECT portal_role FROM portal_users WHERE id = ?', [portalUserId]
    );
    if (String(u?.portal_role || '') === 'sys-admin') return null; // admins exempt

    if (await isDesktopTrackingActive(pool, portalUserId)) return null; // desktop is tracking

    return {
      status: 403,
      body: {
        error: 'Open the Tickin Desktop app and make sure it is tracking (grant the Accessibility permission on macOS, then relaunch) before clocking in.',
        code: 'DESKTOP_REQUIRED',
      },
    };
  } catch {
    return null; // fail open — don't block clock-in on an internal error
  }
}

module.exports = {
  DESKTOP_TEST_SLUGS,
  HEARTBEAT_FRESH_MS,
  tenantHasDesktop,
  isDesktopTrackingActive,
  checkDesktopClockInAllowed,
};
