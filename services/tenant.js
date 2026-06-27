const {
  getServerDB,
  getPlatformDB,
  getTenantDB,
  tenantDbName,
  tenantContext,
  hashPassword,
  generateToken,
} = require('../db');
const { initTenantSchema } = require('../db/init');

// ─────────────────────────────────────────────────────────────────────────────
// Reserved subdomains — these cannot be claimed by signups.
//
// Note: 'app' is here (no new tenant can claim it) but the migration script
// inserts a row for it in `tenants` — so middleware can still resolve it as
// a real tenant. Same model applies to any future "house" tenant.
// ─────────────────────────────────────────────────────────────────────────────
const RESERVED_SUBDOMAINS = new Set([
  // platform
  'app', 'admin', 'api', 'www', 'mail', 'static', 'assets', 'cdn',
  'help', 'docs', 'status', 'blog', 'demo', 'support', 'auth',
  'platform', 'console', 'dashboard', 'portal',
  // common SaaS
  'about', 'contact', 'pricing', 'features', 'login', 'signup', 'register',
  'home', 'terms', 'privacy', 'security', 'legal',
  // ops / infra
  'ftp', 'sftp', 'smtp', 'ns', 'ns1', 'ns2', 'mx', 'webmail', 'email',
  // brand protection
  'tickin', 'official', 'team', 'no-reply', 'noreply', 'system',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Platform subdomains — these never resolve to a tenant. Tenant middleware
// skips lookup for these and lets requests fall through to the platform DB.
// Much shorter than the reserved list: `app` is NOT here because it IS a
// tenant (created by the migration).
// ─────────────────────────────────────────────────────────────────────────────
const PLATFORM_SUBDOMAINS = new Set([
  'www', 'api', 'admin', 'mail', 'cdn', 'static', 'assets',
  'ftp', 'sftp', 'smtp', 'ns', 'ns1', 'ns2', 'mx', 'webmail', 'email',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Multi-session tenants
//
// Default behaviour is ONE active session per user: each successful login
// revokes the user's prior sessions, so signing in on a second device logs the
// first out. Tenants listed here opt out, letting the same account stay logged
// in from several devices/tabs at once. qa-starter does so for QA (driving
// multiple roles/devices in parallel). Override via MULTI_SESSION_SLUGS
// (comma-separated slugs).
// ─────────────────────────────────────────────────────────────────────────────
const MULTI_SESSION_SLUGS = new Set(
  (process.env.MULTI_SESSION_SLUGS || 'qa-starter')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
);

// Accepts a tenant object ({ slug }) or a raw slug string.
function allowsMultipleSessions(tenantOrSlug) {
  const slug = typeof tenantOrSlug === 'string' ? tenantOrSlug : (tenantOrSlug?.slug || '');
  return MULTI_SESSION_SLUGS.has(String(slug).toLowerCase().trim());
}

function isPlatformSubdomain(slug) {
  return typeof slug === 'string' && PLATFORM_SUBDOMAINS.has(slug);
}

// ─────────────────────────────────────────────────────────────────────────────
// Slug helpers
// ─────────────────────────────────────────────────────────────────────────────

// Convert a company name into a candidate subdomain
//   "Acme Corp." → "acme-corp"
//   "Foo & Bar 2!" → "foo-bar-2"
function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

// Subdomain syntax rules (RFC 1035): lowercase alphanumerics and hyphens,
// 1–63 chars, must start and end with alphanumeric.
function isValidSlug(slug) {
  if (typeof slug !== 'string') return false;
  if (slug.length < 2 || slug.length > 63) return false;
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug);
}

function isReservedSlug(slug) {
  return RESERVED_SUBDOMAINS.has(slug);
}

async function isSlugAvailable(slug) {
  if (!isValidSlug(slug) || isReservedSlug(slug)) return false;
  const db = getPlatformDB();
  // Deleted tenants (trial ended, never converted, data purged) release their
  // subdomain: only a live (non-deleted) row holds a slug. The canonical
  // slug/db_name are vacated on delete (see deleteTenant), but we filter on
  // deleted_at too so any legacy deleted row that still holds the slug doesn't
  // block it — provisionTenant vacates such rows just before INSERT.
  const [rows] = await db.execute(
    'SELECT id FROM tenants WHERE slug = ? AND deleted_at IS NULL LIMIT 1',
    [slug]
  );
  return rows.length === 0;
}

async function findFreeSlug(baseSlug) {
  let candidate = baseSlug;
  if (await isSlugAvailable(candidate)) return candidate;
  for (let i = 2; i < 100; i++) {
    candidate = `${baseSlug}-${i}`.slice(0, 63);
    if (await isSlugAvailable(candidate)) return candidate;
  }
  throw new Error(`Could not find an available slug derived from "${baseSlug}"`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tenant lookup
// ─────────────────────────────────────────────────────────────────────────────

async function getTenantBySlug(slug) {
  const db = getPlatformDB();
  const [rows] = await db.execute(
    'SELECT * FROM tenants WHERE slug = ? LIMIT 1',
    [slug]
  );
  return rows[0] || null;
}

async function getTenantById(id) {
  const db = getPlatformDB();
  const [rows] = await db.execute(
    'SELECT * FROM tenants WHERE id = ? LIMIT 1',
    [id]
  );
  return rows[0] || null;
}

async function listTenants({ status, plan, limit = 100, offset = 0 } = {}) {
  const db = getPlatformDB();
  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (plan)   { where.push('plan = ?');   params.push(plan); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sql = `
    SELECT id, slug, company_name, db_name, contact_email, status, plan,
           trial_ends_at, suspended_at, deleted_at, created_at, updated_at, metadata
    FROM tenants
    ${whereSql}
    ORDER BY created_at DESC
    LIMIT ${Number(limit)} OFFSET ${Number(offset)}
  `;
  const [rows] = await db.execute(sql, params);
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Provisioning
// ─────────────────────────────────────────────────────────────────────────────

// Free-trial length. Advertised as 14 days everywhere (pricing page, signup,
// guide), so 14 is the source of truth. The legacy DEMO_TRIAL_DAYS knob is
// intentionally ignored: production inherited DEMO_TRIAL_DAYS=7 from
// .env.example, which silently gave new customers a 7-day trial that
// contradicted the advertised 14. A demo/test override is still possible via
// the new TRIAL_DAYS var (unset in production → 14).
const TRIAL_DAYS = Number(process.env.TRIAL_DAYS) || 14;

async function provisionTenant({
  slug,
  companyName,
  contactEmail,
  adminName,
  plan = 'free',      // new tenants start on the free-forever plan (no trial)
  trialTier = null,   // legacy: only set for old demo trials
}) {
  if (!isValidSlug(slug))    throw Object.assign(new Error('Invalid subdomain'), { code: 'INVALID_SLUG' });
  if (isReservedSlug(slug))  throw Object.assign(new Error('That subdomain is reserved'), { code: 'RESERVED_SLUG' });
  if (!(await isSlugAvailable(slug))) {
    throw Object.assign(new Error('That subdomain is taken'), { code: 'SLUG_TAKEN' });
  }
  if (!companyName)  throw new Error('companyName required');
  if (!contactEmail) throw new Error('contactEmail required');

  const dbName  = tenantDbName(slug);
  const platform = getPlatformDB();
  const trialEnds = plan === 'demo'
    ? new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000)
    : null;

  // Only record a trial tier for trials; paid plans derive features from `plan`.
  const normalizedTier = (plan === 'demo' || plan === 'trial')
    ? (['starter', 'growth'].includes(String(trialTier)) ? trialTier : null)
    : null;

  // 0. Vacate any DELETED tenant still holding this slug/db_name. Deleted rows
  //    are kept for the audit trail, but their data is gone — so the subdomain
  //    is free to reclaim. slug/db_name are UNIQUE, so the stale row must be
  //    moved aside (originals preserved in metadata) or the INSERT below would
  //    hit the constraint. Going forward deleteTenant vacates eagerly; this
  //    also covers rows deleted before that behavior existed.
  await platform.execute(
    `UPDATE tenants
        SET metadata = JSON_SET(COALESCE(metadata, JSON_OBJECT()),
                                '$.released_slug', slug,
                                '$.released_db_name', db_name),
            slug    = CONCAT(LEFT(slug, 50), '~d', id),
            db_name = CONCAT(LEFT(db_name, 50), '~d', id)
      WHERE (slug = ? OR db_name = ?) AND deleted_at IS NOT NULL`,
    [slug, dbName]
  );

  // 1. Insert tenants row in 'provisioning' state — reserves slug atomically
  const [ins] = await platform.execute(
    `INSERT INTO tenants (slug, company_name, db_name, contact_email, status, plan, trial_tier, trial_ends_at)
     VALUES (?, ?, ?, ?, 'provisioning', ?, ?, ?)`,
    [slug, companyName, dbName, contactEmail, plan, normalizedTier, trialEnds]
  );
  const tenantId = ins.insertId;

  try {
    // 2. CREATE DATABASE tickin_<slug>
    const server = getServerDB();
    await server.execute(
      `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );

    // 3. Run the full tenant schema against the new DB
    const tenantPool = getTenantDB(dbName);
    await initTenantSchema(tenantPool);

    // 4. Seed an admin in portal_users for this tenant. The user will receive
    //    an invite email and set their password via /set-password?token=...
    //    invite_expires_at must be set — the activation route checks
    //    "invite_expires_at > NOW()" and treats NULL as expired.
    const inviteToken   = generateToken();
    const inviteExpiry  = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days, matches existing invite convention
    const placeholderPw = hashPassword(generateToken());  // throwaway; gets replaced on activation
    const displayName   = adminName || contactEmail.split('@')[0];

    // 4a. Also seed a matching employees row so the admin appears in every
    //     people-picker (Reports To selector, Reports page filters, etc.).
    //     The admin can re-categorize / rename later; this just makes the
    //     dropdowns useful from day one.
    let employeeId = null;
    try {
      const [empIns] = await tenantPool.execute(
        `INSERT INTO employees (name, email, role, department, is_active, employment_status)
         VALUES (?, ?, 'Admin', 'Management', 1, 'permanent')
         ON DUPLICATE KEY UPDATE name = VALUES(name)`,
        [displayName, contactEmail]
      );
      employeeId = empIns.insertId || null;
      if (!employeeId) {
        // Already existed (ON DUPLICATE KEY) — look it up
        const [rows] = await tenantPool.execute(
          `SELECT id FROM employees WHERE email = ? LIMIT 1`,
          [contactEmail]
        );
        employeeId = rows[0]?.id || null;
      }
    } catch (e) {
      console.warn('[provisionTenant] failed to seed employees row:', e.message);
    }

    await tenantPool.execute(
      `INSERT INTO portal_users (email, name, password_hash, portal_role, status, invite_token, invite_expires_at, employee_id)
       VALUES (?, ?, ?, 'sys-admin', 'pending', ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         invite_token = VALUES(invite_token),
         invite_expires_at = VALUES(invite_expires_at),
         status = 'pending',
         employee_id = COALESCE(employee_id, VALUES(employee_id))`,
      [contactEmail, displayName, placeholderPw, inviteToken, inviteExpiry, employeeId]
    );

    // 5. Flip tenant to active
    await platform.execute(
      `UPDATE tenants SET status = 'active' WHERE id = ?`,
      [tenantId]
    );

    return {
      tenantId,
      slug,
      dbName,
      inviteToken,
      trialEndsAt: trialEnds,
      portalUrl: `https://${slug}.tickin.pro`,
      setPasswordUrl: `https://${slug}.tickin.pro/set-password?token=${inviteToken}`,
    };
  } catch (err) {
    // Roll back atomically: drop the half-provisioned DB AND hard-delete the
    // tenants row. The slug + db_name UNIQUE constraints would otherwise
    // block retrying the same name. Audit trail of failed attempts lives in
    // tenant_signups (status='failed', error=<msg>), not in tenants.
    try {
      await getServerDB().execute(`DROP DATABASE IF EXISTS \`${dbName}\``);
    } catch (_) {}
    try {
      await platform.execute(`DELETE FROM tenants WHERE id = ?`, [tenantId]);
    } catch (_) {}
    throw err;
  }
}

async function suspendTenant(tenantId) {
  const db = getPlatformDB();
  await db.execute(
    `UPDATE tenants SET status = 'suspended', suspended_at = NOW() WHERE id = ?`,
    [tenantId]
  );
}

async function activateTenant(tenantId) {
  const db = getPlatformDB();
  await db.execute(
    `UPDATE tenants SET status = 'active', suspended_at = NULL WHERE id = ?`,
    [tenantId]
  );
}

// Hard delete: drops the tenant's DB and marks the row deleted.
// This is the action that runs after a demo's grace period expires.
//
// The row is kept (soft-deleted) for the audit trail, but the subdomain is
// released: a deleted tenant no longer owns its slug, so it becomes available
// for a fresh signup. Because slug + db_name are UNIQUE, we can't just leave
// them on the dead row — we move the canonical values aside (the originals are
// preserved in metadata.released_slug / released_db_name, and the admin panel
// still shows the original name for the deleted record).
async function deleteTenant(tenantId) {
  const db = getPlatformDB();
  const tenant = await getTenantById(tenantId);
  if (!tenant) return false;
  if (tenant.deleted_at) return true;  // already deleted

  try {
    await getServerDB().execute(`DROP DATABASE IF EXISTS \`${tenant.db_name}\``);
  } catch (e) {
    console.error(`[deleteTenant] failed to drop ${tenant.db_name}:`, e.message);
  }
  // Mark deleted AND vacate slug/db_name so the subdomain frees up. metadata is
  // set first so it captures the originals before slug/db_name are reassigned
  // (MySQL evaluates SET assignments left to right). The "~d<id>" suffix is
  // guaranteed unique by the row id, satisfying the UNIQUE constraints.
  await db.execute(
    `UPDATE tenants
        SET metadata = JSON_SET(COALESCE(metadata, JSON_OBJECT()),
                                '$.released_slug', slug,
                                '$.released_db_name', db_name,
                                '$.released_at', CAST(NOW() AS CHAR)),
            status = 'deleted', deleted_at = NOW(),
            slug    = CONCAT(LEFT(slug, 50), '~d', id),
            db_name = CONCAT(LEFT(db_name, 50), '~d', id)
      WHERE id = ?`,
    [tenantId]
  );
  return true;
}

// Update plan (used by Stripe webhook in Phase 2; usable manually for now)
async function setTenantPlan(tenantId, plan) {
  const db = getPlatformDB();
  // Free and any paid tier are committed states (not trials): clear the trial
  // window and ensure the workspace is active. 'demo'/'trial' keep their window.
  const committed = plan !== 'demo' && plan !== 'trial';
  const trialEndsClause = committed ? ', trial_ends_at = NULL, status = "active"' : '';
  await db.execute(
    `UPDATE tenants SET plan = ?${trialEndsClause} WHERE id = ?`,
    [plan, tenantId]
  );
}

// Switch which tier a TRIAL is evaluating (Starter vs Growth). Only meaningful
// while the tenant is on a demo/trial plan; ignored for paid tenants, whose
// features come from `plan`. Returns true if a row was updated.
async function setTrialTier(tenantId, tier) {
  if (!['starter', 'growth'].includes(String(tier))) {
    throw Object.assign(new Error('Invalid tier'), { code: 'INVALID_TIER' });
  }
  const db = getPlatformDB();
  const [res] = await db.execute(
    `UPDATE tenants SET trial_tier = ? WHERE id = ? AND plan IN ('demo','trial')`,
    [tier, tenantId]
  );
  return res.affectedRows > 0;
}

// Audit log helper — written from any actor (platform admin, system cron, tenant)
async function audit({ actorType, actorId, tenantId, action, detail, ip }) {
  try {
    const db = getPlatformDB();
    await db.execute(
      `INSERT INTO platform_audit_log (actor_type, actor_id, tenant_id, action, detail, ip_address)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [actorType, actorId || null, tenantId || null, action, detail ? JSON.stringify(detail) : null, ip || null]
    );
  } catch (e) {
    console.error('[audit] log failed:', e.message);
  }
}

module.exports = {
  // slug
  slugify, isValidSlug, isReservedSlug, isSlugAvailable, findFreeSlug,
  isPlatformSubdomain,
  RESERVED_SUBDOMAINS, PLATFORM_SUBDOMAINS,

  // sessions
  allowsMultipleSessions,

  // lookup
  getTenantBySlug, getTenantById, listTenants,

  // mutations
  provisionTenant, suspendTenant, activateTenant, deleteTenant, setTenantPlan, setTrialTier,

  // audit
  audit,

  // constants
  TRIAL_DAYS,
};
