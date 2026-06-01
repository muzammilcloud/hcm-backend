const express = require('express');
const router  = express.Router();
const { requireEmployee } = require('../middleware/auth');

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/desktop/access — any authenticated portal user
//
// Returns { enabled: bool } based on whether the current tenant has the
// 'desktop_standard' add-on active. Front-end portals use this to decide
// whether to surface the Desktop download tab.
//
// Source of truth: the platform-level `tenants.addons` JSON array, populated
// by Polar webhooks when an admin toggles the add-on in Billing. We read
// `req.tenant.addons` which the tenantMiddleware already attaches.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/desktop/access', requireEmployee, (req, res) => {
  const addons = Array.isArray(req.tenant?.addons) ? req.tenant.addons : [];
  res.json({ enabled: addons.includes('desktop_standard') });
});

module.exports = router;
