const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const nodemailer = require('nodemailer');
const { requireAdmin } = require('../middleware/auth');
const {
  listIntegrations, getIntegrationMasked,
  saveIntegrationConfig, setEnabled, deleteIntegration,
  recordTestResult,
} = require('../services/integrations');
const { recordAudit } = require('../services/audit');
const { requireFeature } = require('../middleware/features');
const { tenantHas, minPlanFor } = require('../services/features');

const TYPES = new Set(['slack', 'smtp', 'lineworks']);

// Custom SMTP is a Growth feature. Block Starter tenants from saving, enabling,
// or testing a custom SMTP config. Slack stays open on every plan, and DELETE
// stays open so an admin can always remove a stale config (grandfathering).
function gateSmtp(req, res) {
  if (req.params.type === 'smtp' && !tenantHas(req.tenant, 'smtp_integration')) {
    res.status(402).json({
      error: 'Feature locked', code: 'FEATURE_LOCKED',
      feature: 'smtp_integration', required_plan: minPlanFor('smtp_integration'),
    });
    return false;
  }
  return true;
}

// Slack and LINE WORKS are the two chat integrations and are mutually exclusive:
// a workspace runs one OR the other, never both. Enabling one disables the other.
const CHAT_INTEGRATIONS = ['slack', 'lineworks'];
async function disableOtherChatIntegrations(type) {
  if (!CHAT_INTEGRATIONS.includes(type)) return;
  for (const other of CHAT_INTEGRATIONS) {
    if (other !== type) await setEnabled(other, false);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/integrations — summary list for the admin UI
// ─────────────────────────────────────────────────────────────────────────────
router.get('/integrations', requireAdmin, async (req, res, next) => {
  try {
    const summary = await listIntegrations();
    res.json(summary);
  } catch (e) { next(e); }
});

// GET /api/integrations/:type — full config (secrets masked)
router.get('/integrations/:type', requireAdmin, async (req, res, next) => {
  try {
    if (!TYPES.has(req.params.type)) return res.status(404).json({ error: 'Unknown integration' });
    res.json(await getIntegrationMasked(req.params.type));
  } catch (e) { next(e); }
});

// PUT /api/integrations/:type — save credentials.
// Body: { config: {...}, enabled: bool, merge: bool }
//   merge=true keeps existing secret values that came back masked from a
//   GET (so admin doesn't have to re-enter them). The FE marks masked
//   fields with sentinel ••••.
router.put('/integrations/:type', requireAdmin, async (req, res, next) => {
  try {
    const type = req.params.type;
    if (!TYPES.has(type)) return res.status(404).json({ error: 'Unknown integration' });
    if (!gateSmtp(req, res)) return;
    const { config, enabled = true, merge = true } = req.body || {};

    let finalConfig = config || {};

    if (merge && config) {
      // For any field whose value looks like a mask, fall back to the
      // currently-stored value (so masked round-trips don't wipe secrets).
      const current = await getIntegrationMasked(type);
      if (current?.config) {
        for (const key of Object.keys(finalConfig)) {
          if (typeof finalConfig[key] === 'string' && /^•+/.test(finalConfig[key])) {
            // Pull the real value from the encrypted store
            const { decryptJson } = require('../services/crypto');
            const pool = await require('../db').getDB();
            const [rows] = await pool.execute(
              'SELECT config_encrypted FROM tenant_integrations WHERE integration_type = ? LIMIT 1', [type]
            );
            const decrypted = rows[0]?.config_encrypted ? decryptJson(rows[0].config_encrypted) : null;
            if (decrypted && decrypted[key] != null) finalConfig[key] = decrypted[key];
          }
        }
      }
    }

    await saveIntegrationConfig(type, { config: finalConfig, enabled });
    if (enabled) await disableOtherChatIntegrations(type);
    // Audit without secret values — just record which fields changed and the
    // enabled state. Full secret diff would be a credential leak.
    recordAudit(req, {
      action: `integration.${type}.saved`,
      target: { type: 'integration', id: type },
      after: { enabled: !!enabled, fields_set: Object.keys(finalConfig || {}) },
    });
    res.json(await getIntegrationMasked(type));
  } catch (e) { next(e); }
});

// PUT /api/integrations/:type/enabled — quick on/off toggle
router.put('/integrations/:type/enabled', requireAdmin, async (req, res, next) => {
  try {
    if (!TYPES.has(req.params.type)) return res.status(404).json({ error: 'Unknown integration' });
    if (!gateSmtp(req, res)) return;
    const enabled = !!req.body?.enabled;
    await setEnabled(req.params.type, enabled);
    if (enabled) await disableOtherChatIntegrations(req.params.type);
    recordAudit(req, {
      action: `integration.${req.params.type}.${enabled ? 'enabled' : 'disabled'}`,
      target: { type: 'integration', id: req.params.type },
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// DELETE /api/integrations/:type — clears the row, falls back to env defaults
router.delete('/integrations/:type', requireAdmin, async (req, res, next) => {
  try {
    if (!TYPES.has(req.params.type)) return res.status(404).json({ error: 'Unknown integration' });
    await deleteIntegration(req.params.type);
    recordAudit(req, {
      action: `integration.${req.params.type}.removed`,
      target: { type: 'integration', id: req.params.type },
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /api/integrations/lineworks/test — verify the bot can authenticate.
// Open on every plan, like Slack. Pulls saved secrets when masked fields are sent.
router.post('/integrations/lineworks/test', requireAdmin, async (req, res) => {
  try {
    const lw = require('../services/lineworks');
    const { getIntegrationConfig } = require('../services/integrations');
    let cfg = req.body || {};
    // If the private key / secrets came through masked (•••), fall back to saved.
    const saved = await getIntegrationConfig('lineworks');
    for (const f of ['client_secret', 'private_key', 'bot_secret']) {
      if (!cfg[f] || /^•+/.test(String(cfg[f]))) cfg[f] = saved?.[f];
    }
    if (!cfg.client_id || !cfg.service_account || !cfg.private_key || !cfg.client_secret) {
      return res.status(400).json({ ok: false, error: 'client_id, service_account, client_secret and private_key are required' });
    }
    await lw.testConnection(cfg, Math.floor(Date.now() / 1000));
    await recordTestResult('lineworks', true, 'Authenticated with LINE WORKS');
    res.json({ ok: true, message: 'Connected to LINE WORKS' });
  } catch (e) {
    const msg = e.response?.data?.error_description || e.response?.data?.error || e.message;
    await recordTestResult('lineworks', false, msg);
    res.status(400).json({ ok: false, error: msg });
  }
});

// POST /api/integrations/slack/test — { bot_token } → calls auth.test
router.post('/integrations/slack/test', requireAdmin, async (req, res, next) => {
  const { bot_token } = req.body || {};
  if (!bot_token) return res.status(400).json({ error: 'bot_token is required' });
  try {
    const r = await axios.post('https://slack.com/api/auth.test', null, {
      headers: { Authorization: `Bearer ${bot_token}` },
      timeout: 8000,
    });
    if (r.data?.ok) {
      const msg = `Connected to "${r.data.team}" as ${r.data.user}`;
      await recordTestResult('slack', true, msg);
      return res.json({ ok: true, message: msg, team: r.data.team, user: r.data.user });
    }
    await recordTestResult('slack', false, r.data?.error || 'auth.test returned not ok');
    res.status(400).json({ ok: false, error: r.data?.error || 'Invalid token' });
  } catch (e) {
    await recordTestResult('slack', false, e.message);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// POST /api/integrations/smtp/test — verifies connection without sending
router.post('/integrations/smtp/test', requireAdmin, requireFeature('smtp_integration'), async (req, res, next) => {
  const { host, port, user, password } = req.body || {};
  if (!host || !user || !password) return res.status(400).json({ error: 'host, user, password are required' });
  try {
    const t = nodemailer.createTransport({
      host, port: Number(port) || 587, secure: Number(port) === 465,
      auth: { user, pass: password },
      connectionTimeout: 8000, greetingTimeout: 8000,
    });
    await t.verify();
    const msg = `Connected to ${host}:${port || 587} as ${user}`;
    await recordTestResult('smtp', true, msg);
    res.json({ ok: true, message: msg });
  } catch (e) {
    await recordTestResult('smtp', false, e.message);
    res.status(400).json({ ok: false, error: e.message });
  }
});

module.exports = router;
