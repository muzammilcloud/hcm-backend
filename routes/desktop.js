const express = require('express');
const router  = express.Router();
const { requireEmployee } = require('../middleware/auth');

// Test/QA tenants that get Desktop access without buying the add-on, so the
// team can download and try the desktop app. Override via DESKTOP_TEST_SLUGS
// (comma-separated). Default: qa-starter.
const DESKTOP_TEST_SLUGS = new Set(
  (process.env.DESKTOP_TEST_SLUGS || 'qa-starter')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/desktop/access — any authenticated portal user
//
// The Desktop App is a paid ADD-ON available on EVERY plan (including Starter),
// NOT a Growth-plan feature. Access is therefore gated purely by the
// 'desktop_standard' add-on (Polar webhook populates `tenants.addons`), plus a
// test-tenant allow-list (e.g. qa-starter) for trying it without purchase.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/desktop/access', requireEmployee, (req, res) => {
  const addons = Array.isArray(req.tenant?.addons) ? req.tenant.addons : [];
  const slug = String(req.tenant?.slug || '').toLowerCase();
  const enabled = addons.includes('desktop_standard') || DESKTOP_TEST_SLUGS.has(slug);
  res.json({ enabled });
});

module.exports = router;
