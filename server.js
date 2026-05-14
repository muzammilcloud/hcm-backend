const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
require('dotenv').config();

const { validateEnv } = require('./config/env');
validateEnv();

const { initPlatformDB }    = require('./db/platform-init');
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
app.use(express.json());

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
app.use('/api/slack', slackRoutes);
app.use('/api', otRoutes);
// app.use('/api', resignationRoutes);  // disabled — uncomment to re-enable
app.use('/api', birthdayRoutes);
app.use('/api', portalRoutes);
app.use('/api', teamleadRoutes);
app.use('/api', adjustmentRoutes);
app.use('/api', notificationRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok', app: 'Tickin API' }));

app.use('/api', notFoundHandler);
app.use(errorHandler);

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

const PORT = process.env.PORT || 4000;
initPlatformDB().then(() => {
  scheduleReports();
  startOTChecker();
  app.listen(PORT, () => console.log(`🚀 Tickin backend running on port ${PORT}`));
}).catch(err => {
  console.error('❌ Failed to initialize platform DB:', err.message);
  process.exit(1);
});
