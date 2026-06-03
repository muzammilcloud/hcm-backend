const express = require('express');
const router  = express.Router();
const { tenantFeatures, planOf } = require('../services/features');

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
  res.json({
    plan:     planOf(req.tenant),
    features: tenantFeatures(req.tenant),
  });
});

module.exports = router;
