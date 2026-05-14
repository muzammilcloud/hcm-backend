#!/usr/bin/env node
// One-time migration: take the existing single-tenant database and make it
// the `app` tenant so it keeps working at https://app.tickin.pro after the
// multi-tenant rollout.
//
// What it does:
//   1. Create platform DB and the `app` tenant DB
//   2. Copy all data from the existing single-tenant DB → `tickin_app`
//   3. Register a tenants row { slug: 'app', plan: 'paid', status: 'active' }
//   4. Leave the source DB intact (you can drop it manually after verifying)
//
// Usage:
//   node scripts/migrate-to-multitenant.js
//
// Env:
//   SOURCE_DB        Name of the existing single-tenant DB (default: tickin-db)
//   APP_TENANT_NAME  Company name shown on app.tickin.pro (default: "Quecko")
//   PLATFORM_DB_NAME (from db.js default: tickin_platform)
//   TENANT_DB_PREFIX (from db.js default: tickin_)

require('dotenv').config();
const mysql = require('mysql2/promise');
const { PLATFORM_DB_NAME, TENANT_DB_PREFIX } = require('../db');

const SOURCE_DB  = process.env.SOURCE_DB || 'tickin-db';
const TENANT_SLUG = 'app';
const TENANT_DB  = `${TENANT_DB_PREFIX}${TENANT_SLUG}`;
const COMPANY    = process.env.APP_TENANT_NAME || 'Quecko';
const CONTACT    = process.env.PLATFORM_OWNER_EMAIL || 'admin@tickin.pro';

const BASE_CONN = {
  host:     process.env.DB_HOST     || 'localhost',
  port:     Number(process.env.DB_PORT) || 3306,
  user:     process.env.DB_USER     || 'root',
  password: process.env.DB_PASSWORD || '',
  multipleStatements: true,
};

async function ensurePlatformDB(conn) {
  console.log(`▶ Creating platform DB '${PLATFORM_DB_NAME}'...`);
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${PLATFORM_DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
}

async function copyDatabase(conn, fromDb, toDb) {
  console.log(`▶ Creating target DB '${toDb}'...`);
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${toDb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

  console.log(`▶ Listing tables in '${fromDb}'...`);
  const [tables] = await conn.query(
    `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name`,
    [fromDb]
  );
  if (tables.length === 0) {
    throw new Error(`Source DB '${fromDb}' has no tables. Set SOURCE_DB env var to the right name.`);
  }

  console.log(`  Found ${tables.length} tables.`);

  // Disable FK checks during copy so any table order works.
  await conn.query('SET FOREIGN_KEY_CHECKS = 0');

  for (const { t } of tables) {
    process.stdout.write(`  · ${t} ... `);
    await conn.query(`DROP TABLE IF EXISTS \`${toDb}\`.\`${t}\``);
    await conn.query(`CREATE TABLE \`${toDb}\`.\`${t}\` LIKE \`${fromDb}\`.\`${t}\``);
    await conn.query(`INSERT INTO \`${toDb}\`.\`${t}\` SELECT * FROM \`${fromDb}\`.\`${t}\``);
    const [[{ c }]] = await conn.query(`SELECT COUNT(*) AS c FROM \`${toDb}\`.\`${t}\``);
    console.log(`copied (${c} rows)`);
  }

  await conn.query('SET FOREIGN_KEY_CHECKS = 1');
}

async function registerTenant(conn) {
  console.log(`▶ Registering tenant row { slug: '${TENANT_SLUG}', plan: 'paid' }...`);
  await conn.query(`USE \`${PLATFORM_DB_NAME}\``);

  // Make sure tenants table exists (the backend creates it on boot, but this
  // script can run before the backend ever started)
  await conn.query(`
    CREATE TABLE IF NOT EXISTS tenants (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      slug            VARCHAR(63) NOT NULL UNIQUE,
      company_name    VARCHAR(255) NOT NULL,
      db_name         VARCHAR(64) NOT NULL UNIQUE,
      contact_email   VARCHAR(255) NOT NULL,
      status          ENUM('provisioning','active','suspended','expired','deleted') NOT NULL DEFAULT 'provisioning',
      plan            ENUM('demo','trial','paid') NOT NULL DEFAULT 'demo',
      trial_ends_at   DATETIME NULL,
      suspended_at    DATETIME NULL,
      deleted_at      DATETIME NULL,
      stripe_customer_id      VARCHAR(64) NULL,
      stripe_subscription_id  VARCHAR(64) NULL,
      metadata        JSON NULL,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenants_status (status),
      INDEX idx_tenants_plan (plan)
    ) ENGINE=InnoDB
  `);

  await conn.query(
    `INSERT INTO tenants (slug, company_name, db_name, contact_email, status, plan)
     VALUES (?, ?, ?, ?, 'active', 'paid')
     ON DUPLICATE KEY UPDATE status='active', plan='paid', db_name=VALUES(db_name)`,
    [TENANT_SLUG, COMPANY, TENANT_DB, CONTACT]
  );
}

async function main() {
  const conn = await mysql.createConnection(BASE_CONN);
  try {
    await ensurePlatformDB(conn);
    await copyDatabase(conn, SOURCE_DB, TENANT_DB);
    await registerTenant(conn);
    console.log('');
    console.log('✅ Migration complete.');
    console.log('');
    console.log(`   Source kept intact:   ${SOURCE_DB}`);
    console.log(`   New tenant DB:        ${TENANT_DB}`);
    console.log(`   Platform DB:          ${PLATFORM_DB_NAME}`);
    console.log(`   Subdomain:            app.tickin.pro`);
    console.log('');
    console.log('   Next steps:');
    console.log('     1. Smoke-test app.tickin.pro logs in with existing creds');
    console.log('     2. Once verified, DROP DATABASE `' + SOURCE_DB + '`;');
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error('');
  console.error('❌ Migration failed:', e.message);
  process.exit(1);
});
