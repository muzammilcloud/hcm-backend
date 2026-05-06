const express = require('express');
const cors    = require('cors');
require('dotenv').config();

const { initDB }         = require('./db/init');
const { startOTChecker } = require('./services/slack');
const { scheduleReports } = require('./services/scheduler');

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
