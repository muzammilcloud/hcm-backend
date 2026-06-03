const express = require('express');
const router  = express.Router();
const { requireEmployee } = require('../middleware/auth');
const { tenantHas } = require('../services/features');

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/desktop/access — any authenticated portal user
//
// Returns { enabled: bool } if BOTH conditions hold:
//   1. The tenant's plan includes the 'desktop_app' feature (Growth+).
//      Starter tenants never see the Desktop tab regardless of the add-on.
//   2. The tenant has the 'desktop_standard' add-on active (Polar webhook
//      populates `tenants.addons`).
//
// The plan check fails closed: even if a Starter tenant somehow has the
// add-on row, plan gating wins.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/desktop/access', requireEmployee, (req, res) => {
  if (!tenantHas(req.tenant, 'desktop_app')) {
    return res.json({ enabled: false });
  }
  const addons = Array.isArray(req.tenant?.addons) ? req.tenant.addons : [];
  res.json({ enabled: addons.includes('desktop_standard') });
});

module.exports = router;
