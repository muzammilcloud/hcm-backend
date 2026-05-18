const express = require('express');
const router  = express.Router();
const { OAuth2Client } = require('google-auth-library');
const { getDB, generateToken } = require('../db');
const { recordAudit } = require('../services/audit');

// ─────────────────────────────────────────────────────────────────────────────
// Google Sign-In (Google Identity Services / id_token flow).
//
// Frontend renders a "Continue with Google" button via the GIS library.
// On success, GIS returns a signed JWT id_token to the client. The client
// POSTs the id_token here. We verify it server-side with Google's published
// keys, look up the matching portal_user by google_sub OR email (in the
// current tenant's DB), and issue a session token.
//
// We never trust the client-side decoded JWT for auth — only the result of
// verifyIdToken() (which checks signature, expiry, audience, issuer).
// ─────────────────────────────────────────────────────────────────────────────

const CLIENT_ID = (process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim();

if (!CLIENT_ID) {
  console.warn('[google-auth] GOOGLE_OAUTH_CLIENT_ID is not set; /api/auth/google/* routes will reject every request.');
}

const verifier = new OAuth2Client(CLIENT_ID);

async function verifyGoogleIdToken(idToken) {
  if (!CLIENT_ID) {
    throw new Error('Google sign-in is not configured on this server.');
  }
  const ticket = await verifier.verifyIdToken({
    idToken,
    audience: CLIENT_ID,
  });
  const payload = ticket.getPayload();
  if (!payload) throw new Error('Invalid Google token.');
  if (!payload.email_verified) throw new Error('Google email is not verified.');
  return payload;
}

// POST /api/auth/google/verify
// Body: { id_token: string }
// Resolves to a portal session if the Google email matches an existing,
// active portal_user in the current tenant. Otherwise 404.
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

    // 1. Match by google_sub first (most reliable; survives email changes
    //    on the Google side). 2. Fall back to email match for first-time
    //    Google sign-in, and link the sub on success.
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

    // Link google_sub on first successful Google login.
    if (!pu.google_sub) {
      try {
        await pool.execute('UPDATE portal_users SET google_sub = ? WHERE id = ?', [googleSub, pu.id]);
      } catch (e) {
        // If another user has this google_sub (would be a unique-key violation),
        // surface a clearer error rather than a 500.
        if (e.code === 'ER_DUP_ENTRY') {
          return res.status(409).json({ error: 'This Google account is already linked to a different Tickin user.' });
        }
        throw e;
      }
    }

    const token     = generateToken();
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
    await pool.execute('DELETE FROM portal_sessions WHERE portal_user_id = ?', [pu.id]);
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

// POST /api/auth/google/decode
// Used by the signup page to pre-fill the form with the Google profile data.
// We still verify the token here so a malicious client can't inject arbitrary
// email values. No session is created.
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
