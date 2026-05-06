const mysql  = require('mysql2/promise');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

let db;
async function getDB() {
  if (!db) {
    db = await mysql.createPool({
      host:     process.env.DB_HOST     || 'localhost',
      port:     process.env.DB_PORT     || 3306,
      user:     process.env.DB_USER     || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME     || 'queckots',
      waitForConnections: true,
      connectionLimit: 10,
      dateStrings: ['DATE'],
    });
  }
  return db;
}

// Legacy SHA-256 (unsalted). Kept ONLY for verifying pre-bcrypt password hashes
// already in the database — never used to hash new passwords.
const legacySha256 = (pw) => crypto.createHash('sha256').update(pw).digest('hex');

// Hash a fresh password. Always bcrypt going forward.
const hashPassword = (pw) => bcrypt.hashSync(pw, 10);

// Verify a submitted password against the stored hash.
// Returns { ok: boolean, needsRehash: boolean }.
// `needsRehash` flags legacy SHA-256 hits so the caller can transparently
// upgrade the user's stored hash on next successful login.
function verifyPassword(pw, storedHash) {
  if (!pw || !storedHash) return { ok: false, needsRehash: false };

  // bcrypt hashes always start with $2
  if (storedHash.startsWith('$2')) {
    return { ok: bcrypt.compareSync(pw, storedHash), needsRehash: false };
  }

  // Legacy 64-char hex (SHA-256). Constant-time compare.
  if (storedHash.length === 64 && /^[0-9a-f]+$/i.test(storedHash)) {
    const candidate = legacySha256(pw);
    const a = Buffer.from(candidate, 'hex');
    const b = Buffer.from(storedHash, 'hex');
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    return { ok, needsRehash: ok };
  }

  return { ok: false, needsRehash: false };
}

const generateToken = () => crypto.randomBytes(32).toString('hex');

async function logEvent(pool, { employee_id, employee_name, department, role, event, detail }) {
  try {
    await pool.execute(
      'INSERT INTO employee_logs (employee_id, employee_name, department, role, event, detail) VALUES (?,?,?,?,?,?)',
      [employee_id || null, employee_name, department || null, role || null, event, detail || null]
    );
  } catch (e) { console.error('Log error:', e.message); }
}

module.exports = { getDB, hashPassword, verifyPassword, generateToken, logEvent };
