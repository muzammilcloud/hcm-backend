// ─────────────────────────────────────────────────────────────────────────────
// Polar.sh billing constants.
//
// All price / product IDs come from the Polar dashboard once products are
// created. Until those exist, the IDs are read from env vars so we don't
// hardcode anything that will change between sandbox and production.
//
// Naming pattern: POLAR_<TIER>_<CYCLE>_PRICE_ID and POLAR_ADDON_<NAME>_PRICE_ID.
// Sandbox account uses one set, production another. POLAR_ENV picks which.
// ─────────────────────────────────────────────────────────────────────────────

function env(name, dflt) {
  const v = process.env[name];
  return (typeof v === 'string' ? v.trim() : v) || dflt || '';
}

// 'sandbox' | 'production'. SDK uses this to pick the API host.
const POLAR_ENV       = env('POLAR_ENV', 'sandbox');
const POLAR_ACCESS_TOKEN  = env('POLAR_ACCESS_TOKEN');
const POLAR_WEBHOOK_SECRET = env('POLAR_WEBHOOK_SECRET');
const POLAR_ORG_ID    = env('POLAR_ORG_ID');

// Price IDs — populated after sandbox products are created.
// Until each value is set, the corresponding plan can't be checked out
// and we render a clear "billing not configured" error rather than crashing.
const PRICE_IDS = {
  starter:  { monthly: env('POLAR_STARTER_MONTHLY_PRICE_ID'), annual: env('POLAR_STARTER_ANNUAL_PRICE_ID') },
  growth:   { monthly: env('POLAR_GROWTH_MONTHLY_PRICE_ID'),  annual: env('POLAR_GROWTH_ANNUAL_PRICE_ID')  },
  business: { monthly: env('POLAR_BUSINESS_MONTHLY_PRICE_ID'),annual: env('POLAR_BUSINESS_ANNUAL_PRICE_ID')},
};

// Add-on price IDs are cycle-aware: a monthly add-on product (billed every
// month) and an annual one (billed once a year, so an annual base + add-on
// lands on ONE consolidated invoice). $3/employee/mo everywhere; the annual
// add-on is the same rate un-discounted ($36/yr/seat). The monthly id falls
// back to the legacy single env var name for backward compatibility.
const ADDON_PRICE_IDS = {
  desktop_standard: {
    monthly: env('POLAR_ADDON_DESKTOP_STANDARD_MONTHLY_PRICE_ID') || env('POLAR_ADDON_DESKTOP_STANDARD_PRICE_ID'),
    annual:  env('POLAR_ADDON_DESKTOP_STANDARD_ANNUAL_PRICE_ID'),
  },
  desktop_founding: {
    monthly: env('POLAR_ADDON_DESKTOP_FOUNDING_MONTHLY_PRICE_ID') || env('POLAR_ADDON_DESKTOP_FOUNDING_PRICE_ID'),
    annual:  env('POLAR_ADDON_DESKTOP_FOUNDING_ANNUAL_PRICE_ID'),
  },
};

// Pick the add-on price for a base billing cycle. Annual subscriptions use the
// annual add-on product (one yearly bill); if no annual price is configured,
// fall back to the monthly add-on (billed separately each month).
function addonPriceFor(addonKey, cycle) {
  const a = ADDON_PRICE_IDS[addonKey];
  if (!a) return '';
  if (cycle === 'annual') return a.annual || a.monthly || '';
  return a.monthly || '';
}

// Every configured price id for an add-on (both cycles) — used to detect or
// strip the add-on from a subscription regardless of which cycle it's on.
function addonPriceIdsAll(addonKey) {
  const a = ADDON_PRICE_IDS[addonKey];
  return a ? [a.monthly, a.annual].filter(Boolean) : [];
}

// Reverse lookup: which add-on key does this price id belong to (if any)?
function addonKeyFromPriceId(priceId) {
  for (const [key, cycles] of Object.entries(ADDON_PRICE_IDS)) {
    if (priceId && (cycles.monthly === priceId || cycles.annual === priceId)) return key;
  }
  return null;
}

// Convenience reverse lookup so webhook handlers can resolve a price ID back
// to its tier identifier when Polar tells us "subscription is on price X".
function tierFromPriceId(priceId) {
  for (const [tier, cycles] of Object.entries(PRICE_IDS)) {
    for (const [cycle, id] of Object.entries(cycles)) {
      if (id && id === priceId) return { tier, cycle };
    }
  }
  return null;
}

function isConfigured() {
  return Boolean(POLAR_ACCESS_TOKEN && POLAR_WEBHOOK_SECRET);
}

module.exports = {
  POLAR_ENV,
  POLAR_ACCESS_TOKEN,
  POLAR_WEBHOOK_SECRET,
  POLAR_ORG_ID,
  PRICE_IDS,
  ADDON_PRICE_IDS,
  addonPriceFor,
  addonPriceIdsAll,
  addonKeyFromPriceId,
  tierFromPriceId,
  isConfigured,
};
