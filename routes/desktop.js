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
  let tracking = null;
  try {
    const pool = await getDB();
    if (enabled) {
      const [[s]] = await pool.execute(
        'SELECT enforce_desktop_tracking FROM tenant_settings WHERE singleton_key = 1'
      );
      enforced = !!s?.enforce_desktop_tracking;
    }
    // The caller's current desktop heartbeat — lets the client (and us) see
    // whether the desktop is running + ready, i.e. whether clock-in is allowed.
    const [[u]] = await pool.execute(
      'SELECT desktop_last_seen, desktop_ready FROM portal_users WHERE id = ?',
      [req.portalUserId]
    );
    const last = u && u.desktop_last_seen ? new Date(u.desktop_last_seen).getTime() : null;
    const secondsAgo = last ? Math.round((Date.now() - last) / 1000) : null;
    tracking = {
      last_seen:   u?.desktop_last_seen || null,
      seconds_ago: secondsAgo,
      ready:       !!(u && u.desktop_ready),
      active:      !!(u && u.desktop_ready) && secondsAgo != null && secondsAgo <= 90,
    };
  } catch { /* columns may not exist yet */ }
  res.json({ enabled, enforced, tracking });
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
