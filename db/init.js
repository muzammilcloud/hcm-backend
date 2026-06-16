const { getDB, hashPassword } = require('../db');
// seed.js is kept in the repo but no longer auto-imported — new tenants
// start blank. Manual seeding still possible via:  require('./seed').seedDummyData(pool)

// Run the full tenant-schema initialization against a specific pool.
// In multi-tenant mode, called once per tenant by the provisioning service.
// Without a pool argument it falls back to getDB() so legacy callers still work.
async function initTenantSchema(poolArg) {
  const pool = poolArg || await getDB();

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS admins (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(100) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      admin_id INT NOT NULL,
      token VARCHAR(255) NOT NULL UNIQUE,
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (admin_id) REFERENCES admins(id)
    )
  `);

  // Bootstrap admin row (id=1). Login auth uses ADMIN_USERNAME/ADMIN_PASSWORD
  // env vars; this row only exists to satisfy admin_sessions.admin_id FK.
  // INSERT IGNORE so it's idempotent on every boot and never overwrites an
  // existing row.
  {
    const envUser = (process.env.ADMIN_USERNAME || 'admin').trim();
    await pool.execute(
      `INSERT IGNORE INTO admins (id, username, password_hash) VALUES (1, ?, ?)`,
      [envUser, hashPassword(process.env.ADMIN_PASSWORD || 'bootstrap')]
    );
  }

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS employees (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      password_hash VARCHAR(255) DEFAULT NULL,
      role VARCHAR(100) DEFAULT 'Employee',
      department VARCHAR(100) DEFAULT 'General',
      is_active TINYINT(1) DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Add columns if missing (for existing tables)
  try { await pool.execute(`ALTER TABLE employees ADD COLUMN password_hash VARCHAR(255) DEFAULT NULL`); } catch (_) {}
  try { await pool.execute(`ALTER TABLE employees ADD COLUMN is_active TINYINT(1) DEFAULT 0`); } catch (_) {}
  try { await pool.execute(`ALTER TABLE employees ADD COLUMN slack_user_id VARCHAR(50) DEFAULT NULL`); } catch (_) {}
  try { await pool.execute(`ALTER TABLE employees ADD COLUMN date_of_birth DATE NULL`); } catch (_) {}
  try { await pool.execute(`ALTER TABLE employees ADD COLUMN join_date DATE NULL`); } catch (_) {}
  try { await pool.execute(`ALTER TABLE employees ADD COLUMN first_name VARCHAR(100) DEFAULT NULL`); } catch (_) {}
  try { await pool.execute(`ALTER TABLE employees ADD COLUMN last_name VARCHAR(100) DEFAULT NULL`); } catch (_) {}
  try { await pool.execute(`ALTER TABLE employees ADD COLUMN father_name VARCHAR(100) DEFAULT NULL`); } catch (_) {}
  try { await pool.execute(`ALTER TABLE employees ADD COLUMN gender VARCHAR(10) DEFAULT NULL`); } catch (_) {}
  try { await pool.execute(`ALTER TABLE employees ADD COLUMN cnic VARCHAR(20) DEFAULT NULL`); } catch (_) {}
  try { await pool.execute(`ALTER TABLE employees ADD COLUMN emp_code VARCHAR(20) DEFAULT NULL`); } catch (_) {}
  try { await pool.execute(`ALTER TABLE employees ADD COLUMN slack_email VARCHAR(255) DEFAULT NULL`); } catch (_) {}
  try { await pool.execute(`ALTER TABLE employees ADD COLUMN marital_status ENUM('Single','Married','Divorced','Widowed') DEFAULT 'Single'`); } catch (_) {}
  try { await pool.execute(`UPDATE employees SET marital_status='Single' WHERE marital_status IS NULL`); } catch (_) {}
  try { await pool.execute(`ALTER TABLE employees ADD COLUMN employment_status ENUM('probation','permanent') DEFAULT 'probation'`); } catch (_) {}
  try { await pool.execute(`ALTER TABLE employees ADD COLUMN reports_to INT DEFAULT NULL`); } catch (_) {}

  // Link Muzammil (QK-1149), Anosha (QK-1138), Laiba (QK-1144) portal users → employee records
  const linkPairs = [
    { emp_code: 'QK-1149', portal_email: 'muzammilquecko@gmail.com' },
    { emp_code: 'QK-1138', portal_email: 'anoshanoor363@gmail.com'  },
    { emp_code: 'QK-1144', portal_email: 'laibaarshad617@gmail.com' },
  ];
  for (const { emp_code, portal_email } of linkPairs) {
    try {
      const [empRows] = await pool.execute(`SELECT id FROM employees WHERE emp_code = ?`, [emp_code]);
      const [puRows]  = await pool.execute(`SELECT id FROM portal_users WHERE LOWER(email) = LOWER(?)`, [portal_email]);
      if (!empRows.length || !puRows.length) continue;
      const empId = empRows[0].id;
      const puId  = puRows[0].id;
      await pool.execute(`UPDATE portal_users SET employee_id = ? WHERE id = ? AND employee_id IS NULL`, [empId, puId]);
      await pool.execute(`UPDATE employees SET slack_email = ? WHERE id = ? AND (slack_email IS NULL OR slack_email = '')`, [portal_email, empId]);
    } catch (_) {}
  }

  // Seed Employee IDs by email
  const empCodes = [
    ['aleeabbasi021@gmail.com','QK-1021'],['anoshanoor363@gmail.com','QK-1138'],['laibaarshad617@gmail.com','QK-1144'],
    ['waleed.shafiq96@gmail.com','QK-1026'],['mwaqasbashir4@gmail.com','QK-1036'],['usamasaif772@gmail.com','QK-1068'],
    ['saifurehman980@gmail.com','QK-1069'],['afaheem295@gmail.com','QK-1070'],['adrehman11@gmail.com','QK-1047'],
    ['ammarsjw@gmail.com','QK-1048'],['afaqahsan23@gmail.com','QK-1083'],['3445shoaib@gmail.com','QK-1084'],
    ['contacttoshahidkhan@gmail.com','QK-1088'],['akashsabir007@gmail.com','QK-1092'],['rubabosama998@gmail.com','QK-1098'],
    ['immujahidkhan6@gmail.com','QK-1099'],['ibatool.63@gmail.com','QK-1044'],['syedtirimzi@gmail.com','QK-1073'],
    ['mwasifsheikh@gmail.com','QK-1100'],['zulkefal.khan705@gmail.com','QK-1109'],['abdullahopl6@gmai.com','QK-1111'],
    ['saifullahomar786@gmail.com','QK-1116'],['jwad.khaan@gmail.com','QK-1127'],['salmanazhar.official@gmail.com','QK-1033'],
    ['absarsdq291@gmail.com','QK-1152'],['hamzakhalidkhan.13@gmail.com','QK-1114'],['usman.maliknu13@gmail.com','QK-1024'],
    ['chudhryjawad@gmail.com','QK-1039'],['m.awais.genius@gmail.com','QK-1064'],['abdullah157a157a@gmail.com','QK-1053'],
    ['shahzeb.naseer2@gmail.com','QK-1027'],['amanullah07544@gmail.com','QK-1040'],['noorimad274939@gmail.com','QK-1060'],
    ['razaawanpersonal@gmail.com','QK-1124'],['yahyarehmanlfc@gmail.com','QK-1129'],['m.waleedapsacian@gmail.com','QK-1113'],
    ['iamabdulbasit0702@gmail.com','QK-1118'],['usama_shafiq97@hotmail.com','QK-1120'],['moeezabdul2004@gmail.com','QK-1071'],
    ['aabimirza231@gmail.com','QK-1072'],['codewithxohii@gmail.com','QK-1091'],['osamachattha78@gmail.com','QK-1029'],
    ['sajjadbaig1227@gmail.com','QK-1067'],['ibrahimqureshi.m17@gmail.com','QK-1075'],['uzairanwar0306@gmail.com','QK-1101'],
    ['shoaibvirk24@gmail.com','QK-1085'],['fahadsaleemsqaa@gmail.com','QK-1105'],['haziqahmed31971@gmail.com','QK-1107'],
    ['uzairahsan999@gmail.com','QK-1108'],['murtaza.naqvi301@gmail.com','QK-1090'],['lintabintehabib2002@gmail.com','QK-1139'],
    ['bilalabdullah451@gmail.com','QK-1150'],['jamalwaseem13@gmail.com','QK-1022'],['sardarahmadnaseem@gmail.com','QK-1042'],
    ['usmanheer9@gmail.com','QK-1057'],['hamzach625@gmail.com','QK-1054'],['wardahrehman703@gmail.com','QK-1096'],
    ['hamzaval2000@gmail.com','QK-1136'],['hammadanwar6520@gmail.com','QK-1121'],['sharjeelawan88@gmail.com','QK-1028'],
    ['ub1894497@gmail.com','QK-1031'],['khawaraliramzan@gmail.com','QK-1023'],['asadbutt_1@hotmail.com','QK-1049'],
    ['zahirbakhash5@gmail.com','QK-1157'],['khan.shani99@gmail.com','QK-1050'],['awaissarfa@gmail.com','QK-1145'],
    ['zeekhan7872@gmail.com','QK-1037'],['adnankhan3937@gmail.com','QK-1051'],['mughalaasjad577@gmail.com','QK-1103'],
    ['abdulrocker4@gmail.com','QK-1133'],['farhanrazzaq57@gmail.com','QK-1089'],['ateeq4112@gmail.com','QK-1151'],
    ['shehryarmuhammad97@gmail.com','QK-1148'],['softwaresdeveloper143@gmail.com','QK-1147'],['mmuzammil.tech@gmail.com','QK-1149'],
    ['nauman.hafeez920@gmail.com','QK-1126'],['taimooranwar837@gmail.com','QK-1127'],['bilal.quecko@gmail.com','QK-1135'],
    ['tehreem.fatima28@gmail.com','QK-1143'],['m.fahadsuleman@gmail.com','QK-1045'],['nafeesrizvi4@gmail.com','QK-1074'],
    ['wajahatahmed708@gmail.com','QK-1102'],['ambarsaleem1@gmail.com','QK-1086'],['moizbroazan@gmail.com','QK-1123'],
    ['burhanabrar41@gmail.com','QK-1137'],['iqrajabeen919@gmail.com','QK-1141'],['hiraasif2028@gmail.com','QK-1142'],
    ['zbmalik313@gmail.com','QK-1076'],['sheeba.abbasi@gmail.com','QK-1097'],['kholaabbasii@gmail.com','QK-1093'],
    ['nosheen.hussnain@gmail.com','QK-1032'],['areejmaqbool1@gmail.com','QK-1094'],['ahmedsaleems123@gmail.com','QK-1160'],
    ['musavirnushad@gmail.com','QK-1159'],['muhammad.usman89@hotmail.com','QK-1158'],
    ['shahid.niazi.dev@gmail.com','QK-1153'],
  ];
  for (const [email, code] of empCodes) {
    try { await pool.execute(`UPDATE employees SET emp_code=? WHERE LOWER(email)=LOWER(?) AND (emp_code IS NULL OR emp_code='')`, [code, email]); } catch (_) {}
  }

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS employee_invites (
      id INT AUTO_INCREMENT PRIMARY KEY,
      employee_id INT NOT NULL,
      token VARCHAR(255) NOT NULL UNIQUE,
      expires_at DATETIME NOT NULL,
      used_at DATETIME DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_id) REFERENCES employees(id)
    )
  `);

  // Migrate portal_users if it exists with old schema (invite_email → email, drop employee_id FK)
  try { await pool.execute(`ALTER TABLE portal_users ADD COLUMN email VARCHAR(255) AFTER id`); } catch (_) {}
  try { await pool.execute(`UPDATE portal_users SET email = invite_email WHERE email IS NULL`); } catch (_) {}
  try { await pool.execute(`ALTER TABLE portal_users DROP COLUMN invite_email`); } catch (_) {}
  try { await pool.execute(`ALTER TABLE portal_users MODIFY COLUMN email VARCHAR(255) NOT NULL`); } catch (_) {}
  // Drop any old FK on portal_users.employee_id (from a previous schema design)
  try {
    const [fks] = await pool.execute(`
      SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_NAME = 'portal_users' AND COLUMN_NAME = 'employee_id'
      AND TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL
    `);
    for (const fk of fks) {
      try { await pool.execute(`ALTER TABLE portal_users DROP FOREIGN KEY \`${fk.CONSTRAINT_NAME}\``); } catch (_) {}
    }
    try { await pool.execute(`ALTER TABLE portal_users DROP INDEX employee_id`); } catch (_) {}
  } catch (_) {}
  try { await pool.execute(`ALTER TABLE portal_users ADD COLUMN name VARCHAR(255) NOT NULL DEFAULT '' AFTER email`); } catch (_) {}
  try { await pool.execute(`ALTER TABLE portal_users ADD COLUMN first_name VARCHAR(100) AFTER name`); } catch (_) {}
  try { await pool.execute(`ALTER TABLE portal_users ADD COLUMN last_name VARCHAR(100) AFTER first_name`); } catch (_) {}
  try { await pool.execute(`ALTER TABLE portal_users ADD COLUMN department VARCHAR(100) DEFAULT 'General'`); } catch (_) {}
  try { await pool.execute(`ALTER TABLE portal_users ADD COLUMN role VARCHAR(100) DEFAULT 'Employee'`); } catch (_) {}
  try { await pool.execute(`ALTER TABLE portal_users ADD COLUMN status ENUM('pending','active','inactive') DEFAULT 'pending'`); } catch (_) {}
  try { await pool.execute(`UPDATE portal_users SET status = IF(is_active = 1, 'active', 'pending') WHERE status IS NULL OR status = ''`); } catch (_) {}
  try { await pool.execute(`ALTER TABLE portal_users DROP COLUMN is_active`); } catch (_) {}
  try { await pool.execute(`ALTER TABLE portal_users ADD COLUMN slack_user_id VARCHAR(50)`); } catch (_) {}
  try { await pool.execute(`ALTER TABLE portal_users ADD COLUMN revoked_at DATETIME`); } catch (_) {}
  try { await pool.execute(`ALTER TABLE portal_users ADD COLUMN employee_id INT DEFAULT NULL`); } catch (_) {}
  try { await pool.execute(`ALTER TABLE portal_users ADD COLUMN portal_role ENUM('employee','team-lead','sys-admin') DEFAULT 'employee'`); } catch (_) {}
  try { await pool.execute(`ALTER TABLE portal_users ADD COLUMN google_sub VARCHAR(40) NULL`); } catch (_) {}
  try { await pool.execute(`ALTER TABLE portal_users ADD UNIQUE KEY uq_portal_users_google_sub (google_sub)`); } catch (_) {}
  try { await pool.execute(`ALTER TABLE portal_users ADD COLUMN preferred_locale VARCHAR(10) NULL AFTER status`); } catch (_) {}
  try { await pool.execute(`ALTER TABLE tenant_settings ADD COLUMN default_locale VARCHAR(10) NOT NULL DEFAULT 'en' AFTER country_code`); } catch (_) {}
  try { await pool.execute(`ALTER TABLE tenant_settings ADD COLUMN daily_working_hours DECIMAL(4,2) NOT NULL DEFAULT 9.00`); } catch (_) {}
  try { await pool.execute(`ALTER TABLE tenant_settings ADD COLUMN working_days VARCHAR(40) NOT NULL DEFAULT 'mon,tue,wed,thu,fri'`); } catch (_) {}
  try { await pool.execute(`ALTER TABLE tenant_settings ADD COLUMN monthly_required_hours_override DECIMAL(6,2) NULL DEFAULT NULL`); } catch (_) {}
  // Hour-of-day (0–23, tenant-local) the daily Leave & WFH report is sent. The
  // scheduler interprets it in the tenant's timezone (derived from country).
  // Default 12 = noon, preserving the prior behaviour.
  try { await pool.execute(`ALTER TABLE tenant_settings ADD COLUMN daily_report_hour TINYINT NOT NULL DEFAULT 12`); } catch (_) {}
  // Explicit IANA timezone (e.g. 'America/Los_Angeles'). When set, it overrides
  // the country-derived zone for all scheduling + "today" math. NULL = derive
  // from country_code (back-compat for existing tenants).
  try { await pool.execute(`ALTER TABLE tenant_settings ADD COLUMN timezone VARCHAR(64) NULL DEFAULT NULL`); } catch (_) {}

  // Seed portal_role for known accounts
  try { await pool.execute(`UPDATE portal_users SET portal_role='team-lead' WHERE email='muzammilquecko@gmail.com' AND portal_role='employee'`); } catch (_) {}
  try { await pool.execute(`UPDATE portal_users SET portal_role='sys-admin' WHERE email='anoshanoor363@gmail.com'  AND portal_role='employee'`); } catch (_) {}
  try { await pool.execute(`UPDATE portal_users SET portal_role='sys-admin' WHERE email='laibaarshad617@gmail.com' AND portal_role='employee'`); } catch (_) {}

  // Portal users — standalone portal login accounts, no relation to HR employees table.
  // The schema below is the full target — historically some columns were added
  // via ALTER TABLE statements above (which run before CREATE TABLE in this file,
  // so they're no-ops on a fresh DB). For multi-tenant the column list here must
  // be complete on its own.
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS portal_users (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      name          VARCHAR(255) NOT NULL,
      first_name    VARCHAR(100),
      last_name     VARCHAR(100),
      email         VARCHAR(255) NOT NULL UNIQUE,
      department    VARCHAR(100) DEFAULT 'General',
      role          VARCHAR(100) DEFAULT 'Employee',
      portal_role   ENUM('employee','team-lead','sys-admin') DEFAULT 'employee',
      password_hash VARCHAR(255),
      status        ENUM('pending','active','inactive') DEFAULT 'pending',
      invite_token      VARCHAR(255),
      invite_expires_at DATETIME,
      reset_token       VARCHAR(255),
      reset_expires_at  DATETIME,
      slack_user_id VARCHAR(50),
      employee_id   INT DEFAULT NULL,
      google_sub    VARCHAR(40) NULL UNIQUE,
      revoked_at  DATETIME,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ── Tenant integrations ──────────────────────────────────────────────────
  // Per-tenant credentials for third-party services (Slack, SMTP, etc.).
  // config_encrypted holds an AES-256-GCM ciphertext of the JSON config.
  // UNIQUE(integration_type) means one row per integration type per tenant.
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS tenant_integrations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      integration_type ENUM('slack','smtp','lineworks') NOT NULL UNIQUE,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      config_encrypted MEDIUMTEXT,
      last_tested_at DATETIME NULL,
      last_test_status ENUM('ok','failed') NULL,
      last_test_message TEXT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
  // 'lineworks' was added as a chat integration after launch. Existing tenant
  // DBs were created with ENUM('slack','smtp') only, so any write touching the
  // lineworks row — e.g. enabling Slack calls disableOtherChatIntegrations()
  // which disables LINE WORKS — failed with "Data truncated for column
  // 'integration_type'" (a 500 on the Enable toggle). Widen the enum.
  try { await pool.execute(`ALTER TABLE tenant_integrations MODIFY COLUMN integration_type ENUM('slack','smtp','lineworks') NOT NULL`); } catch (_) {}

  // ── Salary components ─────────────────────────────────────────────────────
  // Per-tenant library of earning/deduction lines used by the calculator.
  //
  // Method semantics:
  //   fixed             — value is exactly `amount`
  //   percent_of_basic  — `percent`% of the employee's basic salary
  //   percent_of_gross  — `percent`% of total earnings
  //   percent_of_ctc    — `percent`% of cost-to-company
  //
  // `cap_amount` optionally caps a percent-derived value.
  // `system_managed`=1 components (e.g. Basic Salary) can't be deleted —
  // they underpin every other calculation.
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS salary_components (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      code          VARCHAR(50) NOT NULL UNIQUE,
      name          VARCHAR(255) NOT NULL,
      kind          ENUM('earning','deduction') NOT NULL,
      calc_method   ENUM('fixed','percent_of_basic','percent_of_gross','percent_of_ctc')
                    NOT NULL DEFAULT 'fixed',
      amount        DECIMAL(14,2) DEFAULT NULL,
      percent       DECIMAL(6,2)  DEFAULT NULL,
      cap_amount    DECIMAL(14,2) DEFAULT NULL,
      taxable       TINYINT(1) NOT NULL DEFAULT 0,
      show_on_slip  TINYINT(1) NOT NULL DEFAULT 1,
      sort_order    INT NOT NULL DEFAULT 0,
      system_managed TINYINT(1) NOT NULL DEFAULT 0,
      active        TINYINT(1) NOT NULL DEFAULT 1,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_components_kind (kind),
      INDEX idx_components_order (sort_order)
    ) ENGINE=InnoDB
  `);

  // Employee-level overrides. The calculator prefers an override row over
  // the component's defaults when computing this employee's slip.
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS employee_component_overrides (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      employee_id   INT NOT NULL,
      component_id  INT NOT NULL,
      calc_method   ENUM('fixed','percent_of_basic','percent_of_gross','percent_of_ctc')
                    NOT NULL DEFAULT 'fixed',
      amount        DECIMAL(14,2) DEFAULT NULL,
      percent       DECIMAL(6,2)  DEFAULT NULL,
      cap_amount    DECIMAL(14,2) DEFAULT NULL,
      note          VARCHAR(255) DEFAULT NULL,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_emp_component (employee_id, component_id),
      FOREIGN KEY (component_id) REFERENCES salary_components(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  // ── Tax brackets ─────────────────────────────────────────────────────────
  // Progressive income tax bands for the workspace. The calculator (Phase D)
  // computes tax on the sum of all components flagged taxable=1.
  //
  // band_to NULL means "and above" — the final, open-ended band.
  // source_country tracks which preset (if any) the brackets came from, so
  // the UI can warn before overwriting with a new preset.
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS tax_brackets (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      band_from  DECIMAL(14,2) NOT NULL,
      band_to    DECIMAL(14,2) DEFAULT NULL,
      rate       DECIMAL(5,2)  NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_brackets_order (sort_order)
    ) ENGINE=InnoDB
  `);

  // Metadata about how the current brackets were loaded — surfaces in the UI
  // banner ("Loaded from Pakistan preset · last updated 3 days ago").
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS tax_bracket_meta (
      id INT AUTO_INCREMENT PRIMARY KEY,
      singleton_key TINYINT NOT NULL DEFAULT 1 UNIQUE,
      source_country VARCHAR(2) DEFAULT NULL,
      preset_year    VARCHAR(10) DEFAULT NULL,
      confirmed      TINYINT(1) NOT NULL DEFAULT 0,
      confirmed_at   DATETIME DEFAULT NULL,
      tax_enabled    TINYINT(1) NOT NULL DEFAULT 1,
      created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
  // Forward-compat — add the column on existing tenants that pre-date it.
  try { await pool.execute(`ALTER TABLE tax_bracket_meta ADD COLUMN tax_enabled TINYINT(1) NOT NULL DEFAULT 1`); } catch (_) {}

  // ── Tenant settings ──────────────────────────────────────────────────────
  // Singleton row per tenant DB (enforced via UNIQUE on singleton_key).
  // Holds locale (currency, country) and slip-branding for the workspace.
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS tenant_settings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      singleton_key TINYINT NOT NULL DEFAULT 1 UNIQUE,

      currency             VARCHAR(8)   DEFAULT 'USD',
      currency_locked      TINYINT(1)   DEFAULT 0,
      country_code         VARCHAR(2)   DEFAULT 'US',

      company_name         VARCHAR(255),
      company_address      TEXT,
      company_logo_url     VARCHAR(500),

      slip_title           VARCHAR(64)  DEFAULT 'Salary Slip',
      slip_signatory_name  VARCHAR(255),
      slip_signatory_title VARCHAR(100),

      daily_working_hours              DECIMAL(4,2) NOT NULL DEFAULT 9.00,
      working_days                     VARCHAR(40)  NOT NULL DEFAULT 'mon,tue,wed,thu,fri',
      monthly_required_hours_override  DECIMAL(6,2) NULL DEFAULT NULL,

      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  // Portal sessions — separate from employee_sessions
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS portal_sessions (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      portal_user_id  INT NOT NULL,
      token           VARCHAR(255) NOT NULL UNIQUE,
      expires_at      DATETIME NOT NULL,
      created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (portal_user_id) REFERENCES portal_users(id) ON DELETE CASCADE
    )
  `);

  // Portal time entries — clock records for portal users (separate from HR time_entries)
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS portal_time_entries (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      portal_user_id  INT NOT NULL,
      clock_in        DATETIME NOT NULL,
      clock_out       DATETIME,
      notes           TEXT,
      ot_prompt_sent  TINYINT DEFAULT 0,
      ot_decision     VARCHAR(20),
      created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (portal_user_id) REFERENCES portal_users(id) ON DELETE CASCADE
    )
  `);

  // Idle sessions — browser-detected inactivity periods while clocked in
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS idle_sessions (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      portal_user_id  INT NOT NULL,
      time_entry_id   INT,
      idle_start      DATETIME NOT NULL,
      idle_end        DATETIME NOT NULL,
      duration_minutes INT NOT NULL,
      created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (portal_user_id) REFERENCES portal_users(id) ON DELETE CASCADE
    )
  `);

  // Portal breaks — explicit break intervals, started/stopped from Slack or web.
  // Break time pauses the work timer: net work = (clock_out - clock_in) - sum(breaks).
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS portal_breaks (
      id               INT AUTO_INCREMENT PRIMARY KEY,
      portal_user_id   INT NOT NULL,
      time_entry_id    INT NOT NULL,
      break_start      DATETIME NOT NULL,
      break_end        DATETIME,
      duration_seconds INT,
      source           VARCHAR(20) DEFAULT 'slack',
      created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (portal_user_id) REFERENCES portal_users(id) ON DELETE CASCADE,
      FOREIGN KEY (time_entry_id)  REFERENCES portal_time_entries(id) ON DELETE CASCADE,
      INDEX idx_pu_date (portal_user_id, break_start),
      INDEX idx_entry   (time_entry_id),
      INDEX idx_open    (portal_user_id, break_end)
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS employee_sessions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      employee_id INT NOT NULL,
      token VARCHAR(255) NOT NULL UNIQUE,
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_id) REFERENCES employees(id)
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS time_entries (
      id INT AUTO_INCREMENT PRIMARY KEY,
      employee_id INT NOT NULL,
      clock_in DATETIME NOT NULL,
      clock_out DATETIME DEFAULT NULL,
      notes TEXT,
      ot_prompt_sent TINYINT(1) DEFAULT 0,
      ot_decision VARCHAR(20) DEFAULT NULL,
      FOREIGN KEY (employee_id) REFERENCES employees(id)
    )
  `);

  // Add OT columns if missing
  try { await pool.execute(`ALTER TABLE time_entries ADD COLUMN ot_prompt_sent TINYINT(1) DEFAULT 0`); } catch (_) {}
  try { await pool.execute(`ALTER TABLE time_entries ADD COLUMN ot_decision VARCHAR(20) DEFAULT NULL`); } catch (_) {}
  try { await pool.execute(`ALTER TABLE ot_requests ADD COLUMN idle_deducted DECIMAL(5,2) NOT NULL DEFAULT 0`); } catch (_) {}

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS employee_logs (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      employee_id  INT,
      employee_name VARCHAR(255) NOT NULL,
      department   VARCHAR(100),
      role         VARCHAR(100),
      event        VARCHAR(50) NOT NULL,
      detail       TEXT,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ── Shifts ────────────────────────────────────────────────────────────────
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS shifts (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      name         VARCHAR(255) NOT NULL,
      start_time   TIME NOT NULL,
      end_time     TIME NOT NULL,
      min_hours    DECIMAL(4,2) DEFAULT 8.00,
      days_of_week VARCHAR(20) DEFAULT '1,2,3,4,5',
      scope        ENUM('employee','department') DEFAULT 'employee',
      scope_id     VARCHAR(100) NOT NULL,
      is_active    TINYINT(1) DEFAULT 1,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ── Leave Policies ────────────────────────────────────────────────────────
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS leave_policies (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      leave_type   VARCHAR(50) NOT NULL UNIQUE,
      annual_quota INT DEFAULT NULL,
      is_unlimited TINYINT(1) DEFAULT 0,
      requires_approval TINYINT(1) DEFAULT 1,
      color        VARCHAR(10) DEFAULT '#6366f1'
    )
  `);

  // Seed leave policies
  const [lpCount] = await pool.execute('SELECT COUNT(*) as c FROM leave_policies');
  if (lpCount[0].c === 0) {
    await pool.execute(`INSERT INTO leave_policies (leave_type, annual_quota, is_unlimited, color) VALUES
      ('Annual Leave',    12,   0, '#6366f1'),
      ('Sick Leave',       8,   0, '#10b981'),
      ('Casual Leave',     8,   0, '#f59e0b'),
      ('Work From Home',   2,   0, '#06b6d4'),
      ('Unpaid Leave',  NULL,   1, '#94a3b8'),
      ('Public Holiday',NULL,   0, '#ec4899'),
      ('Paternity Leave',  2,   0, '#3b82f6'),
      ('Maternity Leave', 30,   0, '#ec4899')
    `);
  }
  // Patch existing installations: correct Annual Leave quota and add Paternity/Maternity
  try { await pool.execute(`UPDATE leave_policies SET annual_quota=12 WHERE leave_type='Annual Leave' AND annual_quota=14`); } catch (_) {}
  try { await pool.execute(`INSERT INTO leave_policies (leave_type, annual_quota, is_unlimited, color) SELECT 'Paternity Leave', 2, 0, '#3b82f6' WHERE NOT EXISTS (SELECT 1 FROM leave_policies WHERE leave_type='Paternity Leave')`); } catch (_) {}
  try { await pool.execute(`INSERT INTO leave_policies (leave_type, annual_quota, is_unlimited, color) SELECT 'Maternity Leave', 30, 0, '#ec4899' WHERE NOT EXISTS (SELECT 1 FROM leave_policies WHERE leave_type='Maternity Leave')`); } catch (_) {}

  // ── Employee Quota Overrides (per-employee custom quotas) ────────────────
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS employee_quota_overrides (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      employee_id  INT NOT NULL,
      leave_type   VARCHAR(50) NOT NULL,
      quota        INT NOT NULL,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_emp_leave (employee_id, leave_type),
      FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
    )
  `);

  // ── Leave Requests ────────────────────────────────────────────────────────
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS leave_requests (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      employee_id  INT NOT NULL,
      leave_type   VARCHAR(50) NOT NULL,
      start_date   DATE NOT NULL,
      end_date     DATE NOT NULL,
      duration     ENUM('full','half_am','half_pm') DEFAULT 'full',
      reason       TEXT,
      status       ENUM('pending','approved','denied') DEFAULT 'pending',
      admin_note   TEXT,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_id) REFERENCES employees(id)
    )
  `);
  // Expand leave_requests status ENUM to support two-stage approval flow
  try { await pool.execute(`ALTER TABLE leave_requests MODIFY COLUMN status ENUM('pending_tl','approved_tl','declined_tl','changes_requested','pending','approved','declined_admin','denied','denied_tl') DEFAULT 'pending_tl'`); } catch (_) {}
  try { await pool.execute(`ALTER TABLE leave_requests ADD COLUMN tl_note TEXT NULL`); } catch (_) {}
  try { await pool.execute(`ALTER TABLE leave_requests ADD COLUMN action_history TEXT NULL`); } catch (_) {}

  // ── Public Holidays ───────────────────────────────────────────────────────
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS public_holidays (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      name       VARCHAR(255) NOT NULL,
      date       DATE NOT NULL UNIQUE,
      is_paid    TINYINT(1) DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ── Employee Salaries ──────────────────────────────────────────────────────
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS employee_salaries (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      employee_id   INT NOT NULL UNIQUE,
      basic_salary  DECIMAL(10,2) NOT NULL DEFAULT 0,
      house_rent    DECIMAL(10,2) NOT NULL DEFAULT 0,
      conveyance    DECIMAL(10,2) NOT NULL DEFAULT 0,
      medical       DECIMAL(10,2) NOT NULL DEFAULT 0,
      utilities     DECIMAL(10,2) NOT NULL DEFAULT 0,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
    )
  `);

  // ── Salary History (for completed months) ─────────────────────────────────
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS salary_history (
      id               INT AUTO_INCREMENT PRIMARY KEY,
      employee_id      INT NOT NULL,
      month            DATE NOT NULL,
      basic_salary     DECIMAL(10,2) NOT NULL,
      house_rent       DECIMAL(10,2) NOT NULL,
      conveyance       DECIMAL(10,2) NOT NULL,
      medical          DECIMAL(10,2) NOT NULL,
      utilities        DECIMAL(10,2) NOT NULL,
      gross_salary     DECIMAL(10,2) NOT NULL,
      provident_fund   DECIMAL(10,2) NOT NULL,
      withholding_tax  DECIMAL(10,2) NOT NULL,
      total_deductions DECIMAL(10,2) NOT NULL,
      net_salary       DECIMAL(10,2) NOT NULL,
      days_worked      INT NOT NULL DEFAULT 30,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_emp_month (employee_id, month),
      FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
    )
  `);

  // ── Attendance Records ────────────────────────────────────────────────────
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS attendance_records (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      employee_id INT NOT NULL,
      shift_id    INT NOT NULL,
      date        DATE NOT NULL,
      status      ENUM('on_time','missed','abandoned') DEFAULT 'on_time',
      hours_worked DECIMAL(5,2) DEFAULT 0,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_emp_shift_date (employee_id, shift_id, date),
      FOREIGN KEY (employee_id) REFERENCES employees(id),
      FOREIGN KEY (shift_id) REFERENCES shifts(id)
    )
  `);

  // Admin credentials are read from ADMIN_USERNAME / ADMIN_PASSWORD env vars at login time — no DB row needed.

  // ── Monthly OT Reconciliation ─────────────────────────────────────────────
  // One row per (portal_user, year, month). Snapshot of the 3-step
  // reconciliation: how much approved OT was absorbed into required hours,
  // how much covered idle, how much is surplus payable. Read-only summary —
  // does NOT replace the per-session OT approval flow.
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS monthly_ot_reconciliation (
      id                 INT AUTO_INCREMENT PRIMARY KEY,
      portal_user_id     INT NOT NULL,
      year               SMALLINT NOT NULL,
      month              TINYINT NOT NULL,
      required_hours     DECIMAL(7,2) NOT NULL,
      leave_days_full    DECIMAL(5,2) NOT NULL DEFAULT 0,
      paid_holiday_days  DECIMAL(5,2) NOT NULL DEFAULT 0,
      worked_net_hours   DECIMAL(7,2) NOT NULL,
      ot_approved_hours  DECIMAL(7,2) NOT NULL,
      idle_hours         DECIMAL(7,2) NOT NULL,
      ot_gap_fill        DECIMAL(7,2) NOT NULL,
      ot_idle_cover      DECIMAL(7,2) NOT NULL,
      ot_payable_surplus DECIMAL(7,2) NOT NULL,
      daily_hours_used   DECIMAL(4,2) NOT NULL,
      computed_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_pu_month (portal_user_id, year, month),
      INDEX idx_year_month (year, month)
    ) ENGINE=InnoDB
  `);

  // ── OT Requests ───────────────────────────────────────────────────────────
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS ot_requests (
      id INT AUTO_INCREMENT PRIMARY KEY,
      time_entry_id INT NOT NULL UNIQUE,
      employee_id INT NOT NULL,
      date DATE NOT NULL,
      total_hours DECIMAL(5,2) NOT NULL,
      ot_hours DECIMAL(5,2) NOT NULL,
      idle_deducted DECIMAL(5,2) NOT NULL DEFAULT 0,
      status ENUM('pending', 'approved', 'denied') DEFAULT 'pending',
      admin_note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (time_entry_id) REFERENCES time_entries(id) ON DELETE CASCADE,
      FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
    )
  `);

  // ── Attendance Adjustments ────────────────────────────────────────────────
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS attendance_adjustments (
      id                  INT AUTO_INCREMENT PRIMARY KEY,
      portal_user_id      INT NOT NULL,
      department          VARCHAR(100),
      type                ENUM('adjust','missing') NOT NULL DEFAULT 'adjust',
      time_entry_id       INT DEFAULT NULL,
      requested_date      DATE NOT NULL,
      requested_clock_in  DATETIME,
      requested_clock_out DATETIME,
      reason              TEXT NOT NULL,
      status              ENUM('pending_tl','pending_admin','approved','rejected','needs_correction') DEFAULT 'pending_tl',
      tl_note             TEXT,
      tl_reviewed_by      INT DEFAULT NULL,
      tl_reviewed_at      DATETIME DEFAULT NULL,
      admin_note          TEXT,
      admin_reviewed_by   INT DEFAULT NULL,
      admin_reviewed_at   DATETIME DEFAULT NULL,
      created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (portal_user_id) REFERENCES portal_users(id) ON DELETE CASCADE
    )
  `);

  // ── Notifications ─────────────────────────────────────────────────────────
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS notifications (
      id                 INT AUTO_INCREMENT PRIMARY KEY,
      recipient_user_id  INT NOT NULL,
      type               VARCHAR(50) NOT NULL,
      title              VARCHAR(255) NOT NULL,
      body               TEXT,
      link               VARCHAR(500),
      read_at            DATETIME DEFAULT NULL,
      created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_recipient_unread (recipient_user_id, read_at),
      FOREIGN KEY (recipient_user_id) REFERENCES portal_users(id) ON DELETE CASCADE
    )
  `);

  // ── Audit logs ─────────────────────────────────────────────────────────────
  // Append-only record of every state change. Written by services/audit.js
  // from each route handler. We never UPDATE rows here; corrections come as
  // new entries that supersede prior ones.
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      actor_user_id   INT NULL,
      actor_email     VARCHAR(255) NULL,
      actor_role      VARCHAR(50)  NULL,
      action          VARCHAR(80)  NOT NULL,
      target_type     VARCHAR(40)  NULL,
      target_id       VARCHAR(80)  NULL,
      before_json     JSON NULL,
      after_json      JSON NULL,
      ip              VARCHAR(64)  NULL,
      user_agent      VARCHAR(500) NULL,
      created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_audit_created (created_at),
      INDEX idx_audit_action  (action, created_at),
      INDEX idx_audit_target  (target_type, target_id, created_at),
      INDEX idx_audit_actor   (actor_user_id, created_at)
    )
  `);

  console.log('✅ Database tables ready');
  // Dummy seed data (Ali/Sara/Omar/muzammilquecko + salary history) intentionally
  // NOT seeded for new tenants. The `app` tenant inherits its data from the legacy
  // DB via scripts/migrate-to-multitenant.js, so removing this call only affects
  // tenants provisioned via signup, which should start empty per product spec.
  // seed.js is kept on disk if a "demo workspace" template is ever needed.

  // ── Idempotent salary patch for muzammilquecko@gmail.com ─────────────────
  const [muzRows] = await pool.execute(
    'SELECT id FROM employees WHERE email = ?', ['muzammilquecko@gmail.com']
  );
  if (muzRows.length > 0) {
    const uid = muzRows[0].id;
    // Salary package
    await pool.execute(`
      INSERT INTO employee_salaries (employee_id, basic_salary, house_rent, conveyance, medical, utilities)
      VALUES (?, 100000, 40000, 8000, 6000, 5000)
      ON DUPLICATE KEY UPDATE
        basic_salary=100000, house_rent=40000, conveyance=8000, medical=6000, utilities=5000
    `, [uid]);
    // Salary history — 8 months (Jul 2025 → Feb 2026)
    // Values computed using calculateSalaryBreakdown formula:
    //   gross=159k/month, PF=2.5% of pro-rata gross, WHT=6990/month (PKR 2025-26 brackets)
    //   daily_gross=5300, daily_tax=233
    // All completed months use full-month salary (30 days, gross=159,000)
    // PF=3975 (2.5%), WHT=6990 (PKR 2025-26 bracket), deductions=10965, net=148035
    const salaryMonths = [
      '2024-01-01','2024-02-01','2024-03-01','2024-04-01','2024-05-01','2024-06-01',
      '2024-07-01','2024-08-01','2024-09-01','2024-10-01','2024-11-01','2024-12-01',
      '2025-01-01','2025-02-01','2025-03-01','2025-04-01','2025-05-01','2025-06-01',
      '2025-07-01','2025-08-01','2025-09-01','2025-10-01','2025-11-01','2025-12-01',
      '2026-01-01','2026-02-01',
    ].map(month => [month, 30, 159000, 3975.00, 6990.00, 10965.00, 148035.00]);
    for (const [month, days, gross, pf, tax, ded, net] of salaryMonths) {
      await pool.execute(`
        INSERT INTO salary_history
          (employee_id, month, basic_salary, house_rent, conveyance, medical, utilities,
           gross_salary, provident_fund, withholding_tax, total_deductions, net_salary, days_worked)
        VALUES (?,?,100000,40000,8000,6000,5000,?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE
          gross_salary=VALUES(gross_salary), provident_fund=VALUES(provident_fund),
          withholding_tax=VALUES(withholding_tax), total_deductions=VALUES(total_deductions),
          net_salary=VALUES(net_salary), days_worked=VALUES(days_worked)
      `, [uid, month, gross, pf, tax, ded, net, days]);
    }
    console.log('✅ Salary data patched for muzammilquecko@gmail.com');
  }
}

// Backwards-compat alias — older code imports `initDB`.
module.exports = { initTenantSchema, initDB: initTenantSchema };
