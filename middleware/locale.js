const { resolveLocale } = require('../services/i18n');

// localeMiddleware — populates req.locale from the X-Locale header (sent
// by the FE on every API call) or, failing that, Accept-Language. The
// resolved locale is used to render any user-facing strings returned in
// the response body. Per-recipient emails resolve their OWN locale from
// the recipient's `preferred_locale` (set on portal_users), NOT this one.
module.exports = function localeMiddleware(req, res, next) {
  const headerLocale = req.headers['x-locale'];
  req.locale = resolveLocale({
    user: headerLocale ? { preferred_locale: headerLocale } : null,
    header: req.headers['accept-language'],
  });
  next();
};
