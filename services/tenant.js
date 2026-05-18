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
  const [rows] = await db.execute('SELECT id FROM tenants WHERE slug = ? LIMIT 1', [slug]);
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
           trial_ends_at, suspended_at, deleted_at, created_at, updated_at
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

const DEMO_TRIAL_DAYS = Number(process.env.DEMO_TRIAL_DAYS) || 14;

async function provisionTenant({
  slug,
  companyName,
  contactEmail,
  adminName,
  plan = 'demo',
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
    ? new Date(Date.now() + DEMO_TRIAL_DAYS * 24 * 60 * 60 * 1000)
    : null;

  // 1. Insert tenants row in 'provisioning' state — reserves slug atomically
  const [ins] = await platform.execute(
    `INSERT INTO tenants (slug, company_name, db_name, contact_email, status, plan, trial_ends_at)
     VALUES (?, ?, ?, ?, 'provisioning', ?, ?)`,
    [slug, companyName, dbName, contactEmail, plan, trialEnds]
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
  await db.execute(
    `UPDATE tenants SET status = 'deleted', deleted_at = NOW() WHERE id = ?`,
    [tenantId]
  );
  return true;
}

// Update plan (used by Stripe webhook in Phase 2; usable manually for now)
async function setTenantPlan(tenantId, plan) {
  const db = getPlatformDB();
  const trialEndsClause = plan === 'paid' ? ', trial_ends_at = NULL, status = "active"' : '';
  await db.execute(
    `UPDATE tenants SET plan = ?${trialEndsClause} WHERE id = ?`,
    [plan, tenantId]
  );
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

  // lookup
  getTenantBySlug, getTenantById, listTenants,

  // mutations
  provisionTenant, suspendTenant, activateTenant, deleteTenant, setTenantPlan,

  // audit
  audit,

  // constants
  DEMO_TRIAL_DAYS,
};
