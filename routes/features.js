const express = require('express');
const router  = express.Router();
const { tenantFeatures, planOf } = require('../services/features');
const { requireAdmin } = require('../middleware/auth');
const { setTrialTier } = require('../services/tenant');

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/features — capabilities for the current tenant
//
// Returns the resolved plan + the list of feature keys this tenant has
// access to. The FE reads this on portal mount and hides nav items + UI
// for features the tenant lacks. A 402 from any feature-gated endpoint
// is then the runtime backstop for users who try to access them anyway
// (deep links, stale cached UI, manual API calls).
//
// Unauthenticated: this endpoint is safe to call without a session token
// because plan information is workspace-level, not user-level. The FE
// uses it before login to render the login screen consistently with the
// workspace's plan.
//
// Requires tenant context — tenantMiddleware must have attached req.tenant
// via subdomain / X-Tenant header / Origin / Referer.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/features', (req, res) => {
  if (!req.tenant) {
    return res.status(404).json({ error: 'No tenant resolved' });
  }
  const rawPlan = String(req.tenant.plan || '').toLowerCase();
  const onTrial = rawPlan === 'demo' || rawPlan === 'trial';
  res.json({
    plan:      planOf(req.tenant),
    features:  tenantFeatures(req.tenant),
    onTrial,                                            // can the tier still be switched freely?
    trialTier: onTrial ? planOf(req.tenant) : null,    // which tier the trial is evaluating
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/trial-plan — switch which tier this TRIAL is evaluating.
// Body: { tier: 'starter' | 'growth' }. Admin-only, and only while the tenant is
// on a demo/trial plan. Lets a trial workspace flip between the Starter (limited)
// and Growth (full) experience before they ever pay. Returns the new plan +
// feature list so the FE can refresh its gating without a reload.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/trial-plan', requireAdmin, async (req, res) => {
  if (!req.tenant) return res.status(404).json({ error: 'No tenant resolved' });
  const plan = String(req.tenant.plan || '').toLowerCase();
  if (plan !== 'demo' && plan !== 'trial') {
    return res.status(409).json({ error: 'The evaluation plan can only be changed during a trial.' });
  }
  const tier = String(req.body?.tier || '').toLowerCase();
  if (tier !== 'starter' && tier !== 'growth') {
    return res.status(400).json({ error: 'tier must be "starter" or "growth"' });
  }
  try {
    await setTrialTier(req.tenant.id, tier);
    const updated = { ...req.tenant, trial_tier: tier };
    res.json({ plan: planOf(updated), features: tenantFeatures(updated), trial_tier: tier });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
