const axios  = require('axios');
const crypto = require('crypto');
const { getDB } = require('../db');

// Verify Slack signing secret so only real Slack requests are accepted
function verifySlackSignature(req) {
  const secret    = process.env.SLACK_SIGNING_SECRET;
  if (!secret) return true; // skip in dev if not configured
  const timestamp = req.headers['x-slack-request-timestamp'];
  const sigHeader = req.headers['x-slack-signature'];
  if (!timestamp || !sigHeader) return false;
  // Reject requests older than 5 minutes
  if (Math.abs(Date.now() / 1000 - timestamp) > 300) return false;
  const sigBase = `v0:${timestamp}:${req.rawBody || ''}`;
  const hmac    = crypto.createHmac('sha256', secret).update(sigBase).digest('hex');
  return `v0=${hmac}` === sigHeader;
}

// Post a message to the #attendance Slack channel
async function postToSlack(text, blocks = null) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) { console.warn('⚠️  SLACK_WEBHOOK_URL not set — skipping Slack post'); return; }
  try {
    await axios.post(webhookUrl, blocks ? { text, blocks } : { text });
  } catch (e) {
    console.error('❌ Slack post failed:', e.message);
  }
}

// Post to the dedicated daily-leave-report Slack channel (separate from #attendance).
async function postLeaveReportToSlack(text, blocks = null) {
  const webhookUrl = process.env.SLACK_LEAVE_REPORT_WEBHOOK_URL;
  if (!webhookUrl) { console.warn('⚠️  SLACK_LEAVE_REPORT_WEBHOOK_URL not set — skipping leave report post'); return; }
  try {
    await axios.post(webhookUrl, blocks ? { text, blocks } : { text });
  } catch (e) {
    console.error('❌ Slack leave-report post failed:', e.message);
  }
}

// Look up portal user by Slack user_id via Slack API (matches email)
async function getEmployeeBySlackId(slackUserId, pool) {
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) throw new Error('SLACK_BOT_TOKEN not configured.');

  const resp = await axios.get('https://slack.com/api/users.info', {
    params: { user: slackUserId },
    headers: { Authorization: `Bearer ${botToken}` },
  });

  if (!resp.data.ok) throw new Error('Could not fetch your Slack profile.');
  const email = resp.data.user?.profile?.email;
  if (!email)   throw new Error('No email found on your Slack profile. Please add one in Slack settings.');

  // Match to portal user by email
  const [rows] = await pool.execute(
    "SELECT * FROM portal_users WHERE email = ? AND status = 'active'",
    [email]
  );
  if (rows.length === 0) throw new Error(`No active HCM account found for *${email}*. Ask your admin to send you an invite.`);
  return rows[0];
}

// Format time in a given IANA timezone
function fmtTimeInZone(date, tz) {
  try {
    return date.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', timeZone: tz });
  } catch (_) {
    return date.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' });
  }
}

// Get Slack user's timezone via API
async function getSlackUserTz(userId) {
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) return 'UTC';
  try {
    const resp = await axios.get('https://slack.com/api/users.info', {
      params: { user: userId },
      headers: { Authorization: `Bearer ${botToken}` },
    });
    return resp.data?.user?.tz || 'UTC';
  } catch (_) { return 'UTC'; }
}

// Get Slack user ID by email
async function getSlackUserIdByEmail(email) {
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) return null;
  try {
    const resp = await axios.get('https://slack.com/api/users.lookupByEmail', {
      params: { email },
      headers: { Authorization: `Bearer ${botToken}` },
    });
    if (resp.data.ok) {
      return resp.data.user?.id;
    }
    return null;
  } catch (_) { return null; }
}

// Send Slack DM to user
async function sendSlackDM(userId, text, blocks = null) {
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) {
    console.warn('⚠️  SLACK_BOT_TOKEN not set — skipping Slack DM');
    return false;
  }
  try {
    const payload = {
      channel: userId,
      text,
      ...(blocks && { blocks }),
    };
    const resp = await axios.post('https://slack.com/api/chat.postMessage', payload, {
      headers: {
        Authorization: `Bearer ${botToken}`,
        'Content-Type': 'application/json',
      },
    });
    return resp.data.ok;
  } catch (e) {
    console.error('❌ Slack DM failed:', e.message);
    return false;
  }
}

// Send ephemeral Slack message (only visible to user)
async function sendSlackEphemeral(channel, userId, text, blocks = null) {
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) {
    console.warn('⚠️  SLACK_BOT_TOKEN not set — skipping ephemeral message');
    return false;
  }
  try {
    const payload = {
      channel,
      user: userId,
      text,
      ...(blocks && { blocks }),
    };
    const resp = await axios.post('https://slack.com/api/chat.postEphemeral', payload, {
      headers: {
        Authorization: `Bearer ${botToken}`,
        'Content-Type': 'application/json',
      },
    });
    return resp.data.ok;
  } catch (e) {
    console.error('❌ Slack ephemeral failed:', e.message);
    return false;
  }
}

// OT Checker (runs every 5 minutes)
async function checkOvertimePrompts() {
  try {
    const pool = await getDB();

    const [activeEntries] = await pool.execute(`
      SELECT pte.id, pte.portal_user_id, pte.clock_in, pte.ot_prompt_sent,
             pu.name, pu.email, pu.slack_user_id,
             TIMESTAMPDIFF(SECOND, pte.clock_in, NOW()) / 3600 as hours_worked
      FROM portal_time_entries pte
      JOIN portal_users pu ON pte.portal_user_id = pu.id
      WHERE pte.clock_out IS NULL AND pte.ot_prompt_sent = 0
      HAVING hours_worked >= 9
    `);

    for (const entry of activeEntries) {
      let slackUserId = entry.slack_user_id;
      if (!slackUserId) {
        slackUserId = await getSlackUserIdByEmail(entry.email);
        if (slackUserId) {
          await pool.execute('UPDATE portal_users SET slack_user_id = ? WHERE id = ?', [slackUserId, entry.portal_user_id]);
        }
      }

      if (!slackUserId) {
        console.warn(`⚠️  No Slack user found for ${entry.email} - skipping OT prompt`);
        continue;
      }

      // Send DM with interactive buttons
      const text = `⏰ *9 Hours Complete!*\n\nYou've been working for 9 hours today.\n\nDo you want to continue working (overtime will be tracked) or clock out now?`;
      const blocks = [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `⏰ *9 Hours Complete!*\n\nYou've been working for *9 hours* today.\n\nDo you want to continue working (overtime will be tracked) or clock out now?`
          }
        },
        {
          type: "actions",
          block_id: `ot_prompt_${entry.id}`,
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Continue Working", emoji: true },
              style: "primary",
              action_id: "ot_continue",
              value: String(entry.id)
            },
            {
              type: "button",
              text: { type: "plain_text", text: "Clock Out Now", emoji: true },
              style: "danger",
              action_id: "ot_clockout",
              value: String(entry.id)
            }
          ]
        }
      ];

      const sent = await sendSlackDM(slackUserId, text, blocks);

      if (sent) {
        await pool.execute('UPDATE portal_time_entries SET ot_prompt_sent = 1 WHERE id = ?', [entry.id]);
        console.log(`✅ OT prompt sent to ${entry.name} (${Math.floor(entry.hours_worked)}h worked)`);
      }
    }
  } catch (e) {
    console.error('❌ OT checker error:', e.message);
  }
}

// Start OT checker (every 5 minutes)
function startOTChecker() {
  checkOvertimePrompts(); // Run immediately
  setInterval(checkOvertimePrompts, 5 * 60 * 1000); // Then every 5 minutes
  console.log('✅ OT checker started (runs every 5 minutes)');
}

module.exports = {
  verifySlackSignature,
  postToSlack,
  postLeaveReportToSlack,
  getEmployeeBySlackId,
  fmtTimeInZone,
  getSlackUserTz,
  getSlackUserIdByEmail,
  sendSlackDM,
  sendSlackEphemeral,
  checkOvertimePrompts,
  startOTChecker,
};
