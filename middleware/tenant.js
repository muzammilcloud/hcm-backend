const { tenantContext, getTenantDB } = require('../db');
const { getTenantBySlug, isPlatformSubdomain } = require('../services/tenant');

// Routes that operate on the platform DB only (signup, platform admin, health).
// Anything matching these prefixes skips tenant resolution.
const PLATFORM_PREFIXES = [
  '/api/platform',   // platform admin CRUD
  '/api/signup',     // public signup
  '/api/slug-check', // public slug availability lookup
  '/api/tenant',     // tenant lookup (whoami for FE)
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
  if (tenant.status === 'suspended') {
    return res.status(402).json({ error: 'Workspace suspended', reason: 'billing' });
  }
  if (tenant.status === 'deleted' || tenant.status === 'expired') {
    return res.status(410).json({ error: 'Workspace no longer available' });
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
