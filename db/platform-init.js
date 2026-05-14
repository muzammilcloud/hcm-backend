const { getServerDB, getPlatformDB, PLATFORM_DB_NAME } = require('../db');

// Bootstrap the platform-level database and its tables. Idempotent.
async function initPlatformDB() {
  const server = getServerDB();
  await server.execute(
    `CREATE DATABASE IF NOT EXISTS \`${PLATFORM_DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );

  const db = getPlatformDB();

  await db.execute(`
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
      INDEX idx_tenants_plan (plan),
      INDEX idx_tenants_trial_ends_at (trial_ends_at)
    ) ENGINE=InnoDB
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS platform_admins (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      email           VARCHAR(255) NOT NULL UNIQUE,
      name            VARCHAR(255) NOT NULL,
      password_hash   VARCHAR(255) NOT NULL,
      role            ENUM('owner','admin') NOT NULL DEFAULT 'admin',
      last_login_at   DATETIME NULL,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS platform_sessions (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      platform_admin_id INT NOT NULL,
      token           VARCHAR(255) NOT NULL UNIQUE,
      expires_at      DATETIME NOT NULL,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (platform_admin_id) REFERENCES platform_admins(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS tenant_signups (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id       INT NULL,
      first_name      VARCHAR(100) NOT NULL,
      last_name       VARCHAR(100) NOT NULL,
      email           VARCHAR(255) NOT NULL,
      company         VARCHAR(255) NOT NULL,
      requested_slug  VARCHAR(63) NULL,
      team_size       VARCHAR(20) NULL,
      ip_address      VARCHAR(64) NULL,
      user_agent      TEXT NULL,
      status          ENUM('provisioned','failed','pending_review') NOT NULL DEFAULT 'provisioned',
      error           TEXT NULL,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_signups_email (email),
      INDEX idx_signups_status (status)
    ) ENGINE=InnoDB
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS platform_audit_log (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      actor_type      ENUM('platform_admin','system','tenant') NOT NULL,
      actor_id        VARCHAR(64) NULL,
      tenant_id       INT NULL,
      action          VARCHAR(100) NOT NULL,
      detail          JSON NULL,
      ip_address      VARCHAR(64) NULL,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_audit_action (action),
      INDEX idx_audit_tenant (tenant_id),
      INDEX idx_audit_created (created_at)
    ) ENGINE=InnoDB
  `);

  // Seed the bootstrap platform admin from env vars (idempotent)
  const { hashPassword } = require('../db');
  const ownerEmail    = (process.env.PLATFORM_OWNER_EMAIL    || process.env.ADMIN_USERNAME || 'admin@tickin.pro').trim().toLowerCase();
  const ownerName     = (process.env.PLATFORM_OWNER_NAME     || 'Owner').trim();
  const ownerPassword = (process.env.PLATFORM_OWNER_PASSWORD || process.env.ADMIN_PASSWORD || 'bootstrap').trim();
  await db.execute(
    `INSERT IGNORE INTO platform_admins (email, name, password_hash, role) VALUES (?, ?, ?, 'owner')`,
    [ownerEmail, ownerName, hashPassword(ownerPassword)]
  );

  console.log(`✅ Platform DB ready (${PLATFORM_DB_NAME})`);
}

module.exports = { initPlatformDB };
