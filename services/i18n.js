const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// Server-side i18n.
//
// Locale files live in /locales/{locale}.json. Every string is keyed by a
// dot-namespaced path (e.g. "email.invite.subject"). t(locale, key, vars)
// looks up the key in `locale`, falls back to `en` if missing, finally
// returns the key itself (with a warning) if it doesn't exist anywhere —
// that last case is a bug to fix in en.json, not a user-facing error.
//
// Adding a new locale: drop a JSON file in /locales/{code}.json and add
// the code to SUPPORTED. No other code changes.
// ─────────────────────────────────────────────────────────────────────────────

const SUPPORTED = ['en', 'en-GB', 'de', 'es', 'fr', 'ja', 'zh-CN', 'ko'];
const DEFAULT_LOCALE = 'en';

// In-memory cache so we read each JSON file at most once per process boot.
const cache = {};

function loadLocale(locale) {
  if (cache[locale]) return cache[locale];
  if (!SUPPORTED.includes(locale)) return {};
  const file = path.join(__dirname, '..', 'locales', `${locale}.json`);
  try {
    cache[locale] = JSON.parse(fs.readFileSync(file, 'utf8'));
    return cache[locale];
  } catch (e) {
    console.error(`[i18n] failed to load ${locale}.json:`, e.message);
    cache[locale] = {};
    return cache[locale];
  }
}

function getByPath(obj, dotPath) {
  if (!obj) return undefined;
  return dotPath.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

function interpolate(str, vars) {
  if (!vars || typeof str !== 'string') return str;
  return str.replace(/\{(\w+)\}/g, (m, name) =>
    vars[name] != null ? String(vars[name]) : m
  );
}

// t(locale, 'invite.subject', { companyName: 'Acme' })
function t(locale, key, vars) {
  const resolved = SUPPORTED.includes(locale) ? locale : DEFAULT_LOCALE;
  // Try resolved locale, then fallback to en, then return key + warning.
  let val = getByPath(loadLocale(resolved), key);
  if (val == null && resolved !== DEFAULT_LOCALE) {
    val = getByPath(loadLocale(DEFAULT_LOCALE), key);
  }
  if (val == null) {
    console.warn(`[i18n] missing key "${key}" in both ${resolved} and ${DEFAULT_LOCALE}`);
    return key;
  }
  return interpolate(val, vars);
}

// resolveLocale(opts) — picks the best locale to use given any of:
//   - opts.user.preferred_locale (most authoritative — explicit user choice)
//   - opts.workspace.default_locale (workspace fallback)
//   - opts.header (Accept-Language header from the request)
//   - DEFAULT_LOCALE (en)
//
// Used by:
//   - request middleware (sets req.locale for response rendering)
//   - email/Slack senders (rendering in the recipient's locale, not the
//     caller's). For scheduled emails / async events, the recipient's
//     preferred_locale is the only signal — there's no req.
function resolveLocale({ user, workspace, header } = {}) {
  if (user?.preferred_locale && SUPPORTED.includes(user.preferred_locale)) {
    return user.preferred_locale;
  }
  if (workspace?.default_locale && SUPPORTED.includes(workspace.default_locale)) {
    return workspace.default_locale;
  }
  if (header) {
    const best = parseAcceptLanguage(header);
    if (best) return best;
  }
  return DEFAULT_LOCALE;
}

// Lightweight Accept-Language parser. Returns the best-match locale from
// SUPPORTED, or null if no match. Handles common shapes:
//   "en-US,en;q=0.9,de;q=0.8" → 'en'
//   "de-DE,de;q=0.9"          → 'de'
//   "zh-Hans-CN,zh;q=0.9"     → 'zh-CN' (we map zh / zh-* to zh-CN)
function parseAcceptLanguage(header) {
  if (!header) return null;
  const candidates = header
    .split(',')
    .map(p => {
      const [tag, qPart] = p.trim().split(';');
      const q = qPart && qPart.startsWith('q=') ? parseFloat(qPart.slice(2)) : 1;
      return { tag: tag.trim(), q };
    })
    .sort((a, b) => b.q - a.q);

  for (const c of candidates) {
    const t = c.tag.toLowerCase();
    // Exact match (case-insensitive)
    const exact = SUPPORTED.find(s => s.toLowerCase() === t);
    if (exact) return exact;
    // Language-only match (e.g. "de-DE" → "de"; "zh-Hans-CN" → "zh-CN")
    const lang = t.split('-')[0];
    if (lang === 'zh') return SUPPORTED.includes('zh-CN') ? 'zh-CN' : null;
    if (lang === 'en') return SUPPORTED.includes('en') ? 'en' : null;
    const langMatch = SUPPORTED.find(s => s.toLowerCase().startsWith(lang + '-') || s.toLowerCase() === lang);
    if (langMatch) return langMatch;
  }
  return null;
}

// Intl formatters bound to a locale. Wrap once so callers don't repeat
// `new Intl.NumberFormat(...)` everywhere.
function formatCurrency(locale, amount, currency = 'USD') {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${currency} ${amount}`;
  }
}

function formatDate(locale, date, opts = { year: 'numeric', month: 'short', day: 'numeric' }) {
  try {
    return new Intl.DateTimeFormat(locale, opts).format(date instanceof Date ? date : new Date(date));
  } catch {
    return String(date);
  }
}

function formatNumber(locale, value) {
  try {
    return new Intl.NumberFormat(locale).format(value);
  } catch {
    return String(value);
  }
}

module.exports = {
  SUPPORTED,
  DEFAULT_LOCALE,
  t,
  resolveLocale,
  parseAcceptLanguage,
  formatCurrency,
  formatDate,
  formatNumber,
};
