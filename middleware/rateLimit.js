const rateLimit = require('express-rate-limit');

// Auth-burst limiter — protects login + password endpoints from brute-force
// attempts. Generous enough that a real user retrying a typo won't hit it.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  max: 20,                     // 20 attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Too many attempts. Please try again in a few minutes.' },
});

// Password reset request limiter — keeps anyone from spamming reset emails.
const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,   // 1 hour
  max: 5,                      // 5 reset requests per IP per hour
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many password reset requests. Please try again later.' },
});

module.exports = { authLimiter, passwordResetLimiter };
