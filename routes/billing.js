const express = require('express');
const router  = express.Router();
const { requireAdmin } = require('../middleware/auth');
const { getPlatformDB } = require('../db');
const { createCheckout, getCustomerPortalUrl, isConfigured } = require('../services/billing');
const { PRICE_IDS, ADDON_PRICE_IDS } = require('../lib/polarConstants');

// ─────────────────────────────────────────────────────────────────────────────
// Tenant-scoped billing endpoints. All require sys-admin auth.
//
//   GET  /api/billing/state         — current plan, status, founding flag, etc.
//   POST /api/billing/checkout-url  — create a Polar checkout session, return URL
//   GET  /api/billing/portal-url    — pre-authenticated customer portal URL
//
// All endpoints respect `isConfigured()` — when Polar isn't wired yet the
// state endpoint returns a minimal "not configured" shape and the actions
// return 503 with a clear message instead of crashing.
// ─────────────────────────────────────────────────────────────────────────────

// Helper: load the current tenant row from the platform DB. Tenant context
// is resolved by tenantMiddleware which sets req.tenant for subdomain
// requests; if it's missing we can't proceed.
async function loadTenant(req) {
  if (!req.tenant?.id) return null;
  const platform = getPlatformDB();
  const [rows] = await platform.execute(
    `SELECT id, slug, company_name, contact_email, plan, billing_cycle, plan_currency,
            seat_count, addons, polar_customer_id, polar_subscription_id, polar_status,
            founding_customer, founding_until, first_paid_at, trial_ends_at, status
     FROM tenants WHERE id = ? LIMIT 1`,
    [req.tenant.id]
  );
  return rows[0] || null;
}

router.get('/billing/state', requireAdmin, async (req, res, next) => {
  try {
    const tenant = await loadTenant(req);
    if (!tenant) return res.status(404).json({ error: 'No tenant context.' });

    // Live seat count from the tenant DB, in case the platform-side
    // seat_count column hasn't been updated yet.
    let liveSeatCount = tenant.seat_count || 0;
    try {
      const { getDB } = require('../db');
      const pool = await getDB();
      const [rows] = await pool.execute(
        "SELECT COUNT(*) AS n FROM employees WHERE is_active = 1"
      );
      liveSeatCount = Number(rows[0]?.n || 0);
    } catch (_) { /* fallback to stored value */ }

    res.json({
      configured:        isConfigured(),
      tenant: {
        slug:           tenant.slug,
        company_name:   tenant.company_name,
        contact_email:  tenant.contact_email,
      },
      plan: {
        tier:           tenant.plan,
        cycle:          tenant.billing_cycle,
        currency:       tenant.plan_currency,
        seat_count:     liveSeatCount,
        addons:         tenant.addons || [],
      },
      subscription: {
        status:                tenant.polar_status,
        polar_subscription_id: tenant.polar_subscription_id,
        first_paid_at:         tenant.first_paid_at,
        trial_ends_at:         tenant.trial_ends_at,
        tenant_status:         tenant.status,
      },
      founding: {
        is_founding:    !!tenant.founding_customer,
        founding_until: tenant.founding_until,
      },
    });
  } catch (e) { next(e); }
});

router.post('/billing/checkout-url', requireAdmin, async (req, res, next) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ error: 'Billing is not configured on this server yet.' });
    }
    const tenant = await loadTenant(req);
    if (!tenant) return res.status(404).json({ error: 'No tenant context.' });

    const { tier, cycle = 'monthly', addons = [], successUrl } = req.body || {};
    if (!['starter', 'growth', 'business'].includes(tier)) {
      return res.status(400).json({ error: 'tier must be starter | growth | business.' });
    }
    if (tier === 'business') {
      return res.status(400).json({ error: 'Business plans are created via sales, not self-serve checkout.' });
    }
    if (!['monthly', 'annual'].includes(cycle)) {
      return res.status(400).json({ error: 'cycle must be monthly | annual.' });
    }
    if (!PRICE_IDS[tier]?.[cycle]) {
      return res.status(400).json({ error: `No Polar price configured for ${tier}/${cycle}. Set the corresponding env var.` });
    }
    for (const addon of addons) {
      if (!ADDON_PRICE_IDS[addon]) {
        return res.status(400).json({ error: `Unknown addon: ${addon}` });
      }
    }

    const result = await createCheckout(tenant, { tier, cycle, addons, successUrl });
    res.json(result);
  } catch (e) { next(e); }
});

router.get('/billing/portal-url', requireAdmin, async (req, res, next) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ error: 'Billing is not configured on this server yet.' });
    }
    const tenant = await loadTenant(req);
    if (!tenant) return res.status(404).json({ error: 'No tenant context.' });
    const url = await getCustomerPortalUrl(tenant);
    if (!url) {
      return res.status(404).json({
        error: 'No active subscription yet. Start a plan first.',
        code:  'NO_POLAR_CUSTOMER',
      });
    }
    res.json({ url });
  } catch (e) { next(e); }
});

module.exports = router;
