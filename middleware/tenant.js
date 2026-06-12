const { tenantContext, getTenantDB } = require('../db');
const { getTenantBySlug, isPlatformSubdomain } = require('../services/tenant');

// Routes that operate on the platform DB only (signup, platform admin, health).
// Anything matching these prefixes skips tenant resolution.
const PLATFORM_PREFIXES = [
  '/api/platform',   // platform admin CRUD
  '/api/signup',     // public signup
  '/api/slug-check', // public slug availability lookup
  '/api/tenant',     // tenant lookup (whoami for FE)
  '/api/lineworks',  // LINE WORKS webhook — resolves its own tenant from the URL slug
  '/api/slack',      // Slack slash commands — resolve their own tenant from the /api/slack/<slug>/… URL
  // Google OAuth redirect-flow endpoints. The callback comes from Google
  // with Referer=accounts.google.com (not a tenant subdomain), so the
  // default Referer-based slug resolution would 404 here. /start and
  // /exchange don't need tenant resolution either — they carry the slug
  // explicitly (in ?slug= and the handoff token respectively). The legacy
  // GIS endpoints (/verify, /decode) DO need tenant context and are
  // therefore NOT listed here.
  '/api/auth/google/start',
  '/api/auth/google/callback',
  '/api/auth/google/exchange',
  '/health',
];

function isPlatformPath(path) {
  return PLATFORM_PREFIXES.some((p) => path === p || path.startsWith(p + '/') || path.startsWith(p + '?'));
}

// Extract the leftmost label of the hostname:
//   "acme.tickin.pro" → "acme"
//   "tickin.pro"      → null
//   "localhost"       → null
//   "api.tickin.pro"  → "api"  (caller will treat 'api' as reserved)
function extractSubdomain(hostname) {
  if (!hostname) return null;
  const clean = hostname.split(':')[0].toLowerCase();
  const parts = clean.split('.');
  if (parts.length < 3) return null;            // apex or single-label (localhost)
  return parts[0];
}

// Determine the tenant slug for this request.
//   1. Explicit X-Tenant header (FE sends it from window.location.hostname)
//   2. Origin / Referer subdomain
//   3. Request hostname subdomain
function resolveSlug(req) {
  const headerSlug = req.headers['x-tenant'];
  if (headerSlug && typeof headerSlug === 'string') return headerSlug.toLowerCase().trim();

  for (const header of ['origin', 'referer']) {
    const raw = req.headers[header];
    if (!raw) continue;
    try {
      const u = new URL(raw);
      const slug = extractSubdomain(u.hostname);
      if (slug) return slug;
    } catch (_) {}
  }
  return extractSubdomain(req.hostname);
}

async function tenantMiddleware(req, res, next) {
  // Platform-only routes — skip tenant resolution entirely. They run against
  // the platform DB via the default getDB() path (no tenant context).
  if (isPlatformPath(req.path)) return next();

  const slug = resolveSlug(req);

  // No subdomain, or a platform subdomain (api/www/admin/...) — let it through.
  // Routes that require a tenant should call ensureTenant() themselves.
  // NOTE: do not check the broader RESERVED_SUBDOMAINS here — names like 'app'
  // are reserved-against-signup but ARE real tenants that need to resolve.
  if (!slug || isPlatformSubdomain(slug)) return next();

  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    return res.status(404).json({ error: 'Workspace not found' });
  }

  // Routes that must still work for expired / suspended tenants so the
  // admin can subscribe / reactivate from the paywall. Everything else
  // (employees, time, salary, etc.) is blocked until billing is current.
  const isBillingPath  = req.path.startsWith('/api/billing');
  const isAuthPath     = req.path.startsWith('/api/login')
                       || req.path.startsWith('/api/auth')
                       || req.path.startsWith('/api/logout')
                       || req.path.startsWith('/api/employee/login')
                       || req.path.startsWith('/api/employee/logout');
  // Tenant context already attached below; some platform-prefixed routes
  // are bypassed earlier in this middleware, but /api/tenant/whoami runs
  // under tenant context to compute access_restricted from req.tenant.
  const allowedWhenLocked = isBillingPath || isAuthPath;

  if (tenant.status === 'deleted') {
    // Diagnostic: a QA pass flagged /api/employees specifically returning
    // 410 while sibling endpoints returned 200 on the same session. The
    // 410 path here is uniform across all routes, so a recurrence likely
    // means a stale X-Tenant header pointed at a different (deleted)
    // tenant. Log enough to reproduce: which slug was resolved, what the
    // request looked like, and which route hit it.
    console.warn('[tenant] 410 returned', JSON.stringify({
      slug, tenantId: tenant.id, status: tenant.status,
      path: req.path, header: req.headers['x-tenant'] || null,
      origin: req.headers.origin || null, host: req.hostname,
    }));
    return res.status(410).json({
      error:    'Workspace no longer available',
      slug,                            // <- visible to caller so debugging is straightforward
      tenant_status: tenant.status,
    });
  }
  if ((tenant.status === 'suspended' || tenant.status === 'expired') && !allowedWhenLocked) {
    return res.status(402).json({
      error: 'Workspace locked',
      reason: 'billing',
      code: tenant.status === 'expired' ? 'TRIAL_EXPIRED' : 'SUSPENDED',
    });
  }

  req.tenant = tenant;

  // Run the rest of the request chain inside the tenant context. Every
  // call to getDB() further down — in route handlers, middleware, services
  // — will now return the tenant's MySQL pool.
  tenantContext.run({ dbName: tenant.db_name, slug: tenant.slug, tenantId: tenant.id }, () => next());
}

// For routes that must have a tenant resolved (e.g. /api/login on a tenant
// subdomain). Call this inside the handler when missing tenant is a hard error.
function ensureTenant(req, res) {
  if (!req.tenant) {
    res.status(400).json({ error: 'Missing tenant — request must come from a tenant subdomain' });
    return false;
  }
  return true;
}

module.exports = { tenantMiddleware, ensureTenant, extractSubdomain, resolveSlug };
