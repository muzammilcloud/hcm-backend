const express = require('express');
const { getPlatformDB } = require('../../db');
const { POLAR_WEBHOOK_SECRET, isConfigured } = require('../../lib/polarConstants');
const { applyWebhookEvent } = require('../../services/billing');

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhooks/polar
//
// Polar uses the Standard Webhooks spec. The raw request body is required for
// signature verification, which is why this route MUST be registered before
// express.json() at the app level.
//
// Idempotency: every event.id is recorded once in polar_webhook_events.
// Subsequent deliveries with the same id return 200 without re-applying.
//
// We always respond 200 once the signature verifies — even on internal
// errors — because Polar's retry policy disables endpoints after 10
// consecutive non-2xx responses. Failed application is logged for forensics
// (the billing_events row is written before the handler runs).
// ─────────────────────────────────────────────────────────────────────────────

const router = express.Router();

// express.raw() turns the body into a Buffer; validateEvent expects that
// exact buffer + the raw header collection. Do NOT call express.json() on
// this route or signature verification will silently fail.
router.post('/polar', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!isConfigured()) {
    // No secret configured. Acknowledge so Polar doesn't keep retrying
    // (e.g. during sandbox bring-up before we set the secret).
    return res.status(202).send('');
  }

  let event;
  try {
    const { validateEvent } = require('@polar-sh/sdk/webhooks');
    event = validateEvent(req.body, req.headers, POLAR_WEBHOOK_SECRET);
  } catch (e) {
    const { WebhookVerificationError } = require('@polar-sh/sdk/webhooks');
    if (e instanceof WebhookVerificationError) {
      // Genuinely bad signature. Reject per Polar docs; don't leak why.
      return res.status(403).send('');
    }
    // The signature verified (validateEvent checks the signature BEFORE mapping
    // the payload), but the pinned SDK (0.34) couldn't map this event — most
    // likely a seat_based subscription whose response shape the old schema
    // doesn't model. Don't drop a valid, signed event: re-verify the signature
    // independently and apply the raw JSON. Handlers read both the SDK's
    // camelCase and the raw snake_case field shapes.
    try {
      const { Webhook } = require('standardwebhooks');
      const wh = new Webhook(Buffer.from(POLAR_WEBHOOK_SECRET, 'utf-8').toString('base64'));
      event = wh.verify(req.body, req.headers); // throws if the signature is invalid
      console.warn('[polar webhook] SDK could not map event; applied via verified raw-JSON fallback:', e.message);
    } catch (verifyErr) {
      return res.status(403).send('');
    }
  }

  const eventId = event?.id || req.headers['webhook-id'] || null;
  const eventType = event?.type || 'unknown';

  // Idempotency: insert-ignore. If the row already exists, we've seen this
  // event before — acknowledge without re-applying.
  if (eventId) {
    try {
      const platform = getPlatformDB();
      const [result] = await platform.execute(
        `INSERT IGNORE INTO polar_webhook_events (event_id, event_type) VALUES (?, ?)`,
        [eventId, eventType]
      );
      // affectedRows === 0 means the event_id already existed.
      if (result.affectedRows === 0) {
        return res.status(202).send('');
      }
    } catch (e) {
      console.error('[polar webhook] dedup insert failed:', e.message);
      // Continue — better to risk a duplicate apply than lose the event.
    }
  }

  try {
    await applyWebhookEvent(event);
    if (eventId) {
      const platform = getPlatformDB();
      await platform.execute(
        `UPDATE polar_webhook_events SET processed_at = NOW() WHERE event_id = ?`,
        [eventId]
      ).catch(() => {});
    }
  } catch (e) {
    // Swallow — we already logged via applyWebhookEvent + the dedup row
    // exists so this won't double-process on retry.
    console.error(`[polar webhook] handler error (${eventType}):`, e.message);
  }

  res.status(202).send('');
});

module.exports = router;
