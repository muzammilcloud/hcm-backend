const { getPlatformDB } = require('../db');
const {
  POLAR_ENV,
  POLAR_ACCESS_TOKEN,
  PRICE_IDS,
  ADDON_PRICE_IDS,
  tierFromPriceId,
  isConfigured,
} = require('../lib/polarConstants');

// ─────────────────────────────────────────────────────────────────────────────
// Polar billing service.
//
// Thin wrapper around @polar-sh/sdk that gives the rest of the app a
// stable internal API:
//   - createCheckout(tenant, { tier, cycle, addons })
//   - getCustomerPortalUrl(tenant)
//   - getSubscription(tenant)
//   - applyWebhookEvent(event)  ← called from routes/webhooks/polar.js
//   - claimFoundingSlot(tenantId, conn)  ← transactional, used inside webhook
//
// All methods short-circuit cleanly when Polar isn't configured yet
// (POLAR_ACCESS_TOKEN unset) so the rest of the app keeps working through
// the rollout. Caller checks `isConfigured()` first if it needs to render
// a "Billing not configured" message rather than calling and catching.
// ─────────────────────────────────────────────────────────────────────────────

let _polar = null;
function getPolar() {
  if (_polar) return _polar;
  if (!isConfigured()) return null;
  // Lazy require so the package can be missing in environments that haven't
  // run npm install yet (e.g. dev branches) without crashing on import.
  const { Polar } = require('@polar-sh/sdk');
  _polar = new Polar({
    accessToken: POLAR_ACCESS_TOKEN,
    server: POLAR_ENV === 'production' ? 'production' : 'sandbox',
  });
  return _polar;
}

// Create a Polar checkout session for the given tenant. Returns the checkout
// URL the FE redirects the user to. The session carries our internal
// tenant_id + tenant_slug as metadata so the webhook can link the resulting
// subscription back without ambiguity.
async function createCheckout(tenant, { tier, cycle = 'monthly', addons = [], successUrl }) {
  const polar = getPolar();
  if (!polar) throw new Error('Billing is not configured on this server.');

  const priceId = PRICE_IDS[tier]?.[cycle];
  if (!priceId) throw new Error(`No Polar price configured for ${tier} / ${cycle}. Set the POLAR_${tier.toUpperCase()}_${cycle.toUpperCase()}_PRICE_ID env var.`);

  const products = [priceId];
  for (const addon of addons) {
    const addonPriceId = ADDON_PRICE_IDS[addon];
    if (addonPriceId) products.push(addonPriceId);
  }

  const checkout = await polar.checkouts.create({
    products,
    customerEmail: tenant.contact_email,
    successUrl,
    metadata: {
      tenant_id:   String(tenant.id),
      tenant_slug: tenant.slug,
    },
  });

  return { url: checkout.url, id: checkout.id };
}

// Return a pre-authenticated URL that drops the tenant into Polar's hosted
// customer portal. Null if billing isn't configured or the tenant doesn't
// have a Polar customer yet (first checkout hasn't happened).
async function getCustomerPortalUrl(tenant) {
  const polar = getPolar();
  if (!polar || !tenant?.polar_customer_id) return null;
  try {
    const session = await polar.customerSessions.create({
      customerId: tenant.polar_customer_id,
    });
    return session.customerPortalUrl;
  } catch (e) {
    console.error('[billing] customer portal session failed:', e.message);
    return null;
  }
}

async function getSubscription(tenant) {
  const polar = getPolar();
  if (!polar || !tenant?.polar_subscription_id) return null;
  try {
    return await polar.subscriptions.get({ id: tenant.polar_subscription_id });
  } catch (e) {
    console.error('[billing] subscription fetch failed:', e.message);
    return null;
  }
}

// Atomic founding-slot claim. Returns { claimed: bool, slotsRemaining: int }.
// Must be called inside a transaction; pass the same connection so the
// SELECT FOR UPDATE row lock is honored. If the tenant already has
// founding_customer=1 we return claimed=false without consuming a slot.
async function claimFoundingSlot(tenantId, conn) {
  if (!conn) throw new Error('claimFoundingSlot requires a transactional connection.');
  const [tenants] = await conn.execute(
    'SELECT founding_customer FROM tenants WHERE id = ? FOR UPDATE', [tenantId]
  );
  if (!tenants.length) return { claimed: false, slotsRemaining: 0 };
  if (tenants[0].founding_customer) return { claimed: false, slotsRemaining: 0 };

  const [rows] = await conn.execute(
    'SELECT used_count, max_count FROM founding_counter WHERE id = 1 FOR UPDATE'
  );
  if (!rows.length) return { claimed: false, slotsRemaining: 0 };
  const { used_count, max_count } = rows[0];
  if (used_count >= max_count) return { claimed: false, slotsRemaining: 0 };

  await conn.execute(
    'UPDATE founding_counter SET used_count = used_count + 1 WHERE id = 1'
  );
  await conn.execute(
    'UPDATE tenants SET founding_customer = 1, founding_until = DATE_ADD(NOW(), INTERVAL 12 MONTH) WHERE id = ?',
    [tenantId]
  );
  return { claimed: true, slotsRemaining: max_count - used_count - 1 };
}

// Apply a verified webhook event to platform state. Returns an idempotency
// summary that the route uses to acknowledge. Always swallows errors after
// logging them — Polar will retry and we'd rather not 5xx into the void.
async function applyWebhookEvent(event) {
  const platform = getPlatformDB();
  const type = event?.type;
  const data = event?.data;
  const polarEventId = event?.id || null;

  // Pull tenant identity from the subscription/order/customer metadata we
  // attached during checkout creation.
  const meta = data?.metadata || data?.subscription?.metadata || data?.order?.metadata || {};
  const tenantId = meta.tenant_id ? Number(meta.tenant_id) : null;

  // Always log the raw event for forensics, even if we can't apply it.
  await logBillingEvent({
    tenantId,
    type,
    polarEventId,
    payload: event,
  });

  if (!type) return { applied: false, reason: 'missing type' };

  try {
    switch (type) {
      case 'subscription.created':
      case 'subscription.updated':
      case 'subscription.active':
        await onSubscriptionUpserted(tenantId, data);
        break;
      case 'subscription.canceled':
      case 'subscription.revoked':
        await onSubscriptionCanceled(tenantId, data);
        break;
      case 'subscription.uncanceled':
        await onSubscriptionReinstated(tenantId, data);
        break;
      case 'order.created':
      case 'order.paid':
        await onOrderPaid(tenantId, data);
        break;
      case 'customer.created':
      case 'customer.updated':
        await onCustomerUpserted(tenantId, data);
        break;
      default:
        // Unknown event types are logged above; no specific handler.
        return { applied: false, reason: `unhandled type: ${type}` };
    }
  } catch (e) {
    console.error(`[billing] applyWebhookEvent(${type}) failed:`, e.message);
    return { applied: false, reason: e.message };
  }

  return { applied: true, type };
}

// ─── Internal handlers ──────────────────────────────────────────────────────

async function onSubscriptionUpserted(tenantId, sub) {
  if (!tenantId || !sub) return;
  const platform = getPlatformDB();
  const priceId = sub.priceId || sub.price?.id || sub.product?.id;
  const tierInfo = priceId ? tierFromPriceId(priceId) : null;
  const billing_cycle = tierInfo?.cycle || null;
  const plan = tierInfo?.tier || null;

  await platform.execute(
    `UPDATE tenants
     SET polar_customer_id     = COALESCE(?, polar_customer_id),
         polar_subscription_id = COALESCE(?, polar_subscription_id),
         polar_status          = ?,
         plan                  = COALESCE(?, plan),
         billing_cycle         = COALESCE(?, billing_cycle),
         status                = CASE WHEN ? IN ('active','trialing') THEN 'active' ELSE status END
     WHERE id = ?`,
    [
      sub.customerId || null,
      sub.id || null,
      sub.status || 'unknown',
      plan,
      billing_cycle,
      sub.status || 'unknown',
      tenantId,
    ]
  );

  // First-paid claim: if this is the first time we see an active sub for
  // this tenant, set first_paid_at and try to claim a founding slot.
  if (sub.status === 'active') {
    const [rows] = await platform.execute(
      'SELECT first_paid_at FROM tenants WHERE id = ?', [tenantId]
    );
    if (rows.length && !rows[0].first_paid_at) {
      const conn = await platform.getConnection();
      try {
        await conn.beginTransaction();
        await conn.execute(
          'UPDATE tenants SET first_paid_at = NOW() WHERE id = ? AND first_paid_at IS NULL',
          [tenantId]
        );
        await claimFoundingSlot(tenantId, conn);
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }
    }
  }
}

async function onSubscriptionCanceled(tenantId, sub) {
  if (!tenantId) return;
  const platform = getPlatformDB();
  await platform.execute(
    `UPDATE tenants SET polar_status = ?, status = 'suspended' WHERE id = ?`,
    [sub?.status || 'canceled', tenantId]
  );
}

async function onSubscriptionReinstated(tenantId, sub) {
  if (!tenantId) return;
  const platform = getPlatformDB();
  await platform.execute(
    `UPDATE tenants SET polar_status = ?, status = 'active' WHERE id = ?`,
    [sub?.status || 'active', tenantId]
  );
}

async function onOrderPaid(tenantId, _order) {
  // Order events are mostly informational; the subscription event drives
  // plan state. We just want the audit trail (already written by
  // logBillingEvent above).
}

async function onCustomerUpserted(tenantId, customer) {
  if (!tenantId || !customer?.id) return;
  const platform = getPlatformDB();
  await platform.execute(
    `UPDATE tenants SET polar_customer_id = ? WHERE id = ? AND polar_customer_id IS NULL`,
    [customer.id, tenantId]
  );
}

async function logBillingEvent({ tenantId, type, polarEventId, payload }) {
  try {
    const platform = getPlatformDB();
    await platform.execute(
      `INSERT INTO billing_events (tenant_id, event_type, payload, polar_event_id)
       VALUES (?, ?, ?, ?)`,
      [tenantId, type || 'unknown', payload ? JSON.stringify(payload).slice(0, 1_000_000) : null, polarEventId]
    );
  } catch (e) {
    console.error('[billing] logBillingEvent failed:', e.message);
  }
}

// Sync the tenant's active seat count to Polar and to our platform DB.
// Always updates the local seat_count column (source of truth for the soft
// cap banner). Best-effort on the Polar API call — wrapped in try/catch so
// a Polar outage never blocks an employee mutation.
//
// Callers should fire-and-forget (don't await) so the API roundtrip doesn't
// add latency to the employee-create/delete responses.
async function syncSeatCount(tenantId, seats) {
  if (!tenantId || typeof seats !== 'number') return;
  const platform = getPlatformDB();
  try {
    await platform.execute(
      'UPDATE tenants SET seat_count = ? WHERE id = ?',
      [seats, tenantId]
    );
  } catch (e) {
    console.error('[billing] local seat_count update failed:', e.message);
  }

  const polar = getPolar();
  if (!polar) return;

  const [rows] = await platform.execute(
    'SELECT polar_subscription_id, plan FROM tenants WHERE id = ?', [tenantId]
  );
  const subId = rows[0]?.polar_subscription_id;
  const plan  = rows[0]?.plan;
  if (!subId) return;

  // Per-seat sync only matters for plans where the price scales with seat
  // count (Growth, Business). Starter is flat $19/mo regardless of seats,
  // so pushing quantity updates there is pointless.
  if (plan !== 'growth' && plan !== 'business') return;

  try {
    // Polar's exact per-seat update shape varies by pricing model. The most
    // common path: update the subscription with a new quantity. If your
    // Polar product uses customer_seats instead, this no-ops cleanly and
    // the webhook (subscription.updated) will reconcile state either way.
    await polar.subscriptions.update({ id: subId, quantity: seats });
  } catch (e) {
    // Common cause: product is configured for customer-managed seats
    // (assigned by the customer themselves via the portal). In that case
    // we just rely on Polar's portal flow + the webhook reconciler.
    console.error('[billing] Polar seat sync failed (subscription stays at last-known qty):', e.message);
  }
}

module.exports = {
  createCheckout,
  getCustomerPortalUrl,
  getSubscription,
  applyWebhookEvent,
  claimFoundingSlot,
  syncSeatCount,
  isConfigured,
};
