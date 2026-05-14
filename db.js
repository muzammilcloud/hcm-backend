const mysql  = require('mysql2/promise');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { AsyncLocalStorage } = require('node:async_hooks');

// ─────────────────────────────────────────────────────────────────────────────
// Multi-tenant connection management
//
// Architecture:
//   • One platform DB (`tickin_platform`) — always-on, holds tenants table
//   • One DB per tenant (`tickin_<slug>`) — lazy-created on demand
//
// Routes call getDB() as before. We use AsyncLocalStorage to thread the
// current request's tenant through the call stack without touching every
// route file. The middleware in middleware/tenant.js runs each request
// inside tenantContext.run(tenant, () => next()), so getDB() can look up
// the active tenant and return the matching pool.
// ─────────────────────────────────────────────────────────────────────────────

const tenantContext = new AsyncLocalStorage();

const PLATFORM_DB_NAME = process.env.PLATFORM_DB_NAME || 'tickin_platform';
const TENANT_DB_PREFIX = process.env.TENANT_DB_PREFIX || 'tickin_';

const baseConnConfig = () => ({
  host:     process.env.DB_HOST     || 'localhost',
  port:     Number(process.env.DB_PORT) || 3306,
  user:     process.env.DB_USER     || 'root',
  password: process.env.DB_PASSWORD || '',
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: ['DATE'],
});

let platformPool = null;
function getPlatformDB() {
  if (!platformPool) {
    platformPool = mysql.createPool({ ...baseConnConfig(), database: PLATFORM_DB_NAME });
  }
  return platformPool;
}

// "Server-level" pool — no database selected. Used to issue CREATE DATABASE
// statements during provisioning.
let serverPool = null;
function getServerDB() {
  if (!serverPool) {
    serverPool = mysql.createPool(baseConnConfig());
  }
  return serverPool;
}

// LRU-ish pool cache for tenants. Max 30 idle pools — beyond that we evict
// the oldest. Each pool holds up to 10 connections.
const MAX_TENANT_POOLS = Number(process.env.MAX_TENANT_POOLS) || 30;
const tenantPools = new Map();
function getTenantDB(dbName) {
  if (!dbName) throw new Error('getTenantDB: dbName required');
  let pool = tenantPools.get(dbName);
  if (pool) {
    tenantPools.delete(dbName);
    tenantPools.set(dbName, pool);
    return pool;
  }
  pool = mysql.createPool({ ...baseConnConfig(), database: dbName });
  tenantPools.set(dbName, pool);

  if (tenantPools.size > MAX_TENANT_POOLS) {
    const oldestKey = tenantPools.keys().next().value;
    const oldest = tenantPools.get(oldestKey);
    tenantPools.delete(oldestKey);
    oldest.end().catch(() => {});
  }
  return pool;
}

function tenantDbName(slug) {
  return `${TENANT_DB_PREFIX}${slug}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// getDB — context-aware
//
// Returns the active tenant's pool when called inside tenant middleware,
// otherwise the platform pool. Existing route code calling `await getDB()`
// keeps working without any changes — the only thing that changed is which
// database it points at.
// ─────────────────────────────────────────────────────────────────────────────
async function getDB() {
  const ctx = tenantContext.getStore();
  if (ctx && ctx.dbName) return getTenantDB(ctx.dbName);
  return getPlatformDB();
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth helpers (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

const legacySha256 = (pw) => crypto.createHash('sha256').update(pw).digest('hex');
const hashPassword = (pw) => bcrypt.hashSync(pw, 10);

function verifyPassword(pw, storedHash) {
  if (!pw || !storedHash) return { ok: false, needsRehash: false };
  if (storedHash.startsWith('$2')) {
    return { ok: bcrypt.compareSync(pw, storedHash), needsRehash: false };
  }
  if (storedHash.length === 64 && /^[0-9a-f]+$/i.test(storedHash)) {
    const candidate = legacySha256(pw);
    const a = Buffer.from(candidate, 'hex');
    const b = Buffer.from(storedHash, 'hex');
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    return { ok, needsRehash: ok };
  }
  return { ok: false, needsRehash: false };
}

const generateToken = () => crypto.randomBytes(32).toString('hex');

async function logEvent(pool, { employee_id, employee_name, department, role, event, detail }) {
  try {
    await pool.execute(
      'INSERT INTO employee_logs (employee_id, employee_name, department, role, event, detail) VALUES (?,?,?,?,?,?)',
      [employee_id || null, employee_name, department || null, role || null, event, detail || null]
    );
  } catch (e) { console.error('Log error:', e.message); }
}

module.exports = {
  // tenant context
  tenantContext,
  tenantDbName,
  PLATFORM_DB_NAME,
  TENANT_DB_PREFIX,

  // pools
  getDB,
  getPlatformDB,
  getServerDB,
  getTenantDB,

  // auth
  hashPassword,
  verifyPassword,
  generateToken,
  logEvent,
};
