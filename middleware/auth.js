const { getDB } = require('../db');
const { tenantHas } = require('../services/features');

// These middlewares authenticate against TENANT tables (portal_users / sessions).
// If there's no tenant context (e.g. a request that landed on a platform
// subdomain like admin.tickin.pro), getDB() would fall back to the platform DB
// and the query would fail with a raw "Table 'tickin_platform.portal_users'
// doesn't exist" error. Guard against that and return a clean 401 instead.
function hasTenant(req) { return !!req.tenant; }

async function requireAdmin(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  if (!hasTenant(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const pool = await getDB();

    // 1. Legacy env-var admin session
    const [adminRows] = await pool.execute(
      `SELECT a.id, a.username FROM admin_sessions s
       LEFT JOIN admins a ON a.id = s.admin_id
       WHERE s.token = ? AND s.expires_at > NOW()`,
      [token]
    );
    if (adminRows.length > 0) {
      req.adminId = adminRows[0].id;
      req.user = { id: adminRows[0].id, email: adminRows[0].username, role: 'legacy-admin' };
      return next();
    }

    // 2. Sys-admin portal session
    const [portalRows] = await pool.execute(
      `SELECT ps.portal_user_id, pu.email, pu.name, pu.portal_role
       FROM portal_sessions ps
       JOIN portal_users pu ON ps.portal_user_id = pu.id
       WHERE ps.token = ? AND ps.expires_at > NOW() AND pu.portal_role = 'sys-admin'`,
      [token]
    );
    if (portalRows.length > 0) {
      req.adminId      = 1; // virtual — satisfies routes that reference req.adminId
      req.portalUserId = portalRows[0].portal_user_id;
      req.isSysAdmin   = true;
      req.user         = {
        id: portalRows[0].portal_user_id,
        email: portalRows[0].email,
        name: portalRows[0].name,
        role: portalRows[0].portal_role,
      };
      return next();
    }

    return res.status(401).json({ error: 'Session expired. Please login again.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

async function requireEmployee(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  if (!hasTenant(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const pool = await getDB();
    const [rows] = await pool.execute(
      'SELECT * FROM portal_sessions WHERE token = ? AND expires_at > NOW()',
      [token]
    );
    if (rows.length === 0) return res.status(401).json({ error: 'Session expired. Please login again.' });
    req.portalUserId = rows[0].portal_user_id;
    req.employeeId   = rows[0].portal_user_id;
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
}

async function requireTeamLead(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  if (!hasTenant(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const pool = await getDB();
    const [rows] = await pool.execute(
      `SELECT ps.portal_user_id, pu.portal_role, pu.department, pu.employee_id
       FROM portal_sessions ps
       JOIN portal_users pu ON ps.portal_user_id = pu.id
       WHERE ps.token = ? AND ps.expires_at > NOW()
       AND pu.portal_role IN ('team-lead', 'sys-admin')`,
      [token]
    );
    if (rows.length === 0) return res.status(401).json({ error: 'Session expired or insufficient permissions.' });
    req.portalUserId        = rows[0].portal_user_id;
    req.employeeId          = rows[0].portal_user_id;
    req.teamDepartment      = rows[0].department;
    req.portalRole          = rows[0].portal_role;
    req.teamLeadEmployeeId  = rows[0].employee_id;
    // A tenant that downgraded to Starter loses the team-lead stage, so block
    // residual team-lead API access for actual team-leads (sys-admins always pass).
    if (rows[0].portal_role === 'team-lead' && !tenantHas(req.tenant, 'team_lead_role')) {
      return res.status(402).json({ error: 'Team-lead features require the Growth plan.', code: 'FEATURE_LOCKED', feature: 'team_lead_role' });
    }
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
}

module.exports = { requireAdmin, requireEmployee, requireTeamLead };
