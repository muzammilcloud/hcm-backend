const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
require('dotenv').config();

const { validateEnv } = require('./config/env');
validateEnv();

const { initDB }         = require('./db/init');
const { startOTChecker } = require('./services/slack');
const { scheduleReports } = require('./services/scheduler');
const { authLimiter, passwordResetLimiter } = require('./middleware/rateLimit');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

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
const resignationRoutes = require('./routes/resignation');
const birthdayRoutes    = require('./routes/birthdays');
const portalRoutes      = require('./routes/portal');
const teamleadRoutes      = require('./routes/teamlead');
const adjustmentRoutes    = require('./routes/adjustments');
const notificationRoutes  = require('./routes/notifications');

const app = express();

// Trust the first reverse proxy hop (PM2 / nginx / load balancer) so
// req.ip and rate-limit keys reflect the real client, not the proxy.
app.set('trust proxy', 1);

// ── Security headers ───────────────────────────────────────────────────────
// helmet sets sensible defaults: X-Content-Type-Options, X-Frame-Options,
// Referrer-Policy, etc. CSP is not enabled here — it would need to be
// designed alongside the FE bundle/CDN.
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));

// ── CORS ───────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:5173').split(',');
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) cb(null, true);
    else cb(new Error('Not allowed by CORS'));
  }
}));
app.use(express.json());

// ── Slack — parse slash command bodies (application/x-www-form-urlencoded) ──
app.use('/api/slack', express.urlencoded({ extended: true }));

// ── Rate limits on sensitive auth endpoints ────────────────────────────────
// Mounted before the routes that own these paths so the limiter runs first.
app.use('/api/login',                     authLimiter);
app.use('/api/login/unified',             authLimiter);
app.use('/api/employee/login',            authLimiter);
app.use('/api/employee/forgot-password',  passwordResetLimiter);
app.use('/api/employee/reset-password',   authLimiter);
app.use('/api/invite',                    authLimiter);

// ── Routes ─────────────────────────────────────────────────────────────────
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
app.use('/api', resignationRoutes);
app.use('/api', birthdayRoutes);
app.use('/api', portalRoutes);
app.use('/api', teamleadRoutes);
app.use('/api', adjustmentRoutes);
app.use('/api', notificationRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok', app: 'Quecko-HCM API' }));

// 404 + error handler must come last.
app.use('/api', notFoundHandler);
app.use(errorHandler);

// Don't let an unhandled rejection crash the process silently.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
initDB().then(() => {
  scheduleReports();
  startOTChecker();
  app.listen(PORT, () => console.log(`🚀 Quecko-HCM backend running on port ${PORT}`));
}).catch(err => {
  console.error('❌ Failed to connect to database:', err.message);
  process.exit(1);
});
