const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
require('dotenv').config();

const { validateEnv } = require('./config/env');
validateEnv();

const { initPlatformDB }    = require('./db/platform-init');
const { migrateAllTenants } = require('./services/migrations');
const { startOTChecker }    = require('./services/slack');
const { scheduleReports }   = require('./services/scheduler');
const { tenantMiddleware }  = require('./middleware/tenant');
const { authLimiter, passwordResetLimiter } = require('./middleware/rateLimit');
const { errorHandler, notFoundHandler }     = require('./middleware/errorHandler');

// Tenant-scoped routes (each runs against req.tenant's DB via getDB)
const authRoutes      = require('./routes/auth');
const employeeRoutes  = require('./routes/employees');
const empAuthRoutes   = require('./routes/employee.auth');
const timeRoutes      = require('./routes/time');
const salaryRoutes    = require('./routes/salary');
const leavesRoutes    = require('./routes/leaves');
const shiftsRoutes    = require('./routes/shifts');
const reportsRoutes   = require('./routes/reports');
const slackRoutes     = require('./routes/slack');
const lineworksRoutes = require('./routes/lineworks');
const otRoutes          = require('./routes/ot');
// const resignationRoutes = require('./routes/resignation');  // disabled — uncomment to re-enable
const birthdayRoutes    = require('./routes/birthdays');
const portalRoutes      = require('./routes/portal');
const teamleadRoutes    = require('./routes/teamlead');
const adjustmentRoutes  = require('./routes/adjustments');
const notificationRoutes = require('./routes/notifications');

// Platform-scoped routes (run against the platform DB)
const signupRoutes      = require('./routes/signup');
const platformRoutes    = require('./routes/platform');

// Tenant-scoped settings (workspace currency/country presets)
const settingsRoutes    = require('./routes/settings');
const salaryComponentsRoutes = require('./routes/salaryComponents');
const salaryTaxRoutes        = require('./routes/salaryTax');
const salarySlipRoutes       = require('./routes/salarySlip');
const integrationsRoutes     = require('./routes/integrations');
const setupRoutes            = require('./routes/setup');
const auditRoutes            = require('./routes/audit');
const billingRoutes          = require('./routes/billing');
const desktopRoutes          = require('./routes/desktop');
const featuresRoutes         = require('./routes/features');
const polarWebhookRoutes     = require('./routes/webhooks/polar');
const { router: googleAuthRoutes } = require('./routes/googleAuth');

const app = express();

app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));

// ── CORS ───────────────────────────────────────────────────────────────────
// Multi-tenant: accept any subdomain of APEX_DOMAIN (default tickin.pro) plus
// explicit overrides from FRONTEND_URL.
const explicitOrigins = (process.env.FRONTEND_URL || '').split(',').map(s => s.trim()).filter(Boolean);
const APEX_DOMAIN = process.env.APEX_DOMAIN || 'tickin.pro';
const apexSubdomainRe = new RegExp(`^https?://([a-z0-9-]+\\.)?${APEX_DOMAIN.replace(/\./g, '\\.')}(:\\d+)?$`, 'i');
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (explicitOrigins.length && explicitOrigins.includes(origin)) return cb(null, true);
    if (apexSubdomainRe.test(origin)) return cb(null, true);
    if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return cb(null, true);
    return cb(new Error(`Not allowed by CORS: ${origin}`));
  },
  exposedHeaders: ['X-Tenant'],
}));
// Polar webhooks need the RAW body for signature verification — MUST be
// registered before express.json() so the JSON parser doesn't consume
// (and re-stringify) the bytes the HMAC was computed over.
app.use('/webhooks', polarWebhookRoutes);

// Capture the raw body so webhook signatures (e.g. LINE WORKS X-WORKS-Signature)
// can be verified against the exact bytes received.
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

// Slack — parse slash command bodies
app.use('/api/slack', express.urlencoded({ extended: true }));

// Rate limits
app.use('/api/login',                     authLimiter);
app.use('/api/login/unified',             authLimiter);
app.use('/api/employee/login',            authLimiter);
app.use('/api/employee/forgot-password',  passwordResetLimiter);
app.use('/api/employee/reset-password',   authLimiter);
app.use('/api/invite',                    authLimiter);
app.use('/api/signup',                    authLimiter);
app.use('/api/platform/login',            authLimiter);

// Resolve the tenant for every non-platform request. Platform paths
// (/api/platform/*, /api/signup, /api/slug-*, /api/tenant/*, /health)
// skip this and run against the platform DB.
app.use(tenantMiddleware);

// Platform (control-plane) routes
app.use('/api', signupRoutes);
app.use('/api', platformRoutes);

// Tenant-scoped routes
app.use('/api', authRoutes);
app.use('/api', employeeRoutes);
app.use('/api', empAuthRoutes);
app.use('/api', timeRoutes);
app.use('/api', salaryRoutes);
app.use('/api', leavesRoutes);
app.use('/api', shiftsRoutes);
app.use('/api', reportsRoutes);
app.use('/api/slack/:slug', slackRoutes);   // /api/slack/<slug>/<command> — self-resolves tenant from the slug
app.use('/api', lineworksRoutes);   // /api/lineworks/callback/:slug — self-resolves tenant
app.use('/api', otRoutes);
// app.use('/api', resignationRoutes);  // disabled — uncomment to re-enable
app.use('/api', birthdayRoutes);
app.use('/api', portalRoutes);
app.use('/api', teamleadRoutes);
app.use('/api', adjustmentRoutes);
app.use('/api', notificationRoutes);
app.use('/api', settingsRoutes);
app.use('/api', salaryComponentsRoutes);
app.use('/api', salaryTaxRoutes);
app.use('/api', salarySlipRoutes);
app.use('/api', integrationsRoutes);
app.use('/api', setupRoutes);
app.use('/api', auditRoutes);
app.use('/api', billingRoutes);
app.use('/api', desktopRoutes);
app.use('/api', featuresRoutes);
app.use('/api', googleAuthRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok', app: 'Tickin API' }));

app.use('/api', notFoundHandler);
app.use(errorHandler);

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

const PORT = process.env.PORT || 4000;
// Listen FIRST (right after the platform DB is up) so /health responds within
// seconds, then run the per-tenant migrations in the BACKGROUND.
//
// Why this is safe: migrateAllTenants() is SEQUENTIAL — one tenant at a time —
// so memory stays low (the earlier OOM was from running tenants CONCURRENTLY,
// which we no longer do). Existing tenants already have their schema, so the
// background re-apply is idempotent and serving during it is safe.
//
// Why this matters: migrate-then-listen blocked /health until all tenants
// finished, so once the tenant count grew the healthcheck timed out and EVERY
// deploy failed. Listen-first keeps deploys fast + reliable regardless of scale.
// Retry the platform DB connection at startup instead of dying on the first
// hiccup. MySQL can be briefly unreachable during a deploy or its own restart;
// without this the API exits (1), the container has no replacement, and prod
// goes down — exactly the outage we just had (ECONNREFUSED …:3306).
async function initPlatformDBWithRetry(attempts = 30, delayMs = 3000) {
  for (let i = 1; i <= attempts; i++) {
    try { await initPlatformDB(); return; }
    catch (e) {
      console.error(`[startup] platform DB not ready (attempt ${i}/${attempts}): ${e.message}`);
      if (i === attempts) throw e;
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

initPlatformDBWithRetry()
  .then(() => {
    // Schedulers must NEVER crash startup — isolate them so a throw here can't
    // take the whole process down (exit 1) and leave prod with no container.
    try { scheduleReports(); } catch (e) { console.error('[startup] scheduleReports failed:', e.message); }
    try { startOTChecker(); }  catch (e) { console.error('[startup] startOTChecker failed:', e.message); }
    app.listen(PORT, () => console.log(`🚀 Tickin backend running on port ${PORT}`));
    // Fire-and-forget; sequential inside, errors isolated per tenant.
    migrateAllTenants()
      .then(() => console.log('[migrations] background migration complete'))
      .catch(err => console.error('[migrations] background migration error:', err.message));
  })
  .catch(err => {
    // Only a genuinely fatal platform-DB failure should exit. Even then, log
    // loudly so the deploy/candidate logs make the cause obvious.
    console.error('❌ Fatal: platform DB init failed:', err.message);
    process.exit(1);
  });
