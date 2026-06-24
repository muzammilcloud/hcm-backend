const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const { getDB, getPlatformDB, generateToken, tenantContext } = require('../db');
const { recordAudit } = require('../services/audit');
const { allowsMultipleSessions } = require('../services/tenant');

// ─────────────────────────────────────────────────────────────────────────────
// Google Sign-In — two flows live in this file:
//
//   1. The original GIS popup flow (POST /verify, POST /decode). Still used
//      by the signup page on the apex domain. Single registered origin.
//
//   2. Server-side OAuth 2.0 redirect flow (GET /start, GET /callback,
//      POST /exchange). Used for tenant-portal login on every <slug>.tickin.pro.
//      Google only needs api.tickin.pro/api/auth/google/callback registered as
//      an "Authorized redirect URI" — no per-tenant JavaScript origins.
//
// The redirect flow's contract:
//   FE (any tenant subdomain) → 302 to /api/auth/google/start?slug=<slug>
//   /start                    → 302 to Google's auth URL, signed state in &state
//   Google → user signs in    → 302 to /api/auth/google/callback?code=&state=
//   /callback                 → exchanges code, mints handoff token, 302 to
//                               https://<slug>.tickin.pro/?google_handoff=<token>
//   FE mounts, sees handoff   → POST /api/auth/google/exchange with the token
//   /exchange                 → returns the real session payload (token, role, …)
// ─────────────────────────────────────────────────────────────────────────────

const CLIENT_ID     = (process.env.GOOGLE_OAUTH_CLIENT_ID     || '').trim();
const CLIENT_SECRET = (process.env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim();
const REDIRECT_URI  = (process.env.GOOGLE_OAUTH_REDIRECT_URI  || '').trim();
const APEX_DOMAIN   = (process.env.APEX_DOMAIN || 'tickin.pro').trim();
const APEX_PROTOCOL = (process.env.APEX_PROTOCOL || 'https').trim();
// HMAC key for signing the OAuth state. Falls back to a per-process random
// key so dev still works without explicit config; in prod, set this so state
// survives backend restarts (otherwise in-flight Google sign-ins drop after
// a deploy — acceptable but worth knowing).
const STATE_SECRET  = process.env.GOOGLE_OAUTH_STATE_SECRET
                    || process.env.SESSION_SECRET
                    || crypto.randomBytes(32).toString('hex');

if (!CLIENT_ID) {
  console.warn('[google-auth] GOOGLE_OAUTH_CLIENT_ID is not set; /api/auth/google/* will reject every request.');
}
if (CLIENT_ID && !CLIENT_SECRET) {
  console.warn('[google-auth] GOOGLE_OAUTH_CLIENT_SECRET is not set; the redirect flow (/start, /callback) cannot exchange codes.');
}

const verifier = new OAuth2Client(CLIENT_ID);

async function verifyGoogleIdToken(idToken) {
  if (!CLIENT_ID) {
    throw new Error('Google sign-in is not configured on this server.');
  }
  const ticket = await verifier.verifyIdToken({ idToken, audience: CLIENT_ID });
  const payload = ticket.getPayload();
  if (!payload) throw new Error('Invalid Google token.');
  if (!payload.email_verified) throw new Error('Google email is not verified.');
  return payload;
}

// ─────────────────────────────────────────────────────────────────────────────
// State signing — HMAC-SHA256 over base64url(JSON({slug, nonce, exp}))
// ─────────────────────────────────────────────────────────────────────────────
function b64uEncode(buf) { return Buffer.from(buf).toString('base64url'); }
function b64uDecode(s)   { return Buffer.from(s, 'base64url'); }

function signState(payload) {
  const json = b64uEncode(JSON.stringify(payload));
  const hmac = crypto.createHmac('sha256', STATE_SECRET).update(json).digest('base64url');
  return `${json}.${hmac}`;
}
function verifyState(state) {
  if (typeof state !== 'string' || !state.includes('.')) throw new Error('Malformed state');
  const [json, hmac] = state.split('.');
  const expected = crypto.createHmac('sha256', STATE_SECRET).update(json).digest('base64url');
  // Constant-time compare to avoid timing oracles.
  const a = Buffer.from(hmac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Invalid state signature');
  const payload = JSON.parse(b64uDecode(json).toString('utf8'));
  if (!payload.exp || payload.exp < Date.now()) throw new Error('State expired');
  return payload;
}

// ─────────────────────────────────────────────────────────────────────────────
// Handoff tokens — short-lived (60s), one-time-use. Stored in memory because
// the entire round-trip is sub-second; loss on backend restart is fine.
// ─────────────────────────────────────────────────────────────────────────────
const handoffs = new Map();  // token -> { payload, expiresAt }
const HANDOFF_TTL_MS = 60_000;

function storeHandoff(payload) {
  const token = crypto.randomBytes(24).toString('base64url');
  handoffs.set(token, { payload, expiresAt: Date.now() + HANDOFF_TTL_MS });
  return token;
}
function consumeHandoff(token) {
  const entry = handoffs.get(token);
  if (!entry) return null;
  handoffs.delete(token);
  if (entry.expiresAt < Date.now()) return null;
  return entry.payload;
}
// Periodic cleanup so a server with low handoff traffic doesn't keep stale
// entries forever. Runs every 5 min; safe since handoffs live 60s.
setInterval(() => {
  const now = Date.now();
  for (const [tok, entry] of handoffs) {
    if (entry.expiresAt < now) handoffs.delete(tok);
  }
}, 5 * 60 * 1000).unref?.();

function tenantUrl(slug, query = {}) {
  const qs = new URLSearchParams(query).toString();
  return `${APEX_PROTOCOL}://${slug}.${APEX_DOMAIN}/${qs ? `?${qs}` : ''}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. GET /api/auth/google/start?slug=<slug>[&intent=signup]
//
// Entry point for the redirect flow. Verifies the slug, generates a signed
// state, and 302s the user to Google's authorization URL.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/auth/google/start', async (req, res, next) => {
  try {
    if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
      return res.status(503).json({ error: 'Google sign-in is not configured on this server.' });
    }
    const slug = String(req.query.slug || '').toLowerCase().trim();
    if (!slug) return res.status(400).json({ error: 'slug is required' });

    // Verify the slug points at a real workspace before sending the user to
    // Google. Avoids burning OAuth state on phishing/typo'd subdomains.
    const platform = getPlatformDB();
    const [rows] = await platform.execute(
      'SELECT id, slug, status FROM tenants WHERE slug = ? LIMIT 1',
      [slug]
    );
    if (rows.length === 0)               return res.redirect(`${APEX_PROTOCOL}://${APEX_DOMAIN}/?error=workspace_not_found`);
    if (rows[0].status === 'deleted')    return res.redirect(tenantUrl(slug, { google_error: 'workspace_deleted' }));

    const state = signState({
      slug,
      nonce: crypto.randomBytes(8).toString('base64url'),
      exp:   Date.now() + 10 * 60 * 1000, // 10-min window to complete OAuth
    });

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id',     CLIENT_ID);
    authUrl.searchParams.set('redirect_uri',  REDIRECT_URI);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope',         'openid email profile');
    authUrl.searchParams.set('state',         state);
    authUrl.searchParams.set('access_type',   'online');     // no refresh token needed
    authUrl.searchParams.set('prompt',        'select_account'); // always let user pick

    res.redirect(authUrl.toString());
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. GET /api/auth/google/callback?code=&state=
//
// Google redirects here after the user signs in. We:
//   1. Verify state HMAC + freshness
//   2. POST code → Google's token endpoint to get an id_token
//   3. Verify the id_token signature (catches tampering even if state passes)
//   4. Inside tenantContext for the slug from state: find / create-link the
//      portal_user and mint a portal_sessions row
//   5. Stash the auth payload behind a handoff token + 302 the user back to
//      the tenant subdomain with the handoff token in the URL
// ─────────────────────────────────────────────────────────────────────────────
router.get('/auth/google/callback', async (req, res) => {
  const fail = (slug, code) => {
    if (slug) return res.redirect(tenantUrl(slug, { google_error: code }));
    return res.redirect(`${APEX_PROTOCOL}://${APEX_DOMAIN}/?google_error=${encodeURIComponent(code)}`);
  };

  // Google can come back with ?error=access_denied if the user cancels.
  if (req.query.error) {
    let stateSlug = null;
    try { stateSlug = verifyState(req.query.state).slug; } catch { /* ignored */ }
    return fail(stateSlug, String(req.query.error));
  }

  let slug = null;
  try {
    const parsed = verifyState(req.query.state || '');
    slug = parsed.slug;
  } catch (e) {
    return fail(null, 'invalid_state');
  }

  const code = String(req.query.code || '');
  if (!code) return fail(slug, 'missing_code');

  try {
    // Exchange code → tokens
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        grant_type:    'authorization_code',
        redirect_uri:  REDIRECT_URI,
      }),
    });
    if (!tokenResp.ok) {
      const detail = await tokenResp.text().catch(() => '');
      console.error('[google-auth] token exchange failed:', tokenResp.status, detail);
      return fail(slug, 'token_exchange_failed');
    }
    const tokens = await tokenResp.json();
    if (!tokens.id_token) return fail(slug, 'no_id_token');

    const profile = await verifyGoogleIdToken(tokens.id_token);
    const { sub: googleSub, email, given_name, family_name } = profile;

    // Resolve the tenant + look up the portal user in that tenant's DB.
    const platform = getPlatformDB();
    const [trows] = await platform.execute(
      'SELECT id, slug, db_name, status FROM tenants WHERE slug = ? LIMIT 1',
      [slug]
    );
    if (trows.length === 0) return fail(slug, 'workspace_not_found');
    const tenant = trows[0];
    if (tenant.status === 'deleted') return fail(slug, 'workspace_deleted');

    // Run the per-tenant DB work inside tenantContext so getDB() resolves.
    const handoffPayload = await new Promise((resolve, reject) => {
      tenantContext.run(
        { dbName: tenant.db_name, slug: tenant.slug, tenantId: tenant.id },
        async () => {
          try {
            const pool = await getDB();

            // Match by google_sub first, then by email (links sub on first login).
            let [rows] = await pool.execute(
              "SELECT * FROM portal_users WHERE google_sub = ? AND status = 'active'",
              [googleSub]
            );
            if (rows.length === 0) {
              [rows] = await pool.execute(
                "SELECT * FROM portal_users WHERE LOWER(email) = LOWER(?) AND status = 'active'",
                [email]
              );
            }
            if (rows.length === 0) {
              resolve({ error: 'no_account', email });
              return;
            }
            const pu = rows[0];

            if (!pu.google_sub) {
              try {
                await pool.execute('UPDATE portal_users SET google_sub = ? WHERE id = ?', [googleSub, pu.id]);
              } catch (e) {
                if (e.code === 'ER_DUP_ENTRY') {
                  resolve({ error: 'google_account_linked_elsewhere' });
                  return;
                }
                throw e;
              }
            }

            const sessionToken = generateToken();
            const expiresAt    = new Date(Date.now() + 8 * 60 * 60 * 1000);
            if (!allowsMultipleSessions(tenant)) {
              await pool.execute('DELETE FROM portal_sessions WHERE portal_user_id = ?', [pu.id]);
            }
            await pool.execute(
              'INSERT INTO portal_sessions (portal_user_id, token, expires_at) VALUES (?, ?, ?)',
              [pu.id, sessionToken, expiresAt]
            );

            recordAudit(
              { user: { id: pu.id, email: pu.email, role: pu.portal_role }, ip: req.ip, headers: req.headers },
              { action: 'auth.google.signin', target: { type: 'portal_user', id: pu.id } }
            );

            resolve({
              ok: true,
              session: {
                token:      sessionToken,
                expires_at: expiresAt,
                role:       pu.portal_role || 'employee',
                employee: {
                  id:           pu.id,
                  name:         pu.name || `${given_name || ''} ${family_name || ''}`.trim() || email,
                  email:        pu.email,
                  role:         pu.role,
                  department:   pu.department,
                  portal_role:  pu.portal_role,
                },
              },
            });
          } catch (e) { reject(e); }
        }
      );
    });

    if (handoffPayload.error) {
      return fail(slug, handoffPayload.error);
    }
    const handoffToken = storeHandoff(handoffPayload.session);
    return res.redirect(tenantUrl(slug, { google_handoff: handoffToken }));
  } catch (e) {
    console.error('[google-auth] callback failed:', e.message);
    return fail(slug, 'callback_error');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. POST /api/auth/google/exchange { handoff }
//
// The frontend POSTs this on mount when it sees ?google_handoff=<token> in
// the URL. We return the same shape /api/login does so login() works
// unchanged.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/auth/google/exchange', (req, res) => {
  const token = req.body?.handoff;
  if (!token) return res.status(400).json({ error: 'handoff token required' });
  const payload = consumeHandoff(String(token));
  if (!payload) return res.status(410).json({ error: 'Handoff token expired or already used' });
  res.json(payload);
});

// ─────────────────────────────────────────────────────────────────────────────
// Legacy GIS popup endpoints — kept for the signup page (apex domain).
// ─────────────────────────────────────────────────────────────────────────────

router.post('/auth/google/verify', async (req, res) => {
  const { id_token } = req.body || {};
  if (!id_token) return res.status(400).json({ error: 'id_token is required.' });

  let payload;
  try {
    payload = await verifyGoogleIdToken(id_token);
  } catch (e) {
    return res.status(401).json({ error: e.message || 'Google token rejected.' });
  }

  try {
    const pool = await getDB();
    const { sub: googleSub, email, given_name, family_name } = payload;

    let [rows] = await pool.execute(
      "SELECT * FROM portal_users WHERE google_sub = ? AND status = 'active'",
      [googleSub]
    );
    if (rows.length === 0) {
      [rows] = await pool.execute(
        "SELECT * FROM portal_users WHERE LOWER(email) = LOWER(?) AND status = 'active'",
        [email]
      );
    }

    if (rows.length === 0) {
      return res.status(404).json({
        error: `No Tickin workspace is linked to ${email}. Ask an admin to invite you, or sign up to create a new workspace.`,
        code: 'NO_ACCOUNT',
      });
    }

    const pu = rows[0];

    if (!pu.google_sub) {
      try {
        await pool.execute('UPDATE portal_users SET google_sub = ? WHERE id = ?', [googleSub, pu.id]);
      } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') {
          return res.status(409).json({ error: 'This Google account is already linked to a different Tickin user.' });
        }
        throw e;
      }
    }

    const token     = generateToken();
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
    if (!allowsMultipleSessions(req.tenant)) {
      await pool.execute('DELETE FROM portal_sessions WHERE portal_user_id = ?', [pu.id]);
    }
    await pool.execute('INSERT INTO portal_sessions (portal_user_id, token, expires_at) VALUES (?, ?, ?)', [pu.id, token, expiresAt]);

    recordAudit(
      { user: { id: pu.id, email: pu.email, role: pu.portal_role }, ip: req.ip, headers: req.headers },
      { action: 'auth.google.signin', target: { type: 'portal_user', id: pu.id } }
    );

    res.json({
      token, expires_at: expiresAt,
      role: pu.portal_role || 'employee',
      employee: {
        id: pu.id, name: pu.name || `${given_name || ''} ${family_name || ''}`.trim() || email,
        email: pu.email, role: pu.role, department: pu.department, portal_role: pu.portal_role,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/auth/google/decode', async (req, res) => {
  const { id_token } = req.body || {};
  if (!id_token) return res.status(400).json({ error: 'id_token is required.' });
  try {
    const p = await verifyGoogleIdToken(id_token);
    res.json({
      email:      p.email,
      first_name: p.given_name || '',
      last_name:  p.family_name || '',
      picture:    p.picture || null,
      sub:        p.sub,
    });
  } catch (e) {
    res.status(401).json({ error: e.message || 'Google token rejected.' });
  }
});

module.exports = { router, verifyGoogleIdToken };
