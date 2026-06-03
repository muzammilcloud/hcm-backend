const { tenantHas, minPlanFor } = require('../services/features');

// ─────────────────────────────────────────────────────────────────────────────
// requireFeature(featureKey) — Express middleware
//
// Returns 402 (Payment Required) with a stable shape when the current
// tenant's plan doesn't include the feature. The FE detects this code +
// the `required_plan` hint and renders an upgrade card pointing at Billing.
//
//   {
//     error: 'Feature locked',
//     code:  'FEATURE_LOCKED',
//     feature: 'audit_log',
//     required_plan: 'growth',
//   }
//
// 402 is the right code because the API still recognizes the request; it
// just declines until billing changes. 403 would imply role/permission.
// ─────────────────────────────────────────────────────────────────────────────
function requireFeature(feature) {
  return function featureGate(req, res, next) {
    if (!req.tenant) {
      // No tenant context — typically only happens on platform-prefix paths,
      // which shouldn't be using this middleware. Surface clearly.
      return res.status(400).json({ error: 'Missing tenant context for feature gate' });
    }
    if (!tenantHas(req.tenant, feature)) {
      return res.status(402).json({
        error:         'Feature locked',
        code:          'FEATURE_LOCKED',
        feature,
        required_plan: minPlanFor(feature),
      });
    }
    next();
  };
}

module.exports = { requireFeature };
