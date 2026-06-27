const express = require('express');
const router  = express.Router();
const { getDB } = require('../db');
const { requireEmployee } = require('../middleware/auth');
const { tenantHasDesktop } = require('../services/desktop');

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/desktop/access — any authenticated portal user
//
// The Desktop App is a paid ADD-ON available on EVERY plan (including Starter),
// NOT a Growth-plan feature. Access is gated by the 'desktop_standard' add-on
// (Polar webhook populates `tenants.addons`), plus a test-tenant allow-list
// (e.g. qa-starter). `enforced` tells the client whether desktop tracking is
// required to clock in (admin toggle in Workspace Settings).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/desktop/access', requireEmployee, async (req, res) => {
  const enabled = tenantHasDesktop(req.tenant);
  let enforced = false;
  if (enabled) {
    try {
      const pool = await getDB();
      const [[s]] = await pool.execute(
        'SELECT enforce_desktop_tracking FROM tenant_settings WHERE singleton_key = 1'
      );
      enforced = !!s?.enforce_desktop_tracking;
    } catch { /* column may not exist yet — treat as not enforced */ }
  }
  res.json({ enabled, enforced });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/desktop/heartbeat — the desktop app pings this while running so the
// backend knows it's live and ready to track. Body: { ready: boolean }.
// Used to gate clock-in when enforcement is on (see services/desktop.js).
// ─────────────────────────────────────────────────────────────────────────────
router.post('/desktop/heartbeat', requireEmployee, async (req, res) => {
  try {
    const ready = req.body && req.body.ready ? 1 : 0;
    const pool = await getDB();
    await pool.execute(
      'UPDATE portal_users SET desktop_last_seen = NOW(), desktop_ready = ? WHERE id = ?',
      [ready, req.portalUserId]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
