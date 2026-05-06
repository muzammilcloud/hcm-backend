const mysql  = require('mysql2/promise');
const crypto = require('crypto');

let db;
async function getDB() {
  if (!db) {
    db = await mysql.createPool({
      host:     process.env.DB_HOST     || 'localhost',
      port:     process.env.DB_PORT     || 3306,
      user:     process.env.DB_USER     || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME     || 'queckots',
      waitForConnections: true,
      connectionLimit: 10,
      dateStrings: ['DATE'],
    });
  }
  return db;
}

const hashPassword = (pw) => crypto.createHash('sha256').update(pw).digest('hex');
const generateToken = () => crypto.randomBytes(32).toString('hex');

async function logEvent(pool, { employee_id, employee_name, department, role, event, detail }) {
  try {
    await pool.execute(
      'INSERT INTO employee_logs (employee_id, employee_name, department, role, event, detail) VALUES (?,?,?,?,?,?)',
      [employee_id || null, employee_name, department || null, role || null, event, detail || null]
    );
  } catch (e) { console.error('Log error:', e.message); }
}

module.exports = { getDB, hashPassword, generateToken, logEvent };
