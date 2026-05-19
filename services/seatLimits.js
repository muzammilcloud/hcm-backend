const { getDB, getPlatformDB } = require('../db');

// ─────────────────────────────────────────────────────────────────────────────
// Per-tenant seat limit enforcement.
//
// Hard caps are the soft-limit × 1.6 — i.e. Starter (limit 10) hard-blocks at
// 16, Growth (limit 100) hard-blocks at 160. Between the soft and hard limit,
// the admin UI shows escalating banners (already shipped in
// components/admin/AdminEmployees.jsx).
//
// Plans 'demo' / 'trial' (the legacy values) are treated as Starter caps so
// existing tenants that haven't been migrated to the new plan ENUM still get
// reasonable behavior.
// ─────────────────────────────────────────────────────────────────────────────

const SOFT_LIMITS = {
  starter:  10,
  growth:   100,
  business: null, // unlimited
  demo:     10,
  trial:    10,
  paid:     null, // legacy "paid" → treat as unlimited until migrated
};

const HARD_RATIO = 1.6;
function hardCap(soft) {
  return soft == null ? null : Math.floor(soft * HARD_RATIO);
}

async function getTenantPlan(tenantId) {
  const platform = getPlatformDB();
  const [rows] = await platform.execute(
    'SELECT plan FROM tenants WHERE id = ? LIMIT 1', [tenantId]
  );
  return rows[0]?.plan || 'starter';
}

async function getCurrentSeatCount() {
  // Active employees only — inactive rows are kept for history but don't
  // consume a seat. Aligned with how the admin Employees count displays.
  const pool = await getDB();
  const [rows] = await pool.execute(
    'SELECT COUNT(*) AS n FROM employees WHERE is_active = 1'
  );
  return Number(rows[0]?.n || 0);
}

// checkSeatLimit(req) — returns { atHardCap, hardCap, softLimit, current, plan }
async function checkSeatLimit(req) {
  const tenantId = req.tenant?.id;
  if (!tenantId) {
    // No tenant context — running against the platform DB. Don't block.
    return { atHardCap: false, hardCap: null, softLimit: null, current: 0, plan: null };
  }
  const plan = await getTenantPlan(tenantId);
  const softLimit = SOFT_LIMITS[plan];
  const hard = hardCap(softLimit);
  const current = await getCurrentSeatCount();
  return {
    plan,
    softLimit,
    hardCap: hard,
    current,
    atHardCap: hard != null && current >= hard,
  };
}

// Middleware-ish helper for the employee-create routes. Returns true if the
// request was rejected (and the caller should return early). The 402 payload
// matches what the AdminEmployees frontend already understands.
async function rejectIfAtSeatCap(req, res) {
  try {
    const limit = await checkSeatLimit(req);
    if (limit.atHardCap) {
      res.status(402).json({
        error: `You're at your ${limit.plan} plan seat limit (${limit.current} of ${limit.hardCap}). Upgrade to keep adding employees.`,
        code: 'SEAT_LIMIT_REACHED',
        plan:        limit.plan,
        soft_limit:  limit.softLimit,
        hard_cap:    limit.hardCap,
        current:     limit.current,
      });
      return true;
    }
  } catch (e) {
    // Don't block employee creation on a check failure — log and fall through.
    console.error('[seatLimits] check failed:', e.message);
  }
  return false;
}

module.exports = {
  SOFT_LIMITS,
  HARD_RATIO,
  hardCap,
  checkSeatLimit,
  rejectIfAtSeatCap,
  getCurrentSeatCount,
};
