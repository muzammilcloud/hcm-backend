const { getDB } = require('../db');
const { encryptJson, decryptJson, mask } = require('./crypto');

// ─────────────────────────────────────────────────────────────────────────────
// Per-tenant integration config storage.
//
// getIntegrationConfig(type) — returns the decrypted config for the current
// tenant (via getDB's tenant context), or falls back to env defaults if the
// tenant hasn't configured their own. Callers (services/slack.js,
// services/email.js) use this to get effective credentials at runtime.
// ─────────────────────────────────────────────────────────────────────────────

const FALLBACKS = {
  slack: () => ({
    bot_token:      process.env.SLACK_BOT_TOKEN || '',
    signing_secret: process.env.SLACK_SIGNING_SECRET || '',
    source: 'platform',
  }),
  smtp: () => ({
    host:      process.env.SMTP_HOST || '',
    port:      process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587,
    user:      process.env.SMTP_USER || '',
    password:  process.env.SMTP_PASS || '',
    from_name: process.env.SMTP_FROM_NAME || 'Tickin',
    from_email: process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER || '',
    source: 'platform',
  }),
};

// Fields per integration type that contain secrets — masked when listing
const SECRET_FIELDS = {
  slack: ['bot_token', 'signing_secret'],
  smtp:  ['password'],
};

async function readRow(type) {
  try {
    const pool = await getDB();
    const [rows] = await pool.execute(
      'SELECT * FROM tenant_integrations WHERE integration_type = ? LIMIT 1', [type]
    );
    return rows[0] || null;
  } catch (e) {
    // tenant_integrations may not exist yet on legacy DBs — treat as unconfigured
    return null;
  }
}

// Used by services/slack.js and services/email.js at runtime
async function getIntegrationConfig(type) {
  const row = await readRow(type);
  if (!row || !row.enabled || !row.config_encrypted) {
    return FALLBACKS[type] ? FALLBACKS[type]() : null;
  }
  const cfg = decryptJson(row.config_encrypted);
  if (!cfg) return FALLBACKS[type] ? FALLBACKS[type]() : null;
  return { ...cfg, source: 'tenant' };
}

// Save (encrypts on the way in). Pass `null` for the config field to clear.
async function saveIntegrationConfig(type, { config, enabled = true }) {
  const pool = await getDB();
  const encrypted = config ? encryptJson(config) : null;
  await pool.execute(
    `INSERT INTO tenant_integrations (integration_type, enabled, config_encrypted)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
       enabled          = VALUES(enabled),
       config_encrypted = VALUES(config_encrypted),
       last_tested_at   = NULL,
       last_test_status = NULL,
       last_test_message = NULL`,
    [type, enabled ? 1 : 0, encrypted]
  );
}

async function setEnabled(type, enabled) {
  const pool = await getDB();
  await pool.execute(
    `INSERT INTO tenant_integrations (integration_type, enabled) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)`,
    [type, enabled ? 1 : 0]
  );
}

async function deleteIntegration(type) {
  const pool = await getDB();
  await pool.execute('DELETE FROM tenant_integrations WHERE integration_type = ?', [type]);
}

// Listing for the UI — masked secrets, summary status only.
async function listIntegrations() {
  const types = ['slack', 'smtp'];
  const out = {};
  for (const type of types) {
    const row = await readRow(type);
    const cfg = row?.config_encrypted ? decryptJson(row.config_encrypted) : null;
    out[type] = {
      configured:     !!cfg,
      enabled:        row ? !!row.enabled : false,
      using_platform: !cfg,
      last_tested_at: row?.last_tested_at || null,
      last_test_status: row?.last_test_status || null,
      last_test_message: row?.last_test_message || null,
      // Masked summary so the UI can show "Configured ✓ ending in xxxx"
      summary: cfg ? maskedSummary(type, cfg) : null,
    };
  }
  return out;
}

// Return full config (non-secret fields cleartext, secret fields masked).
// Used by the admin UI when editing — shows what's saved without leaking secrets.
async function getIntegrationMasked(type) {
  const row = await readRow(type);
  if (!row || !row.config_encrypted) return { configured: false, enabled: false, config: null };
  const cfg = decryptJson(row.config_encrypted);
  if (!cfg) return { configured: false, enabled: !!row.enabled, config: null };
  const masked = { ...cfg };
  for (const f of (SECRET_FIELDS[type] || [])) {
    if (masked[f]) masked[f] = mask(masked[f]);
  }
  return { configured: true, enabled: !!row.enabled, config: masked };
}

function maskedSummary(type, cfg) {
  if (type === 'slack') {
    return cfg.bot_token ? `Bot token ending ${cfg.bot_token.slice(-4)}` : 'Configured';
  }
  if (type === 'smtp') {
    return `${cfg.host}${cfg.port ? ':' + cfg.port : ''}${cfg.from_email ? ' · ' + cfg.from_email : ''}`;
  }
  return 'Configured';
}

async function recordTestResult(type, ok, message) {
  const pool = await getDB();
  await pool.execute(
    `INSERT INTO tenant_integrations (integration_type, enabled, last_tested_at, last_test_status, last_test_message)
     VALUES (?, 1, NOW(), ?, ?)
     ON DUPLICATE KEY UPDATE
       last_tested_at = VALUES(last_tested_at),
       last_test_status = VALUES(last_test_status),
       last_test_message = VALUES(last_test_message)`,
    [type, ok ? 'ok' : 'failed', String(message || '').slice(0, 500)]
  );
}

module.exports = {
  getIntegrationConfig,
  saveIntegrationConfig,
  setEnabled,
  deleteIntegration,
  listIntegrations,
  getIntegrationMasked,
  recordTestResult,
};
