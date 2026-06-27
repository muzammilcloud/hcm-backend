const express = require('express');
const router  = express.Router();
const {
  getPlatformDB,
  getTenantDB,
  verifyPassword,
  hashPassword,
  generateToken,
} = require('../db');
const {
  listTenants,
  getTenantById,
  getTenantBySlug,
  isSlugAvailable,
  isValidSlug,
  isReservedSlug,
  slugify,
  findFreeSlug,
  provisionTenant,
  suspendTenant,
  activateTenant,
  deleteTenant,
  setTenantPlan,
  audit,
} = require('../services/tenant');
const { requirePlatformAdmin } = require('../middleware/platformAuth');
const { sendInviteEmail } = require('../services/email');
const { planOf } = require('../services/features');

// Decorate a tenant row for the admin UI with the resolved billing picture:
//   is_trial      — still on a demo/trial (vs. a paying customer)
//   effective_tier — the tier whose features actually apply right now
//                    (trial → the tier they're evaluating; paid → their plan)
function decorateTenant(t) {
  if (!t) return t;
  const raw = String(t.plan || '').toLowerCase();
  // A deleted tenant's slug/db_name are vacated so the subdomain frees up
  // (see services/tenant.deleteTenant); the originals live in metadata. Show
  // those originals in the admin so the deleted record still reads cleanly
  // (e.g. "sudo-consultants", not "sudo-consultants~d42").
  const meta = t.metadata || {};
  const slug    = meta.released_slug    || t.slug;
  const db_name = meta.released_db_name || t.db_name;
  const isTrial = raw === 'demo' || raw === 'trial';
  const isFree  = raw === 'free' || raw === '';
  return {
    ...t, slug, db_name,
    slug_released: !!meta.released_slug,
    is_trial: isTrial,
    // Explicit billing phase so the admin UI shows Free / Trial / Paid exactly,
    // instead of treating "anything not a trial" as paid.
    billing_phase: isTrial ? 'trial' : (isFree ? 'free' : 'paid'),
    effective_tier: planOf(t),
  };
}

// ─── Auth ────────────────────────────────────────────────────────────────────

router.post('/platform/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const db = getPlatformDB();
    const [rows] = await db.execute(
      'SELECT * FROM platform_admins WHERE LOWER(email) = LOWER(?) LIMIT 1',
      [email]
    );
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const admin = rows[0];

    const { ok } = verifyPassword(password, admin.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token     = generateToken();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
    // Prune this admin's already-expired sessions (housekeeping); does NOT touch
    // active ones, so the console stays logged in across devices/tabs.
    try { await db.execute('DELETE FROM platform_sessions WHERE platform_admin_id = ? AND expires_at < NOW()', [admin.id]); } catch (_) {}
    await db.execute(
      'INSERT INTO platform_sessions (platform_admin_id, token, expires_at) VALUES (?, ?, ?)',
      [admin.id, token, expiresAt]
    );
    await db.execute('UPDATE platform_admins SET last_login_at = NOW() WHERE id = ?', [admin.id]);
    audit({ actorType: 'platform_admin', actorId: admin.id, action: 'platform.login', ip: req.ip });

    res.json({
      token,
      expires_at: expiresAt,
      admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role },
    });
  } catch (e) { next(e); }
});

router.post('/platform/logout', requirePlatformAdmin, async (req, res, next) => {
  try {
    const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
    await getPlatformDB().execute('DELETE FROM platform_sessions WHERE token = ?', [token]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/platform/me', requirePlatformAdmin, async (req, res) => {
  res.json(req.platformAdmin);
});

// ─── Tenants — list / detail / mutate ────────────────────────────────────────

router.get('/platform/tenants', requirePlatformAdmin, async (req, res, next) => {
  try {
    const { status, plan, limit, offset } = req.query;
    const tenants = await listTenants({
      status, plan,
      limit:  Math.min(Number(limit)  || 50, 200),
      offset: Math.max(Number(offset) || 0, 0),
    });
    res.json({ tenants: tenants.map(decorateTenant) });
  } catch (e) { next(e); }
});

router.get('/platform/tenants/:id', requirePlatformAdmin, async (req, res, next) => {
  try {
    const tenant = await getTenantById(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    res.json(decorateTenant(tenant));
  } catch (e) { next(e); }
});

// GET /platform/tenants/:id/usage — live usage/activity pulled from the tenant's
// own DB: how many users they've created and whether they're actually using it.
router.get('/platform/tenants/:id/usage', requirePlatformAdmin, async (req, res, next) => {
  try {
    const tenant = await getTenantById(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    if (!tenant.db_name || tenant.status === 'deleted') return res.json({ available: false });

    const pool = getTenantDB(tenant.db_name);
    const one = (sql) => pool.execute(sql).then(([r]) => r[0] || {}).catch(() => ({}));

    const [emp, pu, te, idle] = await Promise.all([
      one(`SELECT COUNT(*) total, COALESCE(SUM(is_active=1),0) active FROM employees`),
      one(`SELECT COUNT(*) total,
                  COALESCE(SUM(portal_role='sys-admin'),0) admins,
                  COALESCE(SUM(portal_role='team-lead'),0) team_leads,
                  COALESCE(SUM(status='pending'),0) pending
             FROM portal_users`),
      one(`SELECT COUNT(*) total,
                  COALESCE(SUM(clock_in >= DATE_SUB(NOW(), INTERVAL 7 DAY)),0)  clock_ins_7d,
                  COALESCE(SUM(clock_in >= DATE_SUB(NOW(), INTERVAL 30 DAY)),0) clock_ins_30d,
                  COALESCE(SUM(clock_out IS NULL),0) clocked_in_now,
                  MAX(clock_in) last_clock_in,
                  COUNT(DISTINCT CASE WHEN clock_in >= DATE_SUB(NOW(), INTERVAL 7 DAY)  THEN portal_user_id END) active_users_7d,
                  COUNT(DISTINCT CASE WHEN clock_in >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN portal_user_id END) active_users_30d
             FROM portal_time_entries`),
      one(`SELECT COALESCE(SUM(duration_minutes),0) minutes, COUNT(*) sessions
             FROM idle_sessions WHERE idle_start >= DATE_SUB(NOW(), INTERVAL 30 DAY)`),
    ]);

    const n = (v) => Number(v || 0);
    res.json({
      available: true,
      employees:    { total: n(emp.total), active: n(emp.active) },
      portal_users: { total: n(pu.total), admins: n(pu.admins), team_leads: n(pu.team_leads), pending: n(pu.pending) },
      activity: {
        total_sessions:  n(te.total),
        clock_ins_7d:    n(te.clock_ins_7d),
        clock_ins_30d:   n(te.clock_ins_30d),
        clocked_in_now:  n(te.clocked_in_now),
        active_users_7d: n(te.active_users_7d),
        active_users_30d:n(te.active_users_30d),
        last_clock_in:   te.last_clock_in || null,
      },
      idle_30d: { minutes: n(idle.minutes), sessions: n(idle.sessions) },
    });
  } catch (e) { next(e); }
});

router.post('/platform/tenants', requirePlatformAdmin, async (req, res, next) => {
  try {
    const { slug, companyName, contactEmail, adminName, plan } = req.body || {};
    const finalSlug = slug || slugify(companyName);
    const result = await provisionTenant({
      slug:          finalSlug,
      companyName,
      contactEmail,
      adminName,
      plan:          plan || 'demo',
    });
    audit({
      actorType: 'platform_admin', actorId: req.platformAdmin.id,
      tenantId: result.tenantId, action: 'tenant.create',
      detail: { slug: result.slug }, ip: req.ip,
    });

    // Fire-and-forget invite email
    sendInviteEmail({
      to: contactEmail,
      name: adminName || contactEmail.split('@')[0],
      inviteUrl: result.setPasswordUrl,
      companyName,
    }).catch((e) => console.error('[invite email] failed:', e.message));

    res.status(201).json(result);
  } catch (e) {
    if (e.code === 'SLUG_TAKEN' || e.code === 'INVALID_SLUG' || e.code === 'RESERVED_SLUG') {
      return res.status(400).json({ error: e.message, code: e.code });
    }
    next(e);
  }
});

router.post('/platform/tenants/:id/suspend', requirePlatformAdmin, async (req, res, next) => {
  try {
    await suspendTenant(req.params.id);
    audit({ actorType: 'platform_admin', actorId: req.platformAdmin.id, tenantId: Number(req.params.id), action: 'tenant.suspend', ip: req.ip });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/platform/tenants/:id/activate', requirePlatformAdmin, async (req, res, next) => {
  try {
    await activateTenant(req.params.id);
    audit({ actorType: 'platform_admin', actorId: req.platformAdmin.id, tenantId: Number(req.params.id), action: 'tenant.activate', ip: req.ip });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/platform/tenants/:id/plan', requirePlatformAdmin, async (req, res, next) => {
  try {
    const { plan } = req.body || {};
    // 'trial' dropped — it was a duplicate of 'demo'. Accept the legacy value
    // for backward-compat but normalise it to 'demo'. The admin can set any real
    // tier (free / starter / growth / business) plus the legacy 'paid'/'demo'.
    const normalized = plan === 'trial' ? 'demo' : plan;
    const VALID = ['free', 'demo', 'paid', 'starter', 'growth', 'business'];
    if (!VALID.includes(normalized)) return res.status(400).json({ error: 'Invalid plan' });
    await setTenantPlan(req.params.id, normalized);
    audit({ actorType: 'platform_admin', actorId: req.platformAdmin.id, tenantId: Number(req.params.id), action: 'tenant.plan.change', detail: { plan: normalized }, ip: req.ip });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/platform/tenants/:id', requirePlatformAdmin, async (req, res, next) => {
  try {
    const ok = await deleteTenant(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Tenant not found' });
    audit({ actorType: 'platform_admin', actorId: req.platformAdmin.id, tenantId: Number(req.params.id), action: 'tenant.delete', ip: req.ip });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ─── Dashboard stats ─────────────────────────────────────────────────────────

router.get('/platform/stats', requirePlatformAdmin, async (req, res, next) => {
  try {
    const db = getPlatformDB();
    const [[counts]] = await db.execute(`
      SELECT
        SUM(status = 'active')       AS active,
        SUM(status = 'suspended')    AS suspended,
        SUM(status = 'provisioning') AS provisioning,
        SUM(status = 'expired')      AS expired,
        SUM(plan = 'free')                                   AS free,
        SUM(plan IN ('demo', 'trial'))                       AS demo,
        SUM(plan IN ('paid', 'starter', 'growth', 'business')) AS paid,
        COUNT(*)                     AS total
      FROM tenants
      WHERE deleted_at IS NULL
    `);
    const [recent] = await db.execute(`
      SELECT id, slug, company_name, status, plan, trial_ends_at, created_at
      FROM tenants
      ORDER BY created_at DESC
      LIMIT 10
    `);
    const [endingSoon] = await db.execute(`
      SELECT id, slug, company_name, contact_email, plan, trial_ends_at
      FROM tenants
      WHERE plan IN ('demo', 'trial') AND status = 'active'
        AND trial_ends_at IS NOT NULL AND trial_ends_at <= DATE_ADD(NOW(), INTERVAL 3 DAY)
      ORDER BY trial_ends_at ASC
      LIMIT 10
    `);
    res.json({ counts, recent, endingSoon });
  } catch (e) { next(e); }
});

// ─── Signups list ────────────────────────────────────────────────────────────

router.get('/platform/signups', requirePlatformAdmin, async (req, res, next) => {
  try {
    const db = getPlatformDB();
    const [rows] = await db.execute(`
      SELECT id, tenant_id, first_name, last_name, email, company, requested_slug,
             team_size, status, error, created_at
      FROM tenant_signups
      ORDER BY created_at DESC
      LIMIT 100
    `);
    res.json({ signups: rows });
  } catch (e) { next(e); }
});

// ─── Audit log ───────────────────────────────────────────────────────────────

router.get('/platform/audit', requirePlatformAdmin, async (req, res, next) => {
  try {
    const db = getPlatformDB();
    const [rows] = await db.execute(`
      SELECT id, actor_type, actor_id, tenant_id, action, detail, ip_address, created_at
      FROM platform_audit_log
      ORDER BY id DESC
      LIMIT 200
    `);
    res.json({ entries: rows });
  } catch (e) { next(e); }
});

module.exports = router;
