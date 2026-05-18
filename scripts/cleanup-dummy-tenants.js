#!/usr/bin/env node

// ─────────────────────────────────────────────────────────────────────────────
// cleanup-dummy-tenants.js
//
// One-off operational script. Drops every tenant DB and removes every
// platform.tenants row EXCEPT those in KEEP_SLUGS.
//
// Usage on the EC2 host:
//   node scripts/cleanup-dummy-tenants.js          # dry-run, prints plan
//   node scripts/cleanup-dummy-tenants.js --yes    # actually deletes
//
// Run from the hcm-backend directory so .env loads correctly.
//
// IRREVERSIBLE. Verify the dry-run output carefully before passing --yes.
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const mysql = require('mysql2/promise');

const KEEP_SLUGS = ['app']; // tenants to preserve
const DRY_RUN = !process.argv.includes('--yes');

function envStr(name, dflt) {
  const v = process.env[name];
  return (typeof v === 'string' ? v.trim() : v) || dflt;
}

async function main() {
  const host = envStr('DB_HOST', '127.0.0.1');
  const user = envStr('DB_USER', 'root');
  const pass = envStr('DB_PASS', '');
  const port = Number(envStr('DB_PORT', 3306));
  const platformDbName = envStr('PLATFORM_DB_NAME', 'tickin_platform');

  // Separate connections: one bound to the platform DB for SELECT/DELETE,
  // one server-level for DROP DATABASE.
  const platform = await mysql.createConnection({ host, user, password: pass, port, database: platformDbName });
  const server   = await mysql.createConnection({ host, user, password: pass, port });

  const [tenants] = await platform.execute(
    'SELECT id, slug, company_name, db_name, status, created_at FROM tenants ORDER BY created_at'
  );

  if (tenants.length === 0) {
    console.log('No tenants found.');
    await cleanup();
    return;
  }

  console.log(`\n${tenants.length} tenant(s) on platform:\n`);
  for (const t of tenants) {
    const action = KEEP_SLUGS.includes(t.slug) ? '  KEEP  ' : ' DELETE ';
    const created = new Date(t.created_at).toISOString().slice(0, 10);
    console.log(`  [${action}] ${t.slug.padEnd(20)} · ${(t.company_name || '').slice(0, 30).padEnd(30)} · db=${t.db_name.padEnd(28)} · status=${(t.status || '').padEnd(12)} · since ${created}`);
  }

  const toDelete = tenants.filter(t => !KEEP_SLUGS.includes(t.slug));
  if (toDelete.length === 0) {
    console.log('\nNothing to delete; only the keep-list tenants remain.');
    await cleanup();
    return;
  }

  console.log(`\n${toDelete.length} tenant(s) will be deleted. Their databases will be DROPPED.`);

  if (DRY_RUN) {
    console.log('\n[DRY RUN] Re-run with --yes to actually perform deletions.\n');
    await cleanup();
    return;
  }

  console.log('\n--yes detected. Proceeding in 5 seconds. Ctrl-C to abort.');
  await new Promise(r => setTimeout(r, 5000));

  let dropped = 0;
  let removedRows = 0;
  for (const t of toDelete) {
    console.log(`\n→ ${t.slug}`);
    try {
      await server.query(`DROP DATABASE IF EXISTS \`${t.db_name}\``);
      console.log(`    ✓ DROP DATABASE ${t.db_name}`);
      dropped++;
    } catch (e) {
      console.error(`    ✗ DROP DATABASE failed: ${e.message}`);
    }
    try {
      await platform.execute('DELETE FROM tenants WHERE id = ?', [t.id]);
      console.log(`    ✓ DELETE FROM tenants WHERE id=${t.id}`);
      removedRows++;
    } catch (e) {
      console.error(`    ✗ DELETE FROM tenants failed: ${e.message}`);
    }
  }

  console.log(`\nDone. Dropped ${dropped} database(s), removed ${removedRows} row(s).\n`);
  await cleanup();

  async function cleanup() {
    await platform.end().catch(() => {});
    await server.end().catch(() => {});
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
