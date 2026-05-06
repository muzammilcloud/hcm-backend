const express = require('express');
const axios   = require('axios');
const router  = express.Router();
const { getDB, logEvent } = require('../db');
const { OT_THRESHOLD_MS } = require('../config/business');
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

    // Clock out
    await pool.execute('UPDATE portal_time_entries SET clock_out=NOW() WHERE id=?', [active[0].id]);

    // Note: portal_time_entries is separate from time_entries — OT requests are
    // handled when sessions are reviewed in the admin portal.

    // Calculate duration
    const clockInTime  = new Date(active[0].clock_in);
    const clockOutTime = new Date();
    const diffMs       = clockOutTime - clockInTime;
    const hours        = Math.floor(diffMs / 3600000);
    const minutes      = Math.floor((diffMs % 3600000) / 60000);
    const duration     = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

    // Announce in #attendance channel
    const timestampOut = Math.floor(clockOutTime.getTime() / 1000);
    await postToSlack(`*${emp.name}* (${emp.department}) clocked out at <!date^${timestampOut}^{time}|${new Date().toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' })}> — worked *${duration}*`);

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

// POST /clockstatus — /clockstatus (ephemeral)
router.post('/clockstatus', async (req, res) => {
  // Respond immediately so Slack doesn't time out
  res.json({ response_type: 'ephemeral', text: 'Checking your status...' });

  try {
    const pool = await getDB();
    const emp  = await getEmployeeBySlackId(req.body.user_id, pool);

    const [active] = await pool.execute(
      'SELECT * FROM time_entries WHERE employee_id=? AND clock_out IS NULL',
      [emp.id]
    );

    let text;
    if (active.length > 0) {
      const since    = new Date(active[0].clock_in);
      const diffMs   = Date.now() - since;
      const hours    = Math.floor(diffMs / 3600000);
      const minutes  = Math.floor((diffMs % 3600000) / 60000);
      const duration = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
      const tz       = await getSlackUserTz(req.body.user_id);
      const time     = fmtTimeInZone(since, tz);
      text = `You're clocked in since *${time}* — *${duration}* so far.`;
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

      await axios.post(payload.response_url, {
        replace_original: true,
        text: `✅ *Overtime Approved*\n\nYou chose to continue working. All time after 9 hours will be tracked as overtime.\n\nClock out when you're done!`,
      });

      console.log(`✅ Employee chose to continue working (OT approved) - Entry ${timeEntryId}`);

    } else if (actionId === 'ot_clockout') {
      // Employee chose to clock out at 9 hours
      const [entry] = await pool.execute(
        'SELECT * FROM portal_time_entries WHERE id = ?',
        [timeEntryId]
      );

      if (entry.length > 0 && !entry[0].clock_out) {
        const clockIn  = new Date(entry[0].clock_in);
        const clockOut = new Date(clockIn.getTime() + (OT_THRESHOLD_MS));

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
          detail: `Clocked out at 9h via OT prompt`
        });

        const tz = await getSlackUserTz(userId);
        const clockOutTimestamp = Math.floor(clockOut.getTime() / 1000);
        await postToSlack(`🔴 *${pu?.name}* (${pu?.department}) clocked out (auto at 9h) at <!date^${clockOutTimestamp}^{time}|${fmtTimeInZone(clockOut, tz)}>`);

        await axios.post(payload.response_url, {
          replace_original: true,
          text: `✅ *Clocked Out*\n\nYou've been automatically clocked out after exactly *9 hours*.\n\nNo overtime recorded. Great work today!`,
        });

        console.log(`✅ Employee clocked out at 9h (no OT) - ${pu?.name}`);
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
          const clockIn  = new Date(entry[0].clock_in);
          const clockOut = new Date(clockIn.getTime() + (OT_THRESHOLD_MS));

          await pool.execute('UPDATE portal_time_entries SET clock_out = ? WHERE id = ?', [clockOut, timeEntryId]);

          await axios.post(payload.response_url, {
            replace_original: true,
            text: `✅ Hours capped at *9.0h*. No overtime recorded.`,
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
