const express = require('express');
const axios   = require('axios');
const router  = express.Router();
const { getDB, logEvent } = require('../db');
const { getBusinessConfig } = require('../config/business');
const {
  getEmployeeBySlackId,
  postToSlack,
  fmtTimeInZone,
  getSlackUserTz,
} = require('../services/slack');

// POST /clockin — triggered by /clockin in Slack
router.post('/clockin', async (req, res) => {
  const { user_id } = req.body;

  // Respond immediately (Slack requires < 3s)
  res.status(200).end();

  try {
    const pool = await getDB();
    const emp  = await getEmployeeBySlackId(user_id, pool);

    // Check already clocked in
    const [active] = await pool.execute(
      'SELECT * FROM portal_time_entries WHERE portal_user_id=? AND clock_out IS NULL',
      [emp.id]
    );
    if (active.length > 0) {
      const clockInTimestamp = Math.floor(new Date(active[0].clock_in).getTime() / 1000);
      await axios.post(req.body.response_url, {
        response_type: 'ephemeral',
        text: `You're already clocked in since <!date^${clockInTimestamp}^{time}|${new Date(active[0].clock_in).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}>. Use */clockout* when you're done.`,
      });
      return;
    }

    // Clock in
    await pool.execute(
      'INSERT INTO portal_time_entries (portal_user_id, clock_in, notes) VALUES (?, NOW(), ?)',
      [emp.id, 'Via Slack']
    );

    const timestamp = Math.floor(Date.now() / 1000);

    // Announce in #attendance channel
    await postToSlack(`*${emp.name}* (${emp.department}) clocked in at <!date^${timestamp}^{time}|${new Date().toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' })}>`);

  } catch (e) {
    console.error('Slack /clockin error:', e.message);
    if (req.body.response_url) {
      await axios.post(req.body.response_url, {
        response_type: 'ephemeral',
        text: e.message,
      }).catch(() => {});
    }
  }
});

// POST /clockout — triggered by /clockout in Slack
router.post('/clockout', async (req, res) => {
  const { user_id } = req.body;

  // Respond immediately (Slack requires < 3s)
  res.status(200).end();

  try {
    const pool = await getDB();
    const emp  = await getEmployeeBySlackId(user_id, pool);

    // Check not clocked in
    const [active] = await pool.execute(
      'SELECT * FROM portal_time_entries WHERE portal_user_id=? AND clock_out IS NULL',
      [emp.id]
    );
    if (active.length === 0) {
      await axios.post(req.body.response_url, {
        response_type: 'ephemeral',
        text: `You're not clocked in. Use */clockin* to start your session.`,
      });
      return;
    }

    // Auto-close any open break (so leftover breaks don't run forever)
    await pool.execute(
      `UPDATE portal_breaks
         SET break_end = NOW(),
             duration_seconds = TIMESTAMPDIFF(SECOND, break_start, NOW())
       WHERE time_entry_id = ? AND break_end IS NULL`,
      [active[0].id]
    );

    // Clock out
    await pool.execute('UPDATE portal_time_entries SET clock_out=NOW() WHERE id=?', [active[0].id]);

    // Sum break time for this entry (now includes the auto-closed one)
    const [breakRows] = await pool.execute(
      'SELECT COALESCE(SUM(duration_seconds), 0) AS total FROM portal_breaks WHERE time_entry_id = ?',
      [active[0].id]
    );
    const breakSeconds = Number(breakRows[0].total || 0);

    // Gross + net duration
    const clockInTime  = new Date(active[0].clock_in);
    const clockOutTime = new Date();
    const grossMs      = clockOutTime - clockInTime;
    const netMs        = Math.max(0, grossMs - breakSeconds * 1000);
    const fmt = (ms) => {
      const h = Math.floor(ms / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      return h > 0 ? `${h}h ${m}m` : `${m}m`;
    };
    const breakLabel = breakSeconds > 0 ? ` (break *${fmt(breakSeconds * 1000)}*)` : '';

    // Announce in #attendance channel
    const timestampOut = Math.floor(clockOutTime.getTime() / 1000);
    await postToSlack(`*${emp.name}* (${emp.department}) clocked out at <!date^${timestampOut}^{time}|${new Date().toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' })}> — worked *${fmt(netMs)}*${breakLabel}`);

  } catch (e) {
    console.error('Slack /clockout error:', e.message);
    if (req.body.response_url) {
      await axios.post(req.body.response_url, {
        response_type: 'ephemeral',
        text: e.message,
      }).catch(() => {});
    }
  }
});

// POST /break — toggles a break (or use 'start' / 'stop' to be explicit).
// Plain /break: if you're working, start a break; if you're on a break, end it.
router.post('/break', async (req, res) => {
  const { user_id, text } = req.body;
  res.status(200).end();

  const sub = String(text || '').trim().toLowerCase();
  const reply = (t) => axios.post(req.body.response_url, { response_type: 'ephemeral', text: t }).catch(() => {});

  if (sub !== '' && sub !== 'start' && sub !== 'stop' && sub !== 'end') {
    return reply(`Usage: */break* to toggle a break, or */break start* / */break stop* to be explicit. Your work timer pauses during the break.`);
  }

  try {
    const pool = await getDB();
    const emp  = await getEmployeeBySlackId(user_id, pool);

    const [active] = await pool.execute(
      'SELECT id, clock_in FROM portal_time_entries WHERE portal_user_id=? AND clock_out IS NULL',
      [emp.id]
    );
    if (active.length === 0) {
      return reply(`You're not clocked in. Use */clockin* to start your session first.`);
    }
    const entryId = active[0].id;

    const [openBreak] = await pool.execute(
      'SELECT id, break_start FROM portal_breaks WHERE time_entry_id=? AND break_end IS NULL ORDER BY break_start DESC LIMIT 1',
      [entryId]
    );
    const onBreak = openBreak.length > 0;

    // Resolve action: plain /break toggles; explicit start/stop overrides.
    const action = sub === '' ? (onBreak ? 'stop' : 'start')
                  : (sub === 'start' ? 'start' : 'stop');

    if (action === 'start') {
      if (onBreak) {
        // Only reachable via explicit /break start while already on break.
        const since   = new Date(openBreak[0].break_start);
        const elapsed = Math.floor((Date.now() - since) / 60000);
        return reply(`You're already on break (started ${elapsed}m ago). Use */break* to end it.`);
      }
      await pool.execute(
        `INSERT INTO portal_breaks (portal_user_id, time_entry_id, break_start, source)
         VALUES (?, ?, NOW(), 'slack')`,
        [emp.id, entryId]
      );
      return reply(`☕ Break started. Your work timer is paused. Type */break* again when you're back.`);
    }

    // action === 'stop'
    if (!onBreak) {
      // Only reachable via explicit /break stop with no break running.
      return reply(`You're not on a break right now. Use */break* to take one.`);
    }
    await pool.execute(
      `UPDATE portal_breaks
         SET break_end = NOW(),
             duration_seconds = TIMESTAMPDIFF(SECOND, break_start, NOW())
       WHERE id = ?`,
      [openBreak[0].id]
    );
    const since   = new Date(openBreak[0].break_start);
    const elapsed = Math.floor((Date.now() - since) / 1000);
    const mins    = Math.floor(elapsed / 60);
    const secs    = elapsed % 60;
    const dur     = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    return reply(`✅ Break ended after *${dur}*. Work timer resumed.`);

  } catch (e) {
    console.error('Slack /break error:', e.message);
    return reply(`Something went wrong: ${e.message}`);
  }
});

// POST /clockstatus — /clockstatus (ephemeral)
router.post('/clockstatus', async (req, res) => {
  // Respond immediately so Slack doesn't time out
  res.json({ response_type: 'ephemeral', text: 'Checking your status...' });

  try {
    const pool = await getDB();
    const emp  = await getEmployeeBySlackId(req.body.user_id, pool);

    // Use portal_time_entries (same table /clockin and /clockout write to).
    const [active] = await pool.execute(
      'SELECT id, clock_in FROM portal_time_entries WHERE portal_user_id=? AND clock_out IS NULL',
      [emp.id]
    );

    let text;
    if (active.length > 0) {
      const entryId = active[0].id;
      const since   = new Date(active[0].clock_in);
      const grossMs = Date.now() - since;

      // Open break + total break seconds for this entry
      const [openBreak] = await pool.execute(
        'SELECT break_start FROM portal_breaks WHERE time_entry_id=? AND break_end IS NULL ORDER BY break_start DESC LIMIT 1',
        [entryId]
      );
      const [closedBreaks] = await pool.execute(
        'SELECT COALESCE(SUM(duration_seconds), 0) AS total FROM portal_breaks WHERE time_entry_id=? AND break_end IS NOT NULL',
        [entryId]
      );
      const closedSec = Number(closedBreaks[0].total || 0);
      const openSec   = openBreak.length > 0 ? Math.floor((Date.now() - new Date(openBreak[0].break_start)) / 1000) : 0;
      const breakSec  = closedSec + openSec;
      const netMs     = Math.max(0, grossMs - breakSec * 1000);

      const fmt = (ms) => {
        const h = Math.floor(ms / 3600000);
        const m = Math.floor((ms % 3600000) / 60000);
        return h > 0 ? `${h}h ${m}m` : `${m}m`;
      };
      const tz   = await getSlackUserTz(req.body.user_id);
      const time = fmtTimeInZone(since, tz);

      if (openBreak.length > 0) {
        text = `☕ On break since ${Math.floor(openSec / 60)}m ago. Clocked in at *${time}* — *${fmt(netMs)}* worked, *${fmt(breakSec * 1000)}* on break. Use */break stop* to resume.`;
      } else if (breakSec > 0) {
        text = `You're clocked in since *${time}* — *${fmt(netMs)}* worked (took *${fmt(breakSec * 1000)}* in breaks).`;
      } else {
        text = `You're clocked in since *${time}* — *${fmt(netMs)}* so far.`;
      }
    } else {
      text = `You're not clocked in.`;
    }

    await axios.post(req.body.response_url, {
      response_type: 'ephemeral',
      replace_original: true,
      text,
    });

  } catch (e) {
    console.error('Slack /clockstatus error:', e.message);
    if (req.body.response_url) {
      await axios.post(req.body.response_url, {
        response_type: 'ephemeral',
        replace_original: true,
        text: e.message,
      }).catch(() => {});
    }
  }
});

// POST /interactive — Slack button interactions
router.post('/interactive', async (req, res) => {
  // Ack immediately — Slack requires response within 3s
  res.status(200).send();

  let payload;
  try {
    payload = JSON.parse(req.body.payload);
  } catch (e) {
    console.error('❌ Slack interactive: failed to parse payload', e.message);
    return;
  }

  try {
    const actionId = payload.actions?.[0]?.action_id;
    const value    = payload.actions?.[0]?.value;
    const userId   = payload.user?.id;

    const pool = await getDB();
    const timeEntryId = parseInt(value);

    if (actionId === 'ot_continue') {
      await pool.execute(
        'UPDATE portal_time_entries SET ot_decision = ? WHERE id = ?',
        ['continue', timeEntryId]
      );

      const { daily_hours: dh1 } = await getBusinessConfig(pool);
      await axios.post(payload.response_url, {
        replace_original: true,
        text: `✅ *Overtime Approved*\n\nYou chose to continue working. All time after ${dh1.toFixed(1)} hours will be tracked as overtime.\n\nClock out when you're done!`,
      });

      console.log(`✅ Employee chose to continue working (OT approved) - Entry ${timeEntryId}`);

    } else if (actionId === 'ot_clockout') {
      // Employee chose to clock out at the daily threshold
      const [entry] = await pool.execute(
        'SELECT * FROM portal_time_entries WHERE id = ?',
        [timeEntryId]
      );

      if (entry.length > 0 && !entry[0].clock_out) {
        const { daily_hours: dh, daily_ms } = await getBusinessConfig(pool);
        const clockIn  = new Date(entry[0].clock_in);
        const clockOut = new Date(clockIn.getTime() + daily_ms);

        await pool.execute(
          'UPDATE portal_time_entries SET clock_out = ?, ot_decision = ? WHERE id = ?',
          [clockOut, 'stopped', timeEntryId]
        );

        const [puRows] = await pool.execute(
          'SELECT * FROM portal_users WHERE id = ?',
          [entry[0].portal_user_id]
        );
        const pu = puRows[0];

        await logEvent(pool, {
          employee_id: pu?.employee_id || null,
          employee_name: pu?.name,
          department: pu?.department,
          role: pu?.role,
          event: 'clock_out',
          detail: `Clocked out at ${dh.toFixed(1)}h via OT prompt`
        });

        const tz = await getSlackUserTz(userId);
        const clockOutTimestamp = Math.floor(clockOut.getTime() / 1000);
        await postToSlack(`🔴 *${pu?.name}* (${pu?.department}) clocked out (auto at ${dh.toFixed(1)}h) at <!date^${clockOutTimestamp}^{time}|${fmtTimeInZone(clockOut, tz)}>`);

        await axios.post(payload.response_url, {
          replace_original: true,
          text: `✅ *Clocked Out*\n\nYou've been automatically clocked out after exactly *${dh.toFixed(1)} hours*.\n\nNo overtime recorded. Great work today!`,
        });

        console.log(`✅ Employee clocked out at ${dh.toFixed(1)}h (no OT) - ${pu?.name}`);
      }

    } else if (actionId === 'ot_clockout_yes' || actionId === 'ot_clockout_no') {
      const decision = actionId === 'ot_clockout_yes' ? 'continue' : 'stopped';

      await pool.execute(
        'UPDATE portal_time_entries SET ot_decision = ? WHERE id = ?',
        [decision, timeEntryId]
      );

      if (decision === 'stopped') {
        const [entry] = await pool.execute('SELECT * FROM portal_time_entries WHERE id = ?', [timeEntryId]);
        if (entry.length > 0) {
          const { daily_hours: dh, daily_ms } = await getBusinessConfig(pool);
          const clockIn  = new Date(entry[0].clock_in);
          const clockOut = new Date(clockIn.getTime() + daily_ms);

          await pool.execute('UPDATE portal_time_entries SET clock_out = ? WHERE id = ?', [clockOut, timeEntryId]);

          await axios.post(payload.response_url, {
            replace_original: true,
            text: `✅ Hours capped at *${dh.toFixed(1)}h*. No overtime recorded.`,
          });
        }
      } else {
        await axios.post(payload.response_url, {
          replace_original: true,
          text: `✅ Full hours recorded including overtime.`,
        });
      }
    }

  } catch (e) {
    console.error('❌ Slack interactive error:', e.message);
    // Try to surface the error back to the user in Slack
    if (payload?.response_url) {
      await axios.post(payload.response_url, {
        replace_original: false,
        text: `❌ Something went wrong: ${e.message}`,
      }).catch(() => {});
    }
  }
});

module.exports = router;
