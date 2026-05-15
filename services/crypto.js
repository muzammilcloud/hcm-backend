const crypto = require('node:crypto');

// ─────────────────────────────────────────────────────────────────────────────
// Symmetric encryption for tenant-stored secrets (Slack tokens, SMTP passwords,
// API keys). AES-256-GCM with a random 12-byte IV per encryption + 16-byte
// auth tag concatenated and base64'd:
//
//   stored = base64(iv || authTag || ciphertext)
//
// The key comes from INTEGRATION_ENCRYPTION_KEY (env). If absent, we derive
// a deterministic-but-warning key from PLATFORM_OWNER_PASSWORD so existing
// deployments boot without a config change — but the boot logs nag the
// operator to set it explicitly so the key isn't tied to admin password.
// ─────────────────────────────────────────────────────────────────────────────

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

let cachedKey = null;
let warnedDerived = false;

function loadKey() {
  if (cachedKey) return cachedKey;
  const raw = (process.env.INTEGRATION_ENCRYPTION_KEY || '').trim();
  if (raw) {
    // Accept hex (64 chars) or base64 (44 chars). 32 bytes either way.
    let buf;
    try {
      if (/^[0-9a-fA-F]{64}$/.test(raw)) buf = Buffer.from(raw, 'hex');
      else                                buf = Buffer.from(raw, 'base64');
    } catch (_) { buf = null; }
    if (buf && buf.length === 32) {
      cachedKey = buf;
      return cachedKey;
    }
    console.warn('[crypto] INTEGRATION_ENCRYPTION_KEY is set but not a valid 32-byte hex/base64 value. Falling back to derived key.');
  }
  // Fallback: deterministic key derived from a stable platform secret. Same
  // process always produces the same key. The boot warning encourages an
  // explicit value so the key isn't tied to admin password changes.
  if (!warnedDerived) {
    console.warn('[crypto] ⚠ INTEGRATION_ENCRYPTION_KEY not set — using a derived key. Set a stable 32-byte hex value in your env to avoid losing access to encrypted integrations on credential rotation.');
    warnedDerived = true;
  }
  const seed = (process.env.PLATFORM_OWNER_PASSWORD || process.env.ADMIN_PASSWORD || 'tickin-default-seed') + '|integration-encryption-key';
  cachedKey = crypto.createHash('sha256').update(seed).digest();
  return cachedKey;
}

function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') return null;
  const key = loadKey();
  const iv  = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

function decrypt(encoded) {
  if (encoded == null || encoded === '') return null;
  try {
    const key = loadKey();
    const buf = Buffer.from(encoded, 'base64');
    if (buf.length < IV_LEN + TAG_LEN) return null;
    const iv  = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ct  = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  } catch (e) {
    console.error('[crypto] decrypt failed:', e.message);
    return null;
  }
}

// Encrypt all string values in an object (used to store the whole config
// blob as one ciphertext rather than per-field).
function encryptJson(obj) {
  if (!obj) return null;
  return encrypt(JSON.stringify(obj));
}
function decryptJson(s) {
  const raw = decrypt(s);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// Mask a secret for safe display: show last 4 chars only.
function mask(value) {
  if (!value) return '';
  const s = String(value);
  if (s.length <= 4) return '••••';
  return '•'.repeat(Math.min(s.length - 4, 12)) + s.slice(-4);
}

module.exports = { encrypt, decrypt, encryptJson, decryptJson, mask };
