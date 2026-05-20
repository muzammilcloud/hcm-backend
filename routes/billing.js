const express = require('express');
const router  = express.Router();
const { requireAdmin } = require('../middleware/auth');
const { getPlatformDB } = require('../db');
const { createCheckout, getCustomerPortalUrl, setAutoRenew, setAddon, changePlan, previewChange, isConfigured } = require('../services/billing');
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
            founding_customer, founding_until, first_paid_at, trial_ends_at, status,
            past_due_at, current_period_end, cancel_at_period_end
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

    // Compute grace-period state so the FE doesn't have to.
    const inGracePeriod = !!tenant.past_due_at;
    const graceEndsAt = tenant.past_due_at
      ? new Date(new Date(tenant.past_due_at).getTime() + 8 * 86_400_000)
      : null;
    const graceDaysRemaining = graceEndsAt
      ? Math.max(0, Math.ceil((graceEndsAt - new Date()) / 86_400_000))
      : null;

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
        current_period_end:    tenant.current_period_end,
        auto_renew:            !tenant.cancel_at_period_end,
      },
      grace_period: inGracePeriod ? {
        past_due_at:       tenant.past_due_at,
        ends_at:           graceEndsAt,
        days_remaining:    graceDaysRemaining,
      } : null,
      founding: {
        is_founding:    !!tenant.founding_customer,
        founding_until: tenant.founding_until,
      },
    });
  } catch (e) { next(e); }
});

// POST /api/billing/addons — turn an add-on on or off on the current sub.
// Body: { addon: 'desktop_standard', enabled: bool }
router.post('/billing/addons', requireAdmin, async (req, res, next) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ error: 'Billing is not configured on this server yet.' });
    }
    const tenant = await loadTenant(req);
    if (!tenant) return res.status(404).json({ error: 'No tenant context.' });
    if (!tenant.polar_subscription_id) {
      return res.status(400).json({
        error: 'Start a plan first — add-ons attach to an active subscription.',
        code:  'NO_SUBSCRIPTION',
      });
    }
    const addon   = String(req.body?.addon || '');
    const enabled = !!req.body?.enabled;
    if (!addon) return res.status(400).json({ error: 'addon is required.' });

    const result = await setAddon(tenant, addon, enabled);
    res.json({ ...result, pending_sync: !result.no_change });
  } catch (e) { next(e); }
});

// POST /api/billing/preview-change — preview what a plan change / add-on
// toggle would cost today (prorated) and at next renewal. Pure calculation,
// no Polar side effects. Body: { tier?, cycle?, addons?, seats? }
router.post('/billing/preview-change', requireAdmin, async (req, res, next) => {
  try {
    const tenant = await loadTenant(req);
    if (!tenant) return res.status(404).json({ error: 'No tenant context.' });
    const preview = previewChange(tenant, {
      tier:   req.body?.tier,
      cycle:  req.body?.cycle,
      addons: Array.isArray(req.body?.addons) ? req.body.addons : (tenant.addons || []),
      seats:  req.body?.seats,
    });
    res.json(preview);
  } catch (e) { next(e); }
});

// POST /api/billing/change-plan — switch base plan tier / cycle on an
// existing subscription. Preserves add-ons. Body: { tier, cycle }
router.post('/billing/change-plan', requireAdmin, async (req, res, next) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ error: 'Billing is not configured on this server yet.' });
    }
    const tenant = await loadTenant(req);
    if (!tenant) return res.status(404).json({ error: 'No tenant context.' });
    if (!tenant.polar_subscription_id) {
      return res.status(400).json({
        error: 'Start a plan first — there is no active subscription to change.',
        code:  'NO_SUBSCRIPTION',
      });
    }
    const result = await changePlan(tenant, {
      tier:  req.body?.tier,
      cycle: req.body?.cycle || 'monthly',
    });
    res.json({ ...result, message: 'Plan change submitted to Polar. Polar will prorate today\'s charge and your subscription will update within a few seconds.' });
  } catch (e) { next(e); }
});

// POST /api/billing/auto-renewal — toggle auto-renewal on/off.
// Body: { enabled: bool }
// Off = cancel at current period end (still has access until then).
// On  = uncancel (sub will renew normally).
router.post('/billing/auto-renewal', requireAdmin, async (req, res, next) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ error: 'Billing is not configured on this server yet.' });
    }
    const tenant = await loadTenant(req);
    if (!tenant) return res.status(404).json({ error: 'No tenant context.' });
    if (!tenant.polar_subscription_id) {
      return res.status(400).json({ error: 'No active subscription to update.' });
    }
    const enabled = !!req.body?.enabled;
    await setAutoRenew(tenant, enabled);
    // Polar will fire subscription.canceled / subscription.uncanceled and our
    // webhook handler will mirror state. Return the requested state so the UI
    // can flip immediately without waiting for the round-trip.
    res.json({ auto_renew: enabled, pending_sync: true });
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
