const { getPlatformDB, getTenantDB, tenantContext } = require('../db');
const {
  POLAR_ENV,
  POLAR_ACCESS_TOKEN,
  PRICE_IDS,
  ADDON_PRICE_IDS,
  addonPriceFor,
  addonPriceIdsAll,
  addonKeyFromPriceId,
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

// ─── Subscription-shape helpers ─────────────────────────────────────────────
// Polar can return a subscription with the primary product as sub.priceId
// /sub.price.id, OR as a list of items / prices for multi-product subs (e.g.
// base plan + add-on). Defensive flatten so callers don't have to know which.
function extractPriceIds(sub) {
  if (!sub) return [];
  const out = new Set();
  if (sub.priceId) out.add(sub.priceId);
  if (sub.price?.id) out.add(sub.price.id);
  if (Array.isArray(sub.items)) {
    for (const it of sub.items) {
      if (it.priceId) out.add(it.priceId);
      if (it.price?.id) out.add(it.price.id);
      if (it.productPriceId) out.add(it.productPriceId);
    }
  }
  if (Array.isArray(sub.prices)) {
    for (const p of sub.prices) if (p?.id) out.add(p.id);
  }
  if (Array.isArray(sub.productPriceIds)) {
    for (const id of sub.productPriceIds) if (id) out.add(id);
  }
  return [...out].filter(Boolean);
}

// Read a subscription field that may arrive in SDK camelCase (validateEvent
// mapped the event) OR raw snake_case (webhook raw-JSON fallback for seat-based
// events the pinned SDK can't map). Prefer camelCase, fall back to snake_case.
function subField(sub, camel, snake) {
  if (sub == null) return undefined;
  return sub[camel] !== undefined ? sub[camel] : sub[snake];
}

function subscriptionHasAddon(sub, addonKey) {
  const targets = addonPriceIdsAll(addonKey); // both monthly + annual ids
  if (!targets.length) return false;
  const ids = extractPriceIds(sub);
  return targets.some((t) => ids.includes(t));
}

// Resolve a tenant by id without going through tenant middleware. Used by
// the webhook handler (no req context) to figure out which DB to switch to.
async function loadTenantById(tenantId) {
  const platform = getPlatformDB();
  const [rows] = await platform.execute(
    `SELECT id, slug, db_name, company_name, contact_email,
            polar_customer_id, polar_subscription_id
     FROM tenants WHERE id = ? LIMIT 1`, [tenantId]
  );
  return rows[0] || null;
}

// NOTE: the @polar-sh/sdk *API client* is intentionally NOT used. Its pinned
// version (0.34) does strict response validation that throws on the seat_based
// pricing fields Polar returns for Growth/Business — the bug that broke both
// checkout and plan changes. Every Polar call in this file goes through the
// REST helper polarApi() below instead, so there is no SDK code path that can
// hit that validation. (Webhook signature verification uses the separate,
// safe @polar-sh/sdk/webhooks sub-module in routes/webhooks/polar.js.)

// Direct Polar REST calls. We bypass the SDK for subscription reads + mutations
// because the pinned SDK (0.34) does strict response validation that throws on
// seat_based pricing fields (the same bug that broke checkout). REST returns
// plain JSON we parse ourselves. Field names follow the CURRENT Polar API:
//   change plan  → PATCH /v1/subscriptions/{id} { product_id }
//   change seats → PATCH /v1/subscriptions/{id} { seats }
//   auto-renew   → PATCH /v1/subscriptions/{id} { cancel_at_period_end }
// (The old SDK shapes — productPriceIds / quantity / cancelAtPeriodEnd — are
// obsolete and rejected by the live API.)
const polarApiHost = () => (POLAR_ENV === 'production' ? 'https://api.polar.sh' : 'https://sandbox-api.polar.sh');
async function polarApi(method, path, body) {
  // Hard timeout so a stuck Polar request can never hang the whole HTTP handler
  // (which surfaced to the client as a Cloudflare 502 Bad Gateway).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(polarApiHost() + path, {
      method,
      headers: { Authorization: `Bearer ${POLAR_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw Object.assign(new Error(`Polar ${method} ${path} → HTTP ${resp.status}`), { body: data, status: resp.status });
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Polar ${method} ${path} timed out after 15s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Create a Polar checkout session for the given tenant. Returns the checkout
// URL the FE redirects the user to. The session carries our internal
// tenant_id + tenant_slug as metadata so the webhook can link the resulting
// subscription back without ambiguity.
async function createCheckout(tenant, { tier, cycle = 'monthly', addons = [], successUrl }) {
  if (!isConfigured()) throw new Error('Billing is not configured on this server.');

  const priceId = PRICE_IDS[tier]?.[cycle];
  if (!priceId) throw new Error(`No Polar price configured for ${tier} / ${cycle}. Set the POLAR_${tier.toUpperCase()}_${cycle.toUpperCase()}_PRICE_ID env var.`);

  const products = [priceId];
  for (const addon of addons) {
    // Match the add-on's billing cycle to the base so an annual plan + add-on
    // is one consolidated yearly bill.
    const addonPriceId = addonPriceFor(addon, cycle);
    if (addonPriceId) products.push(addonPriceId);
  }

  // Build the checkout request in the REST API's snake_case shape and POST it
  // directly, instead of polar.checkouts.create(). The pinned SDK (0.34.x) throws
  // a *response*-validation error on seat_based price products (Growth/Business):
  // it can't parse the seat fields Polar returns, so a perfectly valid checkout
  // surfaced as "Response validation failed" — which the archived-detection below
  // then mislabelled as an archived product. The raw REST response parses cleanly
  // for both fixed and seat_based products (verified against sandbox). Fixed-price
  // tiers (Starter) happened to work through the SDK, which is why only Growth/
  // Business broke. A full SDK upgrade would also fix change-plan; see note there.
  const restBody = {
    products,
    metadata: { tenant_id: String(tenant.id), tenant_slug: tenant.slug },
  };
  if (tenant.contact_email) restBody.customer_email = tenant.contact_email;
  if (successUrl)           restBody.success_url    = successUrl;

  // NOTE: do not set `seats` here. Every tier is a SEAT-BASED product in Polar
  // ($2/$3/$6 per seat), and a seat-based checkout defaults to 1 seat; right
  // after purchase syncSeatCount() pushes the real team size to Polar (and again
  // on every employee add/remove), so there's nothing to floor at checkout.
  // (Sending `seats` on a fixed-price product would 422 — so even if a tier were
  // ever configured fixed-price, omitting it here keeps checkout working.)

  const apiHost = POLAR_ENV === 'production' ? 'https://api.polar.sh' : 'https://sandbox-api.polar.sh';
  let checkout;
  try {
    const resp = await fetch(`${apiHost}/v1/checkouts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${POLAR_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(restBody),
    });
    checkout = await resp.json().catch(() => ({}));
    if (!resp.ok) throw Object.assign(new Error(`Polar checkout failed (HTTP ${resp.status})`), { body: checkout });
  } catch (e) {
    // Surface the real cause. A genuinely archived/inactive product is the one
    // case worth calling out by name so the env var can be repointed.
    const detail = JSON.stringify(e?.body ?? e?.detail ?? e?.message ?? e);
    if (/archived/i.test(detail)) {
      console.error('[billing] Polar checkout blocked — a configured product is ARCHIVED.',
        JSON.stringify({ tier, cycle, productsTried: products, polar: detail }));
      throw Object.assign(
        new Error(`Polar checkout product is archived. Un-archive it in Polar, or point POLAR_${tier.toUpperCase()}_${cycle.toUpperCase()}_PRICE_ID at an active product. Tried: ${products.join(', ')}`),
        { code: 'POLAR_PRODUCT_ARCHIVED' }
      );
    }
    console.error('[billing] Polar checkout failed:', detail);
    throw e;
  }

  return { url: checkout.url, id: checkout.id };
}

// Return a pre-authenticated URL that drops the tenant into Polar's hosted
// customer portal. Null if billing isn't configured or the tenant doesn't
// have a Polar customer yet (first checkout hasn't happened).
async function getCustomerPortalUrl(tenant) {
  // null = genuinely no Polar customer on file (caller shows "start a plan").
  if (!isConfigured() || !tenant?.polar_customer_id) return null;
  // Team/business customers (created when "I'm purchasing as a business" is
  // chosen at checkout) require a member_id for the portal session — customer_id
  // alone errors "member_id is required for team customers." Individual
  // customers have no members, so this stays unset. Prefer the member whose
  // email matches the workspace contact (the owner), else the first member.
  const body = { customer_id: tenant.polar_customer_id };
  try {
    const members = await polarApi('GET',
      `/v1/members/?customer_id=${encodeURIComponent(tenant.polar_customer_id)}&limit=20`);
    const list = members.items || [];
    const owner = list.find(m => (m.email || '').toLowerCase() === (tenant.contact_email || '').toLowerCase());
    const memberId = (owner || list[0])?.id;
    if (memberId) body.member_id = memberId;
  } catch (_) { /* not a team customer / members not listable — proceed without */ }

  // Let session-creation errors propagate so the route can surface the real
  // cause. Trailing slash matters: POST /v1/customer-sessions (no slash)
  // redirects and the redirected POST hangs; the SDK targets the slashed path.
  const session = await polarApi('POST', '/v1/customer-sessions/', body);
  return session.customer_portal_url || session.customerPortalUrl || null;
}

async function getSubscription(tenant) {
  if (!isConfigured() || !tenant?.polar_subscription_id) return null;
  try {
    return await polarApi('GET', `/v1/subscriptions/${tenant.polar_subscription_id}`);
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
        // The user toggled "cancel at period end" — they still have access
        // until current_period_end. Don't suspend; just mirror the state.
        await onSubscriptionCanceledAtPeriodEnd(tenantId, data);
        break;
      case 'subscription.revoked':
        // Access has actually ended (period over, or immediate revoke).
        await onSubscriptionRevoked(tenantId, data);
        break;
      case 'subscription.uncanceled':
        // User re-enabled auto-renewal before period ended.
        await onSubscriptionReinstated(tenantId, data);
        break;
      case 'subscription.past_due':
        await onSubscriptionPastDue(tenantId, data);
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

// Add or remove an add-on key in the platform tenants.addons JSON column,
// idempotently. Drives Desktop access (gated on tenants.addons elsewhere).
async function setTenantAddon(tenantId, addonKey, present) {
  const platform = getPlatformDB();
  const [rows] = await platform.execute('SELECT addons FROM tenants WHERE id = ? LIMIT 1', [tenantId]);
  let addons = [];
  const raw = rows[0]?.addons;
  if (Array.isArray(raw)) addons = raw;
  else if (typeof raw === 'string') { try { addons = JSON.parse(raw) || []; } catch { addons = []; } }
  const has = addons.includes(addonKey);
  if (present && !has) addons.push(addonKey);
  else if (!present && has) addons = addons.filter(a => a !== addonKey);
  else return; // no change
  await platform.execute('UPDATE tenants SET addons = ? WHERE id = ?', [JSON.stringify(addons), tenantId]);
}

async function onSubscriptionUpserted(tenantId, sub) {
  if (!tenantId || !sub) return;
  const platform = getPlatformDB();

  // If this subscription is for an ADD-ON product (e.g. Desktop), it's a
  // separate subscription that lives alongside the base plan — record it in
  // tenants.addons by its status and do NOT touch the base plan / sub id.
  const subProductId = sub.product?.id || sub.product_id || null;
  const addonKey = (subProductId && addonKeyFromPriceId(subProductId))
    || extractPriceIds(sub).map(addonKeyFromPriceId).find(Boolean)
    || null;
  if (addonKey) {
    const active = (sub.status === 'active' || sub.status === 'trialing');
    return setTenantAddon(tenantId, addonKey, active);
  }

  // Resolve the tier/cycle from whatever id the subscription exposes. Our env
  // PRICE_IDS hold PRODUCT ids, so the subscription's product id is the primary
  // match; fall back to any other price/product id present. Works for both SDK
  // camelCase and raw REST snake_case shapes.
  const idCandidates = [
    sub.product?.id, sub.product_id, sub.priceId, sub.price?.id,
    ...extractPriceIds(sub),
  ].filter(Boolean);
  let tierInfo = null;
  for (const cand of idCandidates) {
    tierInfo = tierFromPriceId(cand);
    if (tierInfo) break;
  }
  if (!tierInfo) {
    console.warn('[billing] onSubscriptionUpserted: could not map subscription to a tier.',
      JSON.stringify({ tenantId, idCandidates }));
  }
  const billing_cycle = tierInfo?.cycle || null;
  const plan = tierInfo?.tier || null;

  // current_period_end + cancel_at_period_end mirrored so the FE can render
  // "cancels on X" / "renews on X" without a Polar API round-trip. Read both
  // SDK camelCase and raw snake_case (see subField / webhook raw-JSON fallback).
  const cpe = subField(sub, 'currentPeriodEnd', 'current_period_end');
  const currentPeriodEnd = cpe ? new Date(cpe) : null;
  const cancelAtPeriodEnd = subField(sub, 'cancelAtPeriodEnd', 'cancel_at_period_end') ? 1 : 0;

  // When a subscription returns to active, clear any past-due bookkeeping
  // so future dunning runs don't re-fire on stale state.
  const clearDunning = (sub.status === 'active' || sub.status === 'trialing');

  await platform.execute(
    `UPDATE tenants
     SET polar_customer_id     = COALESCE(?, polar_customer_id),
         polar_subscription_id = COALESCE(?, polar_subscription_id),
         polar_status          = ?,
         plan                  = COALESCE(?, plan),
         billing_cycle         = COALESCE(?, billing_cycle),
         current_period_end    = ?,
         cancel_at_period_end  = ?,
         past_due_at           = CASE WHEN ? THEN NULL ELSE past_due_at END,
         dunning_emails_sent   = CASE WHEN ? THEN NULL ELSE dunning_emails_sent END,
         status                = CASE WHEN ? IN ('active','trialing') THEN 'active' ELSE status END
     WHERE id = ?`,
    [
      subField(sub, 'customerId', 'customer_id') || sub.customer?.id || null,
      sub.id || null,
      sub.status || 'unknown',
      plan,
      billing_cycle,
      currentPeriodEnd,
      cancelAtPeriodEnd,
      clearDunning ? 1 : 0,
      clearDunning ? 1 : 0,
      sub.status || 'unknown',
      tenantId,
    ]
  );

  // First-paid claim: if this is the first time we see an active sub for
  // this tenant, set first_paid_at. We attempt the founding-slot claim ONLY
  // if the subscription includes the desktop add-on — the founding rate
  // applies to the desktop add-on price specifically, not to base plans.
  // Without this constraint, a tenant subscribing to plain Growth would
  // consume a slot they can't benefit from, locking out a later founding-
  // eligible customer.
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
        if (subscriptionHasAddon(sub, 'desktop_standard')) {
          await claimFoundingSlot(tenantId, conn);
        }
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }
    } else if (rows.length && rows[0].first_paid_at && subscriptionHasAddon(sub, 'desktop_standard')) {
      // Add-on was added LATER (after first paid) via subscription.updated.
      // Still attempt the slot claim — they might have been first-paid as
      // a base-plan-only customer and only now qualify.
      // (continued below)
      const conn = await platform.getConnection();
      try {
        await conn.beginTransaction();
        await claimFoundingSlot(tenantId, conn);
        await conn.commit();
      } catch (e) {
        await conn.rollback();
      } finally {
        conn.release();
      }
    }
  }

  // Backend-enforced 10-seat minimum on per-seat tiers. Polar doesn't
  // expose a minimum-quantity field in its product config, so we guard
  // every subscription state change. If the new quantity is below the
  // floor for a per-seat tier (Growth, Business), push back to the
  // floor and update our local seat_count to match.
  await enforceSeatMinimum(tenantId);
}

// subscription.canceled = user toggled cancel-at-period-end. Access STAYS
// until current_period_end; only mirror state, don't suspend.
async function onSubscriptionCanceledAtPeriodEnd(tenantId, sub) {
  if (!tenantId) return;
  const platform = getPlatformDB();
  const cpe = subField(sub, 'currentPeriodEnd', 'current_period_end');
  const periodEnd = cpe ? new Date(cpe) : null;
  await platform.execute(
    `UPDATE tenants
     SET polar_status         = ?,
         cancel_at_period_end = 1,
         current_period_end   = COALESCE(?, current_period_end)
     WHERE id = ?`,
    [sub?.status || 'canceled', periodEnd, tenantId]
  );
}

// subscription.revoked = access has actually ended (period over OR immediate
// revoke). This is when we lock the tenant out of the dashboard.
async function onSubscriptionRevoked(tenantId, sub) {
  if (!tenantId) return;
  const platform = getPlatformDB();
  await platform.execute(
    `UPDATE tenants SET polar_status = ?, status = 'suspended' WHERE id = ?`,
    [sub?.status || 'revoked', tenantId]
  );
}

async function onSubscriptionReinstated(tenantId, sub) {
  if (!tenantId) return;
  const platform = getPlatformDB();
  await platform.execute(
    `UPDATE tenants
     SET polar_status         = ?,
         cancel_at_period_end = 0,
         status               = 'active'
     WHERE id = ?`,
    [sub?.status || 'active', tenantId]
  );
  // Re-check the per-seat floor on resume. If the user reduced their team
  // while cancelled and then comes back, quantity could be below 10.
  await enforceSeatMinimum(tenantId);
}

// subscription.past_due = a renewal payment failed. Tenant enters the
// 7-day grace period. We set past_due_at NOW(), fire the day-0 dunning
// email immediately, and let the nightly scheduler handle day-2 / day-5
// reminders + day-8 suspension.
async function onSubscriptionPastDue(tenantId, sub) {
  if (!tenantId) return;
  const platform = getPlatformDB();
  await platform.execute(
    `UPDATE tenants
     SET polar_status = ?,
         past_due_at  = COALESCE(past_due_at, NOW()),
         dunning_emails_sent = COALESCE(dunning_emails_sent, JSON_ARRAY())
     WHERE id = ?`,
    [sub?.status || 'past_due', tenantId]
  );

  // Send the day-0 dunning email immediately (don't wait for the scheduler).
  // We mark day 0 as sent only after the email succeeds.
  try {
    const [rows] = await platform.execute(
      `SELECT contact_email, company_name, dunning_emails_sent
       FROM tenants WHERE id = ?`, [tenantId]
    );
    const t = rows[0];
    const already = Array.isArray(t?.dunning_emails_sent) ? t.dunning_emails_sent : [];
    if (t && !already.includes(0)) {
      const { sendDunningEmail } = require('./email');
      const portalUrl = await getCustomerPortalUrl({
        polar_customer_id: subField(sub, 'customerId', 'customer_id') || sub?.customer?.id,
      });
      const sent = await sendDunningEmail({
        to: t.contact_email,
        companyName: t.company_name,
        daysSinceFailure: 0,
        billingUrl: portalUrl || `https://${(process.env.APEX_DOMAIN || 'tickin.pro')}/`,
      });
      if (sent) {
        await platform.execute(
          `UPDATE tenants SET dunning_emails_sent = JSON_ARRAY_APPEND(
             COALESCE(dunning_emails_sent, JSON_ARRAY()), '$', 0
           ) WHERE id = ?`, [tenantId]
        );
      }

      // Also fire a Slack DM to the same contact_email user if their
      // workspace has Slack configured. Best-effort — never block the email
      // path.
      await sendPaymentFailedSlackDM(tenantId, t).catch(e =>
        console.error('[billing] payment-failed Slack DM failed:', e.message)
      );
    }
  } catch (e) {
    console.error('[billing] day-0 dunning email failed:', e.message);
  }
}

// Wrap a Slack chat.postMessage to the contact_email user. Runs inside the
// tenant's AsyncLocalStorage context so getSlackCreds() reads the tenant's
// own Slack bot token (or env fallback). Skips silently if the tenant
// hasn't connected Slack or if the contact's email doesn't map to a Slack
// user in the workspace.
async function sendPaymentFailedSlackDM(tenantId, tenantRow) {
  const tenant = await loadTenantById(tenantId);
  if (!tenant?.db_name || !tenantRow?.contact_email) return;

  const portalUrl = await getCustomerPortalUrl({ polar_customer_id: tenant.polar_customer_id });
  const billingUrl = portalUrl || `https://${tenant.slug}.${process.env.APEX_DOMAIN || 'tickin.pro'}/?tab=billing`;

  await tenantContext.run(
    { dbName: tenant.db_name, slug: tenant.slug, tenantId: tenant.id },
    async () => {
      try {
        const { getSlackUserIdByEmail, sendSlackDM } = require('./slack');
        const userId = await getSlackUserIdByEmail(tenantRow.contact_email);
        if (!userId) {
          console.log(`[billing] no Slack user for ${tenantRow.contact_email}, skipping DM`);
          return;
        }
        const text = `Heads up — the last payment for ${tenantRow.company_name || 'your Tickin workspace'} didn't go through. Update your payment method to keep things running.`;
        const blocks = [
          { type: 'header', text: { type: 'plain_text', text: '⚠ Payment failed — your Tickin workspace' } },
          { type: 'section', text: { type: 'mrkdwn', text: `We tried to charge the card on file for *${tenantRow.company_name || 'your workspace'}* and it failed. Update your payment method to avoid a workspace pause in 8 days.` } },
          { type: 'actions', elements: [{
            type: 'button',
            style: 'primary',
            text: { type: 'plain_text', text: 'Update payment method' },
            url: billingUrl,
          }] },
          { type: 'context', elements: [{ type: 'mrkdwn', text: 'Your data is safe; only access pauses until billing is current.' }] },
        ];
        await sendSlackDM(userId, text, blocks);
        console.log(`[billing] payment-failed Slack DM sent to ${tenantRow.contact_email}`);
      } catch (e) {
        // Common causes: tenant has no Slack integration configured, or the
        // contact_email user isn't in their Slack workspace.
        console.error('[billing] sendPaymentFailedSlackDM inner:', e.message);
      }
    }
  );
}

// Change the base plan (Starter ↔ Growth) on an existing subscription.
// Keeps existing add-ons attached. Polar prorates the difference between
// the old and new product for the remainder of the current period.
async function changePlan(tenant, { tier, cycle = 'monthly' }) {
  if (!isConfigured()) throw new Error('Billing is not configured on this server.');
  if (!tenant?.polar_subscription_id) {
    throw new Error('No active subscription to change.');
  }
  if (!['starter', 'growth'].includes(tier)) {
    throw new Error('Self-serve plan changes are only between Starter and Growth. Business plans need a sales conversation.');
  }
  if (!['monthly', 'annual'].includes(cycle)) {
    throw new Error('cycle must be monthly | annual.');
  }
  const newProductId = PRICE_IDS[tier]?.[cycle];
  if (!newProductId) {
    throw new Error(`Polar product not configured for ${tier}/${cycle}.`);
  }

  // Current Polar API: switch the subscription to a different product with a
  // single product_id (the old multi-line productPriceIds model is gone, so
  // there's no per-price merge to do here). Polar prorates the difference for
  // the rest of the period and fires subscription.updated, which our webhook
  // mirrors into the tenants row. Seat count is reconciled separately by
  // syncSeatCount / enforceSeatMinimum, so we don't push seats here.
  // NOTE: add-ons in the new single-product model are handled via their own
  // checkout/subscription, not as extra lines on the base subscription.
  await polarApi('PATCH', `/v1/subscriptions/${tenant.polar_subscription_id}`, { product_id: newProductId });

  // Mirror the new tier/cycle locally so the UI updates immediately. Polar will
  // also fire subscription.updated; reconcile/the webhook keep us authoritative.
  try {
    await getPlatformDB().execute(
      'UPDATE tenants SET plan = ?, billing_cycle = ? WHERE id = ?',
      [tier, cycle, tenant.id]
    );
  } catch (e) { console.error('[billing] local plan mirror failed:', e.message); }

  return { tier, cycle, pending_sync: true };
}

// Pull the tenant's CURRENT active subscription straight from Polar and apply it
// to our DB — a manual reconcile for when a webhook was missed (e.g. the Polar
// webhook endpoint wasn't registered yet, so subscription.created/active never
// arrived and the tenant is stuck on `demo` while Polar already has an active
// subscription). Uses the server's own POLAR_ACCESS_TOKEN — no customer token
// needed. Safe to call repeatedly: it runs the same idempotent upsert the
// webhook uses.
async function reconcileSubscription(tenant) {
  if (!isConfigured()) throw new Error('Billing is not configured on this server.');
  if (!tenant?.id) throw new Error('tenant required');

  // 1) Resolve the Polar customer id: stored, else from a subscription found by
  //    our tenant_id checkout metadata, else by contact email.
  let customerId = tenant.polar_customer_id || null;
  let seedSub = null;
  if (!customerId) {
    try {
      const byMeta = await polarApi('GET',
        `/v1/subscriptions?metadata[tenant_id]=${encodeURIComponent(String(tenant.id))}&active=true&limit=1`);
      seedSub = byMeta.items?.[0] || null;
      customerId = seedSub?.customer_id || seedSub?.customer?.id || null;
    } catch (_) {}
  }
  if (!customerId && tenant.contact_email) {
    try {
      const cust = await polarApi('GET',
        `/v1/customers?email=${encodeURIComponent(tenant.contact_email)}&limit=1`);
      customerId = cust.items?.[0]?.id || null;
    } catch (_) {}
  }
  if (!customerId) {
    return { reconciled: false, reason: 'No Polar customer found for this tenant.' };
  }

  // 2) List ALL active subscriptions for the customer — there can be a base
  //    plan AND separate add-on subscriptions (Polar's single-product model).
  let subs = [];
  try {
    const resp = await polarApi('GET',
      `/v1/subscriptions?customer_id=${encodeURIComponent(customerId)}&active=true&limit=50`);
    subs = resp.items || [];
  } catch (_) {}
  if (!subs.length && seedSub) subs = [seedSub];
  if (!subs.length) {
    return { reconciled: false, reason: 'No active subscription found in Polar for this tenant.' };
  }

  // 3) Apply each via the same idempotent path the webhook uses. The list rows
  //    can be abbreviated, so fetch the full subscription. onSubscriptionUpserted
  //    routes base products to the plan and add-on products to tenants.addons.
  let baseId = null, baseProduct = null, baseStatus = null;
  for (const s of subs) {
    let full = s;
    if (s.id) {
      try { const f = await polarApi('GET', `/v1/subscriptions/${s.id}`); if (f?.id) full = f; } catch (_) {}
    }
    full.customer_id = full.customer_id || full.customer?.id || customerId;
    await onSubscriptionUpserted(tenant.id, full);
    const pid = full.product?.id || full.product_id || null;
    if (pid && tierFromPriceId(pid)) { baseId = full.id; baseProduct = pid; baseStatus = full.status; }
  }

  return {
    reconciled: true,
    subscription_id: baseId,
    status: baseStatus,
    product_id: baseProduct,
    customer_id: customerId,
    subscriptions: subs.length,
  };
}

// Background safety net: periodically re-sync every tenant that already has a
// Polar customer/subscription, so cancellations / plan changes / payment-status
// changes stay reflected even if a webhook delivery is missed. Scales with the
// number of PAYING tenants, not all tenants (trials are reconciled lazily on
// billing-page load instead). Called from the scheduler.
async function reconcileActiveSubscriptions() {
  if (!isConfigured()) return { checked: 0, reconciled: 0 };
  const platform = getPlatformDB();
  const [tenants] = await platform.execute(
    `SELECT id, slug, contact_email, polar_customer_id, polar_subscription_id, plan
       FROM tenants
      WHERE status = 'active'
        AND (polar_customer_id IS NOT NULL OR polar_subscription_id IS NOT NULL)`
  );
  let reconciled = 0;
  for (const t of tenants) {
    try { const r = await reconcileSubscription(t); if (r?.reconciled) reconciled++; }
    catch (e) { console.error('[billing] periodic reconcile failed:', t.slug, e.message); }
  }
  if (tenants.length) console.log(`[billing] periodic reconcile: ${reconciled}/${tenants.length} tenant(s) synced`);
  return { checked: tenants.length, reconciled };
}

// Locally compute a prorated preview for a plan change OR add-on toggle.
// Doesn't hit Polar — uses the cached subscription state from our DB
// plus the desired new shape to estimate the delta. Polar does the
// authoritative math at the moment of update; this is for the
// "are you sure?" panel.
function previewChange(tenant, { tier, cycle, addons = [], seats }) {
  const TIER_MONTHLY = { starter: 2, growth: 3, business: 6 };
  const ADDON_MONTHLY = { desktop_standard: 3 };
  const ANNUAL_FACTOR = 0.8;
  const GROWTH_BUSINESS_MIN_SEATS = 1; // no seat minimum — bill actual team size

  const currentTier  = tenant?.plan || 'starter';
  const currentCycle = tenant?.billing_cycle || 'monthly';
  const currentSeats = Number(tenant?.seat_count) || Number(seats) || 1;
  const currentAddons = Array.isArray(tenant?.addons) ? tenant.addons : [];

  const isPerSeat = (t) => t === 'starter' || t === 'growth' || t === 'business';
  // No seat minimum — every per-seat tier bills for the actual team size.
  const billedSeats = (t, count) => isPerSeat(t) ? Math.max(GROWTH_BUSINESS_MIN_SEATS, count) : count;
  const tierMonthlyTotal = (t, count) => {
    const per = TIER_MONTHLY[t] || 0;
    return isPerSeat(t) ? per * billedSeats(t, count) : per;
  };
  // Add-ons bill for actual employees, not the minimum-bill seat count
  // (so a 4-employee Growth tenant with Desktop on pays 4 × $3 = $12, not
  // 10 × $3 = $30 for desktop licenses they're not using).
  const addonMonthlyTotal = (list, count) =>
    list.reduce((sum, a) => sum + (ADDON_MONTHLY[a] || 0) * count, 0);

  const newSeats = Number(seats) || currentSeats;

  // Annual discount applies to the base plan ONLY. Add-ons (Desktop) are
  // always billed at face value — $3/seat/month regardless of cycle. That
  // matches the Polar catalog where the Desktop product is a separate
  // monthly price, not discounted as part of the annual plan.
  const currentTierFactor = currentCycle === 'annual' ? ANNUAL_FACTOR : 1;
  const newTierFactor     = (cycle || currentCycle) === 'annual' ? ANNUAL_FACTOR : 1;

  const currentTierMonthly = tierMonthlyTotal(currentTier, currentSeats) * currentTierFactor;
  const currentAddonMonthly = addonMonthlyTotal(currentAddons, currentSeats); // no factor
  const currentMonthly = currentTierMonthly + currentAddonMonthly;

  const newTierMonthly = tierMonthlyTotal(tier || currentTier, newSeats) * newTierFactor;
  const newAddonMonthly = addonMonthlyTotal(addons, newSeats); // no factor
  const newMonthly = newTierMonthly + newAddonMonthly;

  // Prorate: how many days remain in the current billing cycle?
  const now      = new Date();
  const periodEnd = tenant?.current_period_end ? new Date(tenant.current_period_end) : null;
  const daysRemaining = periodEnd
    ? Math.max(0, Math.ceil((periodEnd - now) / 86_400_000))
    : 30;

  // Per-day rate for the remainder of the current period
  const currentDailyRate = currentMonthly / 30;
  const newDailyRate     = newMonthly / 30;
  const proratedDelta    = (newDailyRate - currentDailyRate) * daysRemaining;

  const nextRenewalTotal = (cycle === 'annual' || (!cycle && currentCycle === 'annual'))
    ? (newTierMonthly * 12) + (newAddonMonthly * 12) // tier billed once a year; addon still monthly
    : newMonthly;

  return {
    current: {
      tier:    currentTier,
      cycle:   currentCycle,
      seats:   currentSeats,
      addons:  currentAddons,
      monthly: Math.round(currentMonthly * 100) / 100,
    },
    next: {
      tier:    tier || currentTier,
      cycle:   cycle || currentCycle,
      seats:   newSeats,
      addons,
      monthly: Math.round(newMonthly * 100) / 100,
    },
    prorate: {
      days_remaining: daysRemaining,
      delta_now:      Math.round(proratedDelta * 100) / 100,
    },
    next_renewal: {
      date:   periodEnd ? periodEnd.toISOString() : null,
      total:  Math.round(nextRenewalTotal * 100) / 100,
    },
  };
}

// Add or remove an add-on on the tenant's existing Polar subscription.
// Polar will prorate the charge for the rest of the current period and
// fire subscription.updated which our webhook handler will mirror back
// into tenants.addons.
//
// NOTE: Polar's exact API shape for "modify the price list of an existing
// subscription" varies. The most common pattern is to send the desired
// final productPriceIds list to subscriptions.update. If your Polar product
// is configured for customer-managed seats / requires checkout for add-ons,
// this call may reject — in that case fall back to creating a fresh
// checkout for just the add-on price (Polar combines onto the existing sub).
// In Polar's current model a subscription holds a SINGLE product, so the Desktop
// add-on is sold as its OWN subscription alongside the base plan:
//   enable  → open a checkout for the add-on product (returns a URL the FE opens);
//             on payment a new add-on subscription is created and recorded in
//             tenants.addons by the webhook / reconcile.
//   disable → cancel the existing add-on subscription at period end.
async function setAddon(tenant, addonKey, enabled, { successUrl } = {}) {
  if (!isConfigured()) throw new Error('Billing is not configured on this server.');
  if (!tenant?.polar_customer_id && !tenant?.contact_email) {
    throw new Error('No billing customer on file yet — start a plan first.');
  }
  const cycle = tenant?.billing_cycle === 'annual' ? 'annual' : 'monthly';
  const addonProductId = addonPriceFor(addonKey, cycle);
  if (!addonProductId) {
    throw new Error(`Unknown or unconfigured add-on: ${addonKey} (${cycle}).`);
  }
  const allAddonIds = addonPriceIdsAll(addonKey);

  // Look at the customer's active subscriptions to see what's already there.
  let subs = [];
  if (tenant.polar_customer_id) {
    try {
      const resp = await polarApi('GET',
        `/v1/subscriptions?customer_id=${encodeURIComponent(tenant.polar_customer_id)}&active=true&limit=50`);
      subs = resp.items || [];
    } catch (_) {}
  }
  const addonSub = subs.find(s => allAddonIds.includes(s.product_id || s.product?.id)) || null;
  const baseSub  = subs.find(s => tierFromPriceId(s.product_id || s.product?.id)) || null;

  if (enabled) {
    if (addonSub) return { addon: addonKey, enabled: true, no_change: true };
    // Verified by live testing: Polar bills ONE active subscription per customer
    // ("You already have an active subscription" on a 2nd checkout). So the
    // Desktop add-on cannot be a separate subscription alongside the base plan —
    // it has to be a bundled "plan + Desktop" product that the subscription
    // switches to (via the existing change-plan flow). Those bundle products
    // aren't set up yet, so report that honestly instead of opening a checkout
    // Polar will reject.
    if (baseSub) {
      throw Object.assign(
        new Error('The Desktop add-on can’t be attached to an active subscription: Polar bills one subscription per customer, so it needs a bundled "plan + Desktop" product (set up in Polar) that the plan switches to. It isn’t configured yet — contact support to enable it.'),
        { code: 'ADDON_NEEDS_BUNDLE' }
      );
    }
    // No base subscription (edge case) → a standalone add-on checkout is valid.
    const checkoutBody = {
      products: [addonProductId],
      metadata: { tenant_id: String(tenant.id), tenant_slug: tenant.slug, addon: addonKey },
    };
    if (tenant.contact_email) checkoutBody.customer_email = tenant.contact_email;
    if (successUrl)           checkoutBody.success_url    = successUrl;
    const checkout = await polarApi('POST', '/v1/checkouts/', checkoutBody);
    return { addon: addonKey, enabled: true, checkout_url: checkout.url };
  }

  // Disable → cancel the add-on subscription at period end (if it exists).
  if (!addonSub) return { addon: addonKey, enabled: false, no_change: true };
  await polarApi('PATCH', `/v1/subscriptions/${addonSub.id}`, { cancel_at_period_end: true });
  return { addon: addonKey, enabled: false, pending_cancel: true };
}

// Auto-renewal toggle: turn off (= cancel at period end) or back on
// (= uncancel). Both push to Polar and the resulting webhook syncs our DB.
async function setAutoRenew(tenant, autoRenew) {
  if (!isConfigured()) throw new Error('Billing is not configured on this server.');
  if (!tenant?.polar_subscription_id) {
    throw new Error('No active subscription to update.');
  }
  // autoRenew on  → cancel_at_period_end: false (uncancel)
  // autoRenew off → cancel_at_period_end: true  (cancel at period end)
  const result = await polarApi('PATCH', `/v1/subscriptions/${tenant.polar_subscription_id}`, {
    cancel_at_period_end: !autoRenew,
  });
  // Mirror locally right away so the UI reflects the change without waiting on
  // the subscription.updated webhook (which may be delayed or not configured).
  try {
    await getPlatformDB().execute(
      'UPDATE tenants SET cancel_at_period_end = ? WHERE id = ?',
      [autoRenew ? 0 : 1, tenant.id]
    );
  } catch (e) { console.error('[billing] local auto-renew mirror failed:', e.message); }
  return result;
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

  // Mirror billing-relevant events into the tenant's audit_logs table so the
  // sys-admin sees them in the existing Workspace → Audit log viewer
  // alongside their own actions. The platform-level billing_events table
  // remains the source of truth for the raw event payload.
  if (!tenantId || !type) return;
  if (!type.startsWith('subscription.') && !type.startsWith('order.')) return;

  try {
    const tenant = await loadTenantById(tenantId);
    if (!tenant?.db_name) return;
    const pool = getTenantDB(tenant.db_name);

    // Map Polar event type → readable action label for the audit row.
    const ACTION_MAP = {
      'subscription.created':    'billing.subscription.created',
      'subscription.active':     'billing.subscription.active',
      'subscription.updated':    'billing.subscription.updated',
      'subscription.canceled':   'billing.auto_renewal.disabled',
      'subscription.uncanceled': 'billing.auto_renewal.enabled',
      'subscription.revoked':    'billing.subscription.revoked',
      'subscription.past_due':   'billing.payment.failed',
      'order.created':           'billing.order.created',
      'order.paid':              'billing.payment.succeeded',
      'order.refunded':          'billing.order.refunded',
    };
    const action = ACTION_MAP[type] || `billing.${type}`;

    // Build a compact after-snapshot (drop the huge raw payload).
    const sub = payload?.data || {};
    const snapshot = {
      status:               sub.status || null,
      price_id:             sub.priceId || sub.price?.id || sub.product?.id || null,
      current_period_end:   subField(sub, 'currentPeriodEnd', 'current_period_end') || null,
      cancel_at_period_end: subField(sub, 'cancelAtPeriodEnd', 'cancel_at_period_end') || false,
      customer_id:          subField(sub, 'customerId', 'customer_id') || sub.customer?.id || null,
      subscription_id:      sub.id || null,
    };

    await pool.execute(
      `INSERT INTO audit_logs
         (actor_user_id, actor_email, actor_role, action,
          target_type, target_id, before_json, after_json, ip, user_agent)
       VALUES (?, ?, 'system', ?, 'subscription', ?, NULL, ?, NULL, ?)`,
      [
        null,                              // no human actor for webhooks
        'polar-webhook',
        action,
        sub.id || null,
        JSON.stringify(snapshot),
        polarEventId ? `polar:${polarEventId}` : null,
      ]
    );
  } catch (e) {
    console.error('[billing] mirror to tenant audit_logs failed:', e.message);
  }
}

// Per-seat tiers bill for the actual team size — no minimum seat floor.
// (Previously enforced a 10-seat minimum; removed per product direction so a
// small Growth team pays only for the seats it uses.)
const PER_SEAT_TIERS = ['starter', 'growth', 'business'];
const PER_SEAT_MIN   = 1;

// enforceSeatMinimum(tenantId)
// Guards against Polar quantities below the floor for per-seat tiers.
// Called from the webhook handler whenever a subscription state change
// could have dropped the quantity (subscription.created, .updated,
// .active, .uncanceled). If the recorded quantity is below PER_SEAT_MIN
// and the tier is per-seat, pushes back to PER_SEAT_MIN via the same
// Polar subscriptions.update path syncSeatCount uses.
//
// Idempotent: calling with quantity already at the floor is a no-op
// (Polar's update with the same quantity doesn't fire a new webhook).
async function enforceSeatMinimum(tenantId) {
  const platform = getPlatformDB();
  try {
    const [rows] = await platform.execute(
      `SELECT plan, seat_count, polar_subscription_id
       FROM tenants WHERE id = ? LIMIT 1`,
      [tenantId]
    );
    const t = rows[0];
    if (!t || !t.polar_subscription_id) return;
    if (!PER_SEAT_TIERS.includes(t.plan)) return;
    const current = Number(t.seat_count) || 0;
    if (current >= PER_SEAT_MIN) return;

    if (!isConfigured()) return;

    await polarApi('PATCH', `/v1/subscriptions/${t.polar_subscription_id}`, { seats: PER_SEAT_MIN });
    await platform.execute(
      'UPDATE tenants SET seat_count = ? WHERE id = ?',
      [PER_SEAT_MIN, tenantId]
    );
    console.log(`[billing] enforced ${PER_SEAT_MIN}-seat minimum on tenant ${tenantId} (was ${current})`);
  } catch (e) {
    console.error('[billing] enforceSeatMinimum failed:', e.message);
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

  if (!isConfigured()) return;

  const [rows] = await platform.execute(
    'SELECT polar_subscription_id, plan FROM tenants WHERE id = ?', [tenantId]
  );
  const subId = rows[0]?.polar_subscription_id;
  const plan  = rows[0]?.plan;
  if (!subId) return;

  // Seat sync applies to every per-seat tier. ALL current tiers — Starter,
  // Growth and Business — are priced per seat ($2 / $3 / $6 per seat), so the
  // actual team size must be pushed to Polar for any of them. (Starter used to
  // be flat, hence the old growth/business-only guard.)
  if (!PER_SEAT_TIERS.includes(plan)) return;

  // No seat minimum — bill the real team size. (The old 10-seat Growth floor
  // was removed per product direction.) Polar requires at least 1 seat.
  const billedSeats = Math.max(1, seats);

  try {
    await polarApi('PATCH', `/v1/subscriptions/${subId}`, { seats: billedSeats });
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
  setAutoRenew,
  setAddon,
  changePlan,
  reconcileSubscription,
  reconcileActiveSubscriptions,
  previewChange,
  subscriptionHasAddon,
  isConfigured,
};
