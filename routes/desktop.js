const express = require('express');
const router  = express.Router();
const { requireEmployee } = require('../middleware/auth');

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/desktop/access — any authenticated portal user
//
// The Desktop App is a paid ADD-ON available on EVERY plan (including Starter),
// NOT a Growth-plan feature. Access is therefore gated purely by the
// 'desktop_standard' add-on (Polar webhook populates `tenants.addons`).
// Any plan that has purchased the add-on gets the Desktop tab + features.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/desktop/access', requireEmployee, (req, res) => {
  const addons = Array.isArray(req.tenant?.addons) ? req.tenant.addons : [];
  res.json({ enabled: addons.includes('desktop_standard') });
});

module.exports = router;
