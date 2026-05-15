const express = require('express');
const router  = express.Router();
const { getDB } = require('../db');
const { requireAdmin } = require('../middleware/auth');

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/setup/checklist
//
// Returns a list of "first-run" tasks the sysadmin should complete. Each
// item has a `complete` flag the FE uses to render check marks + progress.
// The endpoint is read-only and cheap — it runs ~6 small queries against
// the tenant DB. No external calls.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/setup/checklist', requireAdmin, async (req, res, next) => {
  try {
    const pool = await getDB();
    const items = [];

    // 1. Workspace settings — company name + country + currency
    const [settingsRows] = await pool.execute(
      'SELECT company_name, country_code, currency FROM tenant_settings WHERE singleton_key = 1 LIMIT 1'
    ).catch(() => [[]]);
    const s = settingsRows[0] || {};
    items.push({
      id: 'workspace',
      label: 'Set up your workspace',
      detail: 'Company name, country and currency',
      tab: 'settings',
      required: true,
      complete: Boolean(s.company_name && s.country_code && s.currency),
    });

    // 2. Tax brackets confirmed (or zero-tax country)
    let taxComplete = false;
    try {
      const [metaRows] = await pool.execute(
        'SELECT confirmed, tax_enabled FROM tax_bracket_meta WHERE singleton_key = 1 LIMIT 1'
      );
      taxComplete = metaRows.length > 0 && (metaRows[0].confirmed === 1 || metaRows[0].tax_enabled === 0);
    } catch (_) { /* table may not exist yet */ }
    items.push({
      id: 'tax',
      label: 'Confirm tax brackets',
      detail: 'Auto-loaded from your country — review and confirm',
      tab: 'salary-tax',
      required: true,
      complete: taxComplete,
    });

    // 3. At least one custom salary component (Basic Salary alone doesn't count)
    let componentsComplete = false;
    try {
      const [[{ c }]] = await pool.execute(
        `SELECT COUNT(*) AS c FROM salary_components WHERE system_managed = 0 AND active = 1`
      );
      componentsComplete = Number(c) > 0;
    } catch (_) {}
    items.push({
      id: 'components',
      label: 'Add salary components',
      detail: 'Earnings (allowances, bonuses) and deductions (PF, insurance, etc.)',
      tab: 'salary-components',
      required: false,
      complete: componentsComplete,
    });

    // 4. Slack integration connected (optional)
    let slackComplete = false;
    try {
      const [[{ c }]] = await pool.execute(
        `SELECT COUNT(*) AS c FROM tenant_integrations WHERE integration_type = 'slack' AND config_encrypted IS NOT NULL`
      );
      slackComplete = Number(c) > 0;
    } catch (_) {}
    items.push({
      id: 'slack',
      label: 'Connect your Slack',
      detail: 'Optional — send clock-in prompts and OT confirmations to Slack',
      tab: 'integrations',
      required: false,
      complete: slackComplete,
    });

    // 5. SMTP integration connected (optional)
    let smtpComplete = false;
    try {
      const [[{ c }]] = await pool.execute(
        `SELECT COUNT(*) AS c FROM tenant_integrations WHERE integration_type = 'smtp' AND config_encrypted IS NOT NULL`
      );
      smtpComplete = Number(c) > 0;
    } catch (_) {}
    items.push({
      id: 'smtp',
      label: 'Connect your email server',
      detail: 'Optional — send invites and reports from your own domain',
      tab: 'integrations',
      required: false,
      complete: smtpComplete,
    });

    // 6. First team member invited (more than just the sys-admin)
    let invitedComplete = false;
    try {
      const [[{ c }]] = await pool.execute(
        `SELECT COUNT(*) AS c FROM portal_users WHERE portal_role != 'sys-admin'`
      );
      invitedComplete = Number(c) > 0;
    } catch (_) {}
    items.push({
      id: 'invite',
      label: 'Invite your first team member',
      detail: 'Send an invite from Portal Access',
      tab: 'invites',
      required: false,
      complete: invitedComplete,
    });

    const total           = items.length;
    const done            = items.filter(i => i.complete).length;
    const requiredDone    = items.filter(i => i.required && i.complete).length;
    const requiredTotal   = items.filter(i => i.required).length;
    const percent         = total > 0 ? Math.round((done / total) * 100) : 0;

    res.json({
      items,
      total,
      done,
      percent,
      all_required_complete: requiredDone === requiredTotal,
    });
  } catch (e) { next(e); }
});

module.exports = router;
