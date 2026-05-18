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

const ADDON_PRICE_IDS = {
  desktop_standard: env('POLAR_ADDON_DESKTOP_STANDARD_PRICE_ID'), // $2.50/employee/mo
  desktop_founding: env('POLAR_ADDON_DESKTOP_FOUNDING_PRICE_ID'), // $2.00/employee/mo
};

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
  tierFromPriceId,
  isConfigured,
};
