const { getPlatformDB, getTenantDB, tenantContext } = require('../db');
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

function subscriptionHasAddon(sub, addonKey) {
  const target = ADDON_PRICE_IDS[addonKey];
  if (!target) return false;
  return extractPriceIds(sub).includes(target);
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

  const checkoutBody = {
    products,
    customerEmail: tenant.contact_email,
    successUrl,
    metadata: {
      tenant_id:   String(tenant.id),
      tenant_slug: tenant.slug,
    },
  };

  // For per-seat tiers (Growth, Business), open checkout at the 10-seat
  // floor so the customer sees the real minimum bill at the Polar
  // checkout page (not $3/mo for a single seat). The enforceSeatMinimum
  // safety net on the webhook would catch a low quantity anyway, but
  // setting it here means the customer sees the truth on the first screen.
  if (PER_SEAT_TIERS.includes(tier)) {
    checkoutBody.customerSeats = PER_SEAT_MIN;
  }

  const checkout = await polar.checkouts.create(checkoutBody);

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

async function onSubscriptionUpserted(tenantId, sub) {
  if (!tenantId || !sub) return;
  const platform = getPlatformDB();
  const priceId = sub.priceId || sub.price?.id || sub.product?.id;
  const tierInfo = priceId ? tierFromPriceId(priceId) : null;
  const billing_cycle = tierInfo?.cycle || null;
  const plan = tierInfo?.tier || null;

  // current_period_end + cancel_at_period_end mirrored so the FE can render
  // "cancels on X" / "renews on X" without a Polar API round-trip.
  const currentPeriodEnd = sub.currentPeriodEnd
    ? new Date(sub.currentPeriodEnd) : null;
  const cancelAtPeriodEnd = sub.cancelAtPeriodEnd ? 1 : 0;

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
      sub.customerId || null,
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
  const periodEnd = sub?.currentPeriodEnd ? new Date(sub.currentPeriodEnd) : null;
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
        polar_customer_id: sub?.customerId || sub?.customer?.id,
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
  const polar = getPolar();
  if (!polar) throw new Error('Billing is not configured on this server.');
  if (!tenant?.polar_subscription_id) {
    throw new Error('No active subscription to change.');
  }
  if (!['starter', 'growth'].includes(tier)) {
    throw new Error('Self-serve plan changes are only between Starter and Growth. Business plans need a sales conversation.');
  }
  if (!['monthly', 'annual'].includes(cycle)) {
    throw new Error('cycle must be monthly | annual.');
  }
  const newBasePriceId = PRICE_IDS[tier]?.[cycle];
  if (!newBasePriceId) {
    throw new Error(`Polar price not configured for ${tier}/${cycle}.`);
  }

  // Pull current subscription, replace the BASE plan price while keeping
  // any add-on lines (desktop_standard, etc.) intact.
  const current = await polar.subscriptions.get({ id: tenant.polar_subscription_id });
  const allCurrentPriceIds = extractPriceIds(current);

  // Identify which current price IDs are base-plan products (Starter or
  // Growth, monthly or annual). Drop those; keep everything else (add-ons).
  const allBasePriceIds = new Set();
  for (const cycles of Object.values(PRICE_IDS)) {
    for (const id of Object.values(cycles)) if (id) allBasePriceIds.add(id);
  }
  const kept = allCurrentPriceIds.filter(id => !allBasePriceIds.has(id));
  const newPriceIds = [newBasePriceId, ...kept];

  // For per-seat tiers, also push a quantity of at least PER_SEAT_MIN so
  // the customer doesn't briefly bill at quantity=1 between the plan
  // switch and the webhook-driven enforceSeatMinimum re-clamp.
  const updateBody = {
    id: tenant.polar_subscription_id,
    productPriceIds: newPriceIds,
  };
  if (PER_SEAT_TIERS.includes(tier)) {
    const currentSeats = Number(tenant.seat_count) || 0;
    updateBody.quantity = Math.max(currentSeats, PER_SEAT_MIN);
  }
  await polar.subscriptions.update(updateBody);

  return { tier, cycle, pending_sync: true };
}

// Locally compute a prorated preview for a plan change OR add-on toggle.
// Doesn't hit Polar — uses the cached subscription state from our DB
// plus the desired new shape to estimate the delta. Polar does the
// authoritative math at the moment of update; this is for the
// "are you sure?" panel.
function previewChange(tenant, { tier, cycle, addons = [], seats }) {
  const TIER_MONTHLY = { starter: 19, growth: 3, business: 6 };
  const ADDON_MONTHLY = { desktop_standard: 3 };
  const ANNUAL_FACTOR = 0.8;
  const GROWTH_BUSINESS_MIN_SEATS = 10;

  const currentTier  = tenant?.plan || 'starter';
  const currentCycle = tenant?.billing_cycle || 'monthly';
  const currentSeats = Number(tenant?.seat_count) || Number(seats) || 1;
  const currentAddons = Array.isArray(tenant?.addons) ? tenant.addons : [];

  const isPerSeat = (t) => t === 'growth' || t === 'business';
  // Per-seat tiers (Growth, Business) have a 10-seat minimum. Bill the
  // greater of actual employees or the minimum so a 4-person team on
  // Growth still pays the floor of $30/mo, not $12/mo.
  const billedSeats = (t, count) => isPerSeat(t) ? Math.max(count, GROWTH_BUSINESS_MIN_SEATS) : count;
  const tierMonthlyTotal = (t, count) => {
    const per = TIER_MONTHLY[t] || 0;
    return isPerSeat(t) ? per * billedSeats(t, count) : per;
  };
  // Add-ons bill for actual employees, not the minimum-bill seat count
  // (so a 4-employee Growth tenant with Desktop on pays 4 × $3 = $12, not
  // 10 × $3 = $30 for desktop licenses they're not using).
  const addonMonthlyTotal = (list, count) =>
    list.reduce((sum, a) => sum + (ADDON_MONTHLY[a] || 0) * count, 0);

  const currentMonthly = tierMonthlyTotal(currentTier, currentSeats)
                       + addonMonthlyTotal(currentAddons, currentSeats);
  const newSeats       = Number(seats) || currentSeats;
  const newMonthly     = tierMonthlyTotal(tier || currentTier, newSeats)
                       + addonMonthlyTotal(addons, newSeats);

  // Prorate: how many days remain in the current billing cycle?
  const now      = new Date();
  const periodEnd = tenant?.current_period_end ? new Date(tenant.current_period_end) : null;
  const daysRemaining = periodEnd
    ? Math.max(0, Math.ceil((periodEnd - now) / 86_400_000))
    : 30;
  // Approximate days in cycle from billing_cycle so monthly + annual share math
  const daysInCycle = (cycle || currentCycle) === 'annual' ? 365 : 30;

  const currentFactor = currentCycle === 'annual' ? ANNUAL_FACTOR : 1;
  const newFactor     = (cycle || currentCycle) === 'annual' ? ANNUAL_FACTOR : 1;

  // Per-day rate for the remainder of the current period
  const currentDailyRate = (currentMonthly * currentFactor) / 30;
  const newDailyRate     = (newMonthly * newFactor) / 30;
  const proratedDelta    = (newDailyRate - currentDailyRate) * daysRemaining;

  const nextRenewalTotal = (cycle === 'annual' || (!cycle && currentCycle === 'annual'))
    ? newMonthly * newFactor * 12
    : newMonthly * newFactor;

  return {
    current: {
      tier:    currentTier,
      cycle:   currentCycle,
      seats:   currentSeats,
      addons:  currentAddons,
      monthly: Math.round(currentMonthly * currentFactor * 100) / 100,
    },
    next: {
      tier:    tier || currentTier,
      cycle:   cycle || currentCycle,
      seats:   newSeats,
      addons,
      monthly: Math.round(newMonthly * newFactor * 100) / 100,
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
async function setAddon(tenant, addonKey, enabled) {
  const polar = getPolar();
  if (!polar) throw new Error('Billing is not configured on this server.');
  if (!tenant?.polar_subscription_id) {
    throw new Error('No active subscription to attach the add-on to.');
  }
  const addonPriceId = ADDON_PRICE_IDS[addonKey];
  if (!addonPriceId) {
    throw new Error(`Unknown add-on: ${addonKey}`);
  }

  // Pull current sub from Polar, compute the desired final price list.
  const current = await polar.subscriptions.get({ id: tenant.polar_subscription_id });
  const currentPriceIds = extractPriceIds(current);
  const hasIt = currentPriceIds.includes(addonPriceId);

  if (enabled && hasIt)   return { addon: addonKey, enabled: true,  no_change: true };
  if (!enabled && !hasIt) return { addon: addonKey, enabled: false, no_change: true };

  const newPriceIds = enabled
    ? [...currentPriceIds, addonPriceId]
    : currentPriceIds.filter(id => id !== addonPriceId);

  await polar.subscriptions.update({
    id: tenant.polar_subscription_id,
    productPriceIds: newPriceIds,
  });

  return { addon: addonKey, enabled, no_change: false };
}

// Auto-renewal toggle: turn off (= cancel at period end) or back on
// (= uncancel). Both push to Polar and the resulting webhook syncs our DB.
async function setAutoRenew(tenant, autoRenew) {
  const polar = getPolar();
  if (!polar) throw new Error('Billing is not configured on this server.');
  if (!tenant?.polar_subscription_id) {
    throw new Error('No active subscription to update.');
  }
  if (autoRenew) {
    // Uncancel. Polar SDK: polar.subscriptions.update({ id, cancelAtPeriodEnd: false })
    return polar.subscriptions.update({
      id: tenant.polar_subscription_id,
      cancelAtPeriodEnd: false,
    });
  } else {
    return polar.subscriptions.update({
      id: tenant.polar_subscription_id,
      cancelAtPeriodEnd: true,
    });
  }
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
      price_id:             sub.priceId || sub.price?.id || null,
      current_period_end:   sub.currentPeriodEnd || null,
      cancel_at_period_end: sub.cancelAtPeriodEnd || false,
      customer_id:          sub.customerId || sub.customer?.id || null,
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

// Hard floor on per-seat tiers. Polar's UI doesn't expose a minimum-
// quantity field on the price config, so we enforce it server-side.
const PER_SEAT_TIERS = ['growth', 'business'];
const PER_SEAT_MIN   = 10;

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

    const polar = getPolar();
    if (!polar) return;

    await polar.subscriptions.update({
      id: t.polar_subscription_id,
      quantity: PER_SEAT_MIN,
    });
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

  // 10-seat minimum on Growth/Business — a tenant with 4 employees still
  // bills as 10 seats. Polar charges max(actual, minimum). Without this
  // clamp, syncing 4 to Polar would charge 4 × $3 = $12/mo, undercutting
  // the marketed Growth floor of $30/mo.
  const GROWTH_BUSINESS_MIN_SEATS = 10;
  const billedSeats = Math.max(seats, GROWTH_BUSINESS_MIN_SEATS);

  try {
    await polar.subscriptions.update({ id: subId, quantity: billedSeats });
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
  previewChange,
  subscriptionHasAddon,
  isConfigured,
};
