const { getPlatformDB, getTenantDB } = require('../db');
const { initTenantSchema } = require('../db/init');

// ─────────────────────────────────────────────────────────────────────────────
// Tenant migrations runner
//
// Called on every backend boot. Walks every non-deleted tenant and:
//   1. Re-runs the full tenant schema initializer (idempotent — only adds
//      missing columns, doesn't touch existing data).
//   2. Applies known data backfills for fixes that landed AFTER tenants
//      were already provisioned. Each backfill is written as an idempotent
//      SQL statement so it's safe to re-run forever.
//
// To add a new migration: append an entry to BACKFILLS below. Keep them
// idempotent — they run on every boot, against every tenant.
// ─────────────────────────────────────────────────────────────────────────────

const BACKFILLS = [
  {
    name: 'fill invite_expires_at on pending invites',
    sql: `
      UPDATE portal_users
      SET invite_expires_at = DATE_ADD(NOW(), INTERVAL 7 DAY)
      WHERE invite_token IS NOT NULL
        AND invite_expires_at IS NULL
        AND status = 'pending'
    `,
  },
  {
    name: 'create employees row for each sys-admin',
    sql: `
      INSERT IGNORE INTO employees
        (name, email, role, department, is_active, employment_status)
      SELECT pu.name, pu.email, 'Admin', 'Management', 1, 'permanent'
      FROM portal_users pu
      LEFT JOIN employees e ON e.email = pu.email
      WHERE pu.portal_role = 'sys-admin' AND e.id IS NULL
    `,
  },
  {
    name: 'link sys-admin portal_users.employee_id to their employees row',
    sql: `
      UPDATE portal_users pu
      JOIN employees e ON e.email = pu.email
      SET pu.employee_id = e.id
      WHERE pu.portal_role = 'sys-admin' AND pu.employee_id IS NULL
    `,
  },
];

async function migrateAllTenants() {
  const platform = getPlatformDB();
  const [tenants] = await platform.execute(
    `SELECT id, slug, db_name FROM tenants WHERE status IN ('active', 'suspended', 'expired')`
  );

  if (tenants.length === 0) {
    console.log('[migrations] no tenants to migrate.');
    return;
  }

  console.log(`[migrations] running schema + ${BACKFILLS.length} backfill(s) against ${tenants.length} tenant(s)...`);

  for (const t of tenants) {
    const pool = getTenantDB(t.db_name);
    try {
      await initTenantSchema(pool);
      for (const m of BACKFILLS) {
        try {
          await pool.execute(m.sql);
        } catch (e) {
          console.error(`[migrations]   ${t.slug}: backfill "${m.name}" failed:`, e.message);
        }
      }
      console.log(`[migrations]   ✓ ${t.slug}`);
    } catch (e) {
      console.error(`[migrations]   ✗ ${t.slug}:`, e.message);
    }
  }
}

module.exports = { migrateAllTenants };
