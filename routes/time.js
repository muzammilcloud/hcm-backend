const express = require('express');
const router  = express.Router();
const { getDB, logEvent } = require('../db');
const { requireAdmin, requireEmployee } = require('../middleware/auth');
const { postToSlack, getSlackUserIdByEmail, sendSlackDM } = require('../services/slack');
const { getBusinessConfig } = require('../config/business');
const { tenantHas } = require('../services/features');

// POST /api/employee/clock-in
router.post('/employee/clock-in', requireEmployee, async (req, res) => {
  try {
    const pool = await getDB();
    const [active] = await pool.execute(
      'SELECT * FROM portal_time_entries WHERE portal_user_id=? AND clock_out IS NULL', [req.portalUserId]
    );
    if (active.length > 0) return res.status(400).json({ error: 'Already clocked in' });

    const [result] = await pool.execute(
      'INSERT INTO portal_time_entries (portal_user_id, clock_in, notes) VALUES (?, NOW(), ?)',
      [req.portalUserId, req.body.notes || '']
    );
    const [rows] = await pool.execute('SELECT * FROM portal_time_entries WHERE id=?', [result.insertId]);
    const [puInfo] = await pool.execute('SELECT * FROM portal_users WHERE id=?', [req.portalUserId]);
    if (puInfo[0]) {
      await logEvent(pool, { employee_name: puInfo[0].name, department: puInfo[0].department, role: puInfo[0].role, event: 'clocked_in', detail: `Clocked in at ${new Date().toLocaleTimeString()}` });
      const timestamp = Math.floor(Date.now() / 1000);
      await postToSlack(`*${puInfo[0].name}* (${puInfo[0].department}) clocked in at <!date^${timestamp}^{time}|${new Date().toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' })}>`);
    }
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/employee/clock-out
router.post('/employee/clock-out', requireEmployee, async (req, res) => {
  try {
    const pool = await getDB();
    const [active] = await pool.execute(
      'SELECT * FROM portal_time_entries WHERE portal_user_id=? AND clock_out IS NULL', [req.portalUserId]
    );
    if (active.length === 0) return res.status(400).json({ error: 'Not clocked in' });

    const entry       = active[0];
    const hoursWorked = (Date.now() - new Date(entry.clock_in).getTime()) / 3600000;
    const biz         = await getBusinessConfig(pool);
    const dailyHours  = biz.daily_hours;
    const dailyMs     = biz.daily_ms;
    // Overtime detection is a Growth feature. Starter tenants get no OT prompt
    // and accrue no overtime — they simply clock out at the worked time.
    const otEnabled   = tenantHas(req.tenant, 'overtime_detection');

    if (otEnabled && hoursWorked >= dailyHours && !entry.ot_decision) {
      const [puInfo] = await pool.execute('SELECT * FROM portal_users WHERE id=?', [req.portalUserId]);
      const pu = puInfo[0];
      let slackUserId = pu?.slack_user_id;
      if (!slackUserId && pu?.email) {
        slackUserId = await getSlackUserIdByEmail(pu.email);
        if (slackUserId) await pool.execute('UPDATE portal_users SET slack_user_id=? WHERE id=?', [slackUserId, pu.id]);
      }
      if (slackUserId) {
        const dailyLabel = `${dailyHours.toFixed(1)} hours`;
        const blocks = [
          { type: "section", text: { type: "mrkdwn", text: `⚠️ *You worked more than ${dailyLabel} today*\n\nYou worked *${hoursWorked.toFixed(1)} hours*.\n\nShould we count the extra time as overtime?` } },
          { type: "actions", block_id: `ot_clockout_${entry.id}`, elements: [
            { type: "button", text: { type: "plain_text", text: "Yes, Count as OT", emoji: true }, style: "primary", action_id: "ot_clockout_yes", value: String(entry.id) },
            { type: "button", text: { type: "plain_text", text: `No, Cap at ${dailyHours.toFixed(1)} Hours`, emoji: true }, action_id: "ot_clockout_no", value: String(entry.id) }
          ]}
        ];
        await sendSlackDM(slackUserId, `⚠️ You worked more than ${dailyLabel} today`, blocks);
      }
      return res.json({ requires_ot_decision: true, time_entry_id: entry.id, hours_worked: hoursWorked.toFixed(2) });
    }

    // Auto-close any open break before clocking out, so its duration is recorded.
    await pool.execute(
      `UPDATE portal_breaks
         SET break_end = NOW(),
             duration_seconds = TIMESTAMPDIFF(SECOND, break_start, NOW())
       WHERE time_entry_id = ? AND break_end IS NULL`,
      [entry.id]
    );

    if (entry.ot_decision === 'stopped') {
      const clockOut = new Date(new Date(entry.clock_in).getTime() + dailyMs);
      await pool.execute('UPDATE portal_time_entries SET clock_out=? WHERE id=?', [clockOut, entry.id]);
    } else {
      await pool.execute('UPDATE portal_time_entries SET clock_out=NOW() WHERE id=?', [entry.id]);
    }

    const [rows] = await pool.execute('SELECT * FROM portal_time_entries WHERE id=?', [entry.id]);
    const sessionHours = (new Date(rows[0].clock_out) - new Date(rows[0].clock_in)) / 3600000;

    if (otEnabled && sessionHours > dailyHours) {
      const otHours = parseFloat((sessionHours - dailyHours).toFixed(2));
      if (otHours > 0) {
        await pool.execute(
          `INSERT INTO ot_requests (time_entry_id, employee_id, date, total_hours, ot_hours, idle_deducted)
           VALUES (?, ?, DATE(?), ?, ?, 0)
           ON DUPLICATE KEY UPDATE total_hours=VALUES(total_hours), ot_hours=VALUES(ot_hours), idle_deducted=0`,
          [entry.id, req.portalUserId, rows[0].clock_in, parseFloat(sessionHours.toFixed(2)), otHours]
        );
      }
    }

    const diffMs  = new Date(rows[0].clock_out) - new Date(rows[0].clock_in);
    const hours   = Math.floor(diffMs / 3600000);
    const minutes = Math.floor((diffMs % 3600000) / 60000);
    const dur     = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

    const [puInfo] = await pool.execute('SELECT * FROM portal_users WHERE id=?', [req.portalUserId]);
    if (puInfo[0]) {
      await logEvent(pool, { employee_name: puInfo[0].name, department: puInfo[0].department, role: puInfo[0].role, event: 'clocked_out', detail: `Clocked out · ${dur}` });
      const timestamp = Math.floor(Date.now() / 1000);
      await postToSlack(`*${puInfo[0].name}* (${puInfo[0].department}) clocked out at <!date^${timestamp}^{time}|${new Date().toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' })}> — worked *${dur}*`);
    }
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/employee/clock-status
router.get('/employee/clock-status', requireEmployee, async (req, res) => {
  try {
    const pool = await getDB();
    const [rows] = await pool.execute(
      'SELECT * FROM portal_time_entries WHERE portal_user_id=? AND clock_out IS NULL', [req.portalUserId]
    );
    const entry = rows[0] || null;
    let onBreak = false, breakStart = null, breakSeconds = 0;
    if (entry) {
      const [openB] = await pool.execute(
        'SELECT break_start FROM portal_breaks WHERE time_entry_id=? AND break_end IS NULL ORDER BY break_start DESC LIMIT 1',
        [entry.id]
      );
      onBreak    = openB.length > 0;
      breakStart = onBreak ? openB[0].break_start : null;
      // Total break time so far for this session (closed breaks + the running one).
      const [sum] = await pool.execute(
        `SELECT COALESCE(SUM(CASE WHEN break_end IS NULL
                  THEN TIMESTAMPDIFF(SECOND, break_start, NOW())
                  ELSE duration_seconds END), 0) AS total
           FROM portal_breaks WHERE time_entry_id=?`,
        [entry.id]
      );
      breakSeconds = Number(sum[0].total || 0);
    }
    res.json({ clocked_in: !!entry, entry, on_break: onBreak, break_started_at: breakStart, break_seconds: breakSeconds });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/employee/break/toggle — start a break if working, end it if on break.
// Mirrors the Slack /break command so web users get the same break tracking.
router.post('/employee/break/toggle', requireEmployee, async (req, res) => {
  try {
    const pool = await getDB();
    const [active] = await pool.execute(
      'SELECT id FROM portal_time_entries WHERE portal_user_id=? AND clock_out IS NULL', [req.portalUserId]
    );
    if (active.length === 0) return res.status(400).json({ error: 'You need to be clocked in to take a break.' });
    const entryId = active[0].id;

    const [openBreak] = await pool.execute(
      'SELECT id, break_start FROM portal_breaks WHERE time_entry_id=? AND break_end IS NULL ORDER BY break_start DESC LIMIT 1',
      [entryId]
    );

    if (openBreak.length > 0) {
      // End the break.
      await pool.execute(
        `UPDATE portal_breaks
            SET break_end = NOW(), duration_seconds = TIMESTAMPDIFF(SECOND, break_start, NOW())
          WHERE id = ?`,
        [openBreak[0].id]
      );
      return res.json({ on_break: false });
    }

    // Start a break.
    await pool.execute(
      `INSERT INTO portal_breaks (portal_user_id, time_entry_id, break_start, source)
       VALUES (?, ?, NOW(), 'web')`,
      [req.portalUserId, entryId]
    );
    res.json({ on_break: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/employee/time-entries
router.get('/employee/time-entries', requireEmployee, async (req, res) => {
  const { from, to } = req.query;
  try {
    const pool = await getDB();
    let query  = `SELECT *, ROUND(TIMESTAMPDIFF(SECOND, clock_in, COALESCE(clock_out, NOW()))/3600, 2) as hours FROM portal_time_entries WHERE portal_user_id=?`;
    const params = [req.portalUserId];
    if (from) { query += ' AND DATE(clock_in) >= ?'; params.push(from); }
    if (to)   { query += ' AND DATE(clock_in) <= ?'; params.push(to); }
    query += ' ORDER BY clock_in DESC';
    const [rows] = await pool.execute(query, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/employee/summary
router.get('/employee/summary', requireEmployee, async (req, res) => {
  try {
    const pool = await getDB();

    // Break-seconds aggregator: counts open breaks against their running elapsed time.
    const breakSec = `
      COALESCE((
        SELECT SUM(
          CASE WHEN pb.break_end IS NULL
                 THEN TIMESTAMPDIFF(SECOND, pb.break_start, NOW())
               ELSE pb.duration_seconds
          END
        )
        FROM portal_breaks pb
        WHERE pb.time_entry_id = pte.id
      ), 0)
    `;

    const [thisWeek]  = await pool.execute(`SELECT ROUND(SUM(TIMESTAMPDIFF(SECOND,clock_in,COALESCE(clock_out,NOW()))/3600),2) as hours, ROUND(SUM(${breakSec})/3600, 2) as break_hours, COUNT(*) as sessions FROM portal_time_entries pte WHERE portal_user_id=? AND YEARWEEK(clock_in,1)=YEARWEEK(NOW(),1)`, [req.portalUserId]);
    const [thisMonth] = await pool.execute(`SELECT ROUND(SUM(TIMESTAMPDIFF(SECOND,clock_in,COALESCE(clock_out,NOW()))/3600),2) as hours, ROUND(SUM(${breakSec})/3600, 2) as break_hours, COUNT(*) as sessions FROM portal_time_entries pte WHERE portal_user_id=? AND MONTH(clock_in)=MONTH(NOW()) AND YEAR(clock_in)=YEAR(NOW())`, [req.portalUserId]);
    const [today]     = await pool.execute(`SELECT ROUND(SUM(TIMESTAMPDIFF(SECOND,clock_in,COALESCE(clock_out,NOW()))/3600),2) as hours, ROUND(SUM(${breakSec})/3600, 2) as break_hours, COUNT(*) as sessions FROM portal_time_entries pte WHERE portal_user_id=? AND DATE(clock_in)=CURDATE()`, [req.portalUserId]);
    const [daily]     = await pool.execute(`SELECT DATE(clock_in) as date, ROUND(SUM(TIMESTAMPDIFF(SECOND,clock_in,COALESCE(clock_out,NOW()))/3600),2) as hours, ROUND(SUM(${breakSec})/3600, 2) as break_hours FROM portal_time_entries pte WHERE portal_user_id=? AND clock_in>=DATE_SUB(NOW(),INTERVAL 7 DAY) GROUP BY DATE(clock_in) ORDER BY date ASC`, [req.portalUserId]);

    const withNet = (row) => ({
      hours: row.hours || 0,
      break_hours: row.break_hours || 0,
      net_hours: Math.max(0, Number(((row.hours || 0) - (row.break_hours || 0)).toFixed(2))),
      sessions: row.sessions || 0,
    });

    res.json({
      today:      withNet(today[0]),
      this_week:  withNet(thisWeek[0]),
      this_month: withNet(thisMonth[0]),
      daily_breakdown: daily.map((d) => ({
        date: d.date,
        hours: d.hours || 0,
        break_hours: d.break_hours || 0,
        net_hours: Math.max(0, Number(((d.hours || 0) - (d.break_hours || 0)).toFixed(2))),
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/employee/idle — Record a browser-detected idle period
router.post('/employee/idle', requireEmployee, async (req, res) => {
  const { idle_start, idle_end } = req.body;
  if (!idle_start || !idle_end) return res.status(400).json({ error: 'idle_start and idle_end required' });
  const duration_minutes = Math.ceil((new Date(idle_end) - new Date(idle_start)) / 60000);
  if (duration_minutes < 1) return res.json({ ignored: true }); // sub-minute noise — discard
  // Convert ISO 8601 strings to MySQL-compatible datetime strings
  const toMySQLDatetime = iso => new Date(iso).toISOString().slice(0, 19).replace('T', ' ');
  const mysqlStart = toMySQLDatetime(idle_start);
  const mysqlEnd   = toMySQLDatetime(idle_end);
  try {
    const pool = await getDB();
    // Auto-link to the time entry active during this idle period
    const [entries] = await pool.execute(
      `SELECT id FROM portal_time_entries
       WHERE portal_user_id = ? AND clock_in <= ? AND (clock_out IS NULL OR clock_out >= ?)
       ORDER BY clock_in DESC LIMIT 1`,
      [req.portalUserId, mysqlStart, mysqlStart]
    );
    const time_entry_id = entries[0]?.id || null;
    await pool.execute(
      'INSERT INTO idle_sessions (portal_user_id, time_entry_id, idle_start, idle_end, duration_minutes) VALUES (?,?,?,?,?)',
      [req.portalUserId, time_entry_id, mysqlStart, mysqlEnd, duration_minutes]
    );
    res.json({ success: true, duration_minutes, time_entry_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/employee/idle-sessions — Employee: own idle history
router.get('/employee/idle-sessions', requireEmployee, async (req, res) => {
  const { from, to } = req.query;
  try {
    const pool = await getDB();
    let q = 'SELECT * FROM idle_sessions WHERE portal_user_id = ?';
    const params = [req.portalUserId];
    if (from) { q += ' AND DATE(idle_start) >= ?'; params.push(from); }
    if (to)   { q += ' AND DATE(idle_start) <= ?'; params.push(to); }
    q += ' ORDER BY idle_start DESC';
    const [rows] = await pool.execute(q, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/time-entries — Admin (portal users' time entries)
router.get('/time-entries', requireAdmin, async (req, res) => {
  const { portal_user_id, from, to } = req.query;
  try {
    const pool = await getDB();
    let query = `
      SELECT pte.*, pu.name as employee_name, pu.department,
        ROUND(TIMESTAMPDIFF(SECOND, pte.clock_in, COALESCE(pte.clock_out, NOW()))/3600, 2) as hours
      FROM portal_time_entries pte JOIN portal_users pu ON pte.portal_user_id = pu.id WHERE 1=1
    `;
    const params = [];
    if (portal_user_id) { query += ' AND pte.portal_user_id = ?'; params.push(portal_user_id); }
    if (req.query.department) { query += ' AND pu.department = ?'; params.push(req.query.department); }
    if (from) { query += ' AND DATE(pte.clock_in) >= ?'; params.push(from); }
    if (to)   { query += ' AND DATE(pte.clock_in) <= ?'; params.push(to); }
    query += ' ORDER BY pte.clock_in DESC';
    const [rows] = await pool.execute(query, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/attendance/live — Admin live dashboard
router.get('/attendance/live', requireAdmin, async (req, res) => {
  try {
    const pool = await getDB();
    const [rows] = await pool.execute(`
      SELECT pu.id, pu.name, pu.department, pu.role,
        pte.clock_in,
        ROUND(TIMESTAMPDIFF(SECOND, pte.clock_in, NOW())/3600, 4) as hours_elapsed,
        TIMESTAMPDIFF(SECOND, pte.clock_in, NOW()) as seconds_elapsed,
        (SELECT ROUND(COALESCE(SUM(TIMESTAMPDIFF(SECOND,clock_in,COALESCE(clock_out,NOW()))/3600),0),2) FROM portal_time_entries WHERE portal_user_id=pu.id AND DATE(clock_in)=CURDATE()) as today_hours,
        (SELECT ROUND(COALESCE(SUM(TIMESTAMPDIFF(SECOND,clock_in,COALESCE(clock_out,NOW()))/3600),0),2) FROM portal_time_entries WHERE portal_user_id=pu.id AND YEARWEEK(clock_in,1)=YEARWEEK(NOW(),1)) as week_hours,
        (SELECT ROUND(COALESCE(SUM(TIMESTAMPDIFF(SECOND,clock_in,COALESCE(clock_out,NOW()))/3600),0),2) FROM portal_time_entries WHERE portal_user_id=pu.id AND YEAR(clock_in)=YEAR(NOW()) AND MONTH(clock_in)=MONTH(NOW())) as month_hours
      FROM portal_users pu
      JOIN portal_time_entries pte ON pu.id = pte.portal_user_id
      WHERE pte.clock_out IS NULL AND pu.status = 'active'
      ORDER BY pte.clock_in ASC
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
