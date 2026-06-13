// Validate environment configuration at startup. Fail loudly with a clear
// message instead of crashing mid-request when something's missing.

const REQUIRED = [
  'DB_HOST',
  'DB_USER',
  'DB_NAME',
  // DB_PASSWORD intentionally omitted: empty password is valid for local dev.
];

const RECOMMENDED = [
  'FRONTEND_URL',     // CORS allowlist; falls back to localhost:5173 if missing
  'ADMIN_USERNAME',   // Legacy admin login still works on defaults if missing
  'ADMIN_PASSWORD',
  // Slack (SLACK_BOT_TOKEN / SLACK_SIGNING_SECRET) and SMTP (SMTP_HOST / SMTP_USER
  // / SMTP_PASS) are intentionally NOT listed: they are configured per-tenant now
  // (Slack via the /api/slack/<slug> integration + getSlackCreds; SMTP per-tenant),
  // so a global value isn't required and warning about it at startup is just noise.
];

function validateEnv() {
  const missing = REQUIRED.filter(k => !process.env[k]);
  if (missing.length) {
    console.error('\n❌ Missing required environment variables:');
    missing.forEach(k => console.error(`   - ${k}`));
    console.error('\nSet them in .env or via your process manager. Aborting.\n');
    process.exit(1);
  }

  const lacking = RECOMMENDED.filter(k => !process.env[k]);
  if (lacking.length) {
    console.warn('\n⚠️  Recommended environment variables not set (some features will be disabled):');
    lacking.forEach(k => console.warn(`   - ${k}`));
    console.warn('');
  }

  // Production-only sanity checks.
  if (process.env.NODE_ENV === 'production') {
    if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === 'admin123') {
      console.error('❌ ADMIN_PASSWORD is using the default in production. Set a strong value.');
      process.exit(1);
    }
    if (!process.env.FRONTEND_URL) {
      console.error('❌ FRONTEND_URL must be set in production for CORS to be safe.');
      process.exit(1);
    }
  }
}

module.exports = { validateEnv };
