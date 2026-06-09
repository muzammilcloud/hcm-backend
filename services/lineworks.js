// LINE WORKS transport layer — the LINE equivalent of services/slack.js.
//
// LINE WORKS Bot API 2.0 uses server-to-server OAuth: we sign a JWT with the
// Service Account private key, exchange it for an access token, then call the
// Bot API to push messages to users / channels. Inbound webhooks are verified
// with an HMAC-SHA256 signature over the raw body using the bot secret.
//
// Unlike Slack, each tenant configures their own bot's callback URL to
// /api/lineworks/callback/<slug>, so the tenant is resolved from the URL and
// every call here is parameterised by that tenant's decrypted config (cfg).

const axios  = require('axios');
const crypto = require('crypto');

const AUTH_URL = 'https://auth.worksmobile.com/oauth2/v2.0/token';
const API_BASE = 'https://www.worksapis.com/v1.0';
const DEFAULT_SCOPE = 'bot bot.message user.read';

// ── Auth ─────────────────────────────────────────────────────────────────────
// Access tokens last ~24h; cache per client so we don't re-mint on every event.
const tokenCache = new Map(); // clientId -> { token, exp }

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// Build the RS256 JWT assertion (no jsonwebtoken dependency).
function buildAssertion(cfg, nowSec) {
  const header  = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: cfg.client_id,
    sub: cfg.service_account,
    iat: nowSec,
    exp: nowSec + 3600,
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(cfg.private_key).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${header}.${payload}.${signature}`;
}

// nowSec is injected so the module stays free of Date.now() at import time and
// is easy to test; callers pass Math.floor(Date.now()/1000).
async function getAccessToken(cfg, nowSec) {
  const cached = tokenCache.get(cfg.client_id);
  if (cached && cached.exp > nowSec + 60) return cached.token;

  const assertion = buildAssertion(cfg, nowSec);
  const body = new URLSearchParams({
    assertion,
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    client_id: cfg.client_id,
    client_secret: cfg.client_secret,
    scope: cfg.scope || DEFAULT_SCOPE,
  });
  const res = await axios.post(AUTH_URL, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const token = res.data.access_token;
  const exp   = nowSec + Number(res.data.expires_in || 86400);
  tokenCache.set(cfg.client_id, { token, exp });
  return token;
}

// ── Inbound signature ────────────────────────────────────────────────────────
// LINE WORKS signs the raw request body with HMAC-SHA256(bot_secret) and sends
// it base64-encoded in the X-WORKS-Signature header.
function verifySignature(rawBody, signature, botSecret) {
  if (!signature || !botSecret || !rawBody) return false;
  const expected = crypto.createHmac('sha256', botSecret).update(rawBody).digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch { return false; }
}

// ── Message builders ─────────────────────────────────────────────────────────
function textContent(text) {
  return { type: 'text', text };
}

// A button template with up to 4 quick actions. Each action is either
// { kind: 'postback', label, data, displayText } or { kind: 'message', label, text }.
function buttonContent(text, actions = []) {
  return {
    type: 'button_template',
    contentText: text,
    actions: actions.map((a) =>
      a.kind === 'postback'
        ? { type: 'postback', label: a.label, postback: a.data, displayText: a.displayText || a.label }
        : { type: 'message', label: a.label, text: a.text || a.label }
    ),
  };
}

// ── Outbound ─────────────────────────────────────────────────────────────────
async function pushToUser(cfg, userId, content, nowSec) {
  const token = await getAccessToken(cfg, nowSec);
  await axios.post(`${API_BASE}/bots/${cfg.bot_id}/users/${userId}/messages`,
    { content },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
}

async function postToChannel(cfg, channelId, content, nowSec) {
  if (!channelId) return;
  const token = await getAccessToken(cfg, nowSec);
  await axios.post(`${API_BASE}/bots/${cfg.bot_id}/channels/${channelId}/messages`,
    { content },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
}

// Post to the tenant's configured announcement channel (if any). Best-effort.
async function announce(cfg, text, nowSec) {
  if (!cfg.channel_id) return;
  try { await postToChannel(cfg, cfg.channel_id, textContent(text), nowSec); }
  catch (e) { console.warn('[lineworks] announce failed:', e.message); }
}

// ── Identity: LINE WORKS userId -> employee (portal_users) ───────────────────
// With user.read scope we can look up the directory user's work email and match
// it to a portal account — no manual linking step needed.
async function getEmployeeByLineWorksId(cfg, userId, pool, nowSec) {
  const token = await getAccessToken(cfg, nowSec);
  const res = await axios.get(`${API_BASE}/users/${userId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const email = res.data?.email || res.data?.userId;
  if (!email) throw new Error('No work email found on your LINE WORKS profile. Ask your admin.');
  const [rows] = await pool.execute(
    "SELECT * FROM portal_users WHERE email = ? AND status = 'active'",
    [String(email).toLowerCase()]
  );
  if (rows.length === 0) {
    throw new Error(`No active Tickin account found for ${email}. Ask your admin to send you an invite.`);
  }
  return rows[0];
}

// Verify a config can authenticate (used by the "Test connection" button).
async function testConnection(cfg, nowSec) {
  await getAccessToken(cfg, nowSec);
  return true;
}

module.exports = {
  getAccessToken,
  verifySignature,
  textContent,
  buttonContent,
  pushToUser,
  postToChannel,
  announce,
  getEmployeeByLineWorksId,
  testConnection,
};
