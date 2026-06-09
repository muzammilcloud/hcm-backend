const express = require('express');
const router  = express.Router();
const { getPlatformDB } = require('../db');
const {
  slugify, isValidSlug, isReservedSlug, isSlugAvailable, findFreeSlug,
  provisionTenant, audit,
} = require('../services/tenant');
const { sendInviteEmail } = require('../services/email');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// GET /api/slug-check?slug=acme
// Live availability check used by the signup form on the landing page.
router.get('/slug-check', async (req, res, next) => {
  try {
    const raw = String(req.query.slug || '').toLowerCase().trim();
    if (!raw) return res.json({ ok: false, reason: 'empty' });
    if (!isValidSlug(raw))   return res.json({ ok: false, reason: 'invalid' });
    if (isReservedSlug(raw)) return res.json({ ok: false, reason: 'reserved' });
    const available = await isSlugAvailable(raw);
    res.json({ ok: available, reason: available ? 'available' : 'taken' });
  } catch (e) { next(e); }
});

// GET /api/slug-suggest?name=Acme%20Corp
router.get('/slug-suggest', async (req, res, next) => {
  try {
    const base = slugify(req.query.name || '');
    if (!base) return res.json({ suggestion: null });
    const free = await findFreeSlug(base).catch(() => null);
    res.json({ suggestion: free });
  } catch (e) { next(e); }
});

// POST /api/signup
// Public auto-provisioning endpoint. Creates the tenant + sends an invite email.
router.post('/signup', async (req, res, next) => {
  const platform = getPlatformDB();
  const ip = req.ip;
  const ua = req.headers['user-agent'] || null;

  let signupId = null;
  try {
    const {
      firstName, lastName, email, company, slug: requestedSlug, teamSize, plan: chosenPlan,
    } = req.body || {};
    // Which tier the trial evaluates. Anything but 'starter' falls back to the
    // full-feature Growth trial (the long-standing default).
    const trialTier = String(chosenPlan).toLowerCase() === 'starter' ? 'starter' : 'growth';

    // Validate
    const errors = [];
    if (!firstName) errors.push('firstName');
    if (!lastName)  errors.push('lastName');
    if (!email)     errors.push('email');
    if (!company)   errors.push('company');
    if (errors.length) return res.status(400).json({ error: 'Missing required fields', fields: errors });
    if (!EMAIL_RE.test(String(email).trim())) {
      return res.status(400).json({ error: 'Invalid email' });
    }

    // Record the signup attempt first (so we have an audit trail even on failure)
    const [ins] = await platform.execute(
      `INSERT INTO tenant_signups (first_name, last_name, email, company, requested_slug, team_size, ip_address, user_agent, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_review')`,
      [firstName, lastName, email.trim().toLowerCase(), company, requestedSlug || null, teamSize || null, ip, ua]
    );
    signupId = ins.insertId;

    // Decide on the slug
    let finalSlug;
    if (requestedSlug) {
      const candidate = String(requestedSlug).toLowerCase().trim();
      if (!isValidSlug(candidate))   return failSignup(res, signupId, 'Invalid subdomain — use letters, numbers, dashes only.', 400);
      if (isReservedSlug(candidate)) return failSignup(res, signupId, 'That subdomain is reserved.', 400);
      if (!(await isSlugAvailable(candidate))) return failSignup(res, signupId, 'That subdomain is already taken.', 400);
      finalSlug = candidate;
    } else {
      const base = slugify(company);
      if (!base) return failSignup(res, signupId, 'Could not derive a subdomain from the company name. Please supply one.', 400);
      finalSlug = await findFreeSlug(base);
    }

    const adminName = `${firstName} ${lastName}`.trim();
    const result = await provisionTenant({
      slug:          finalSlug,
      companyName:   company,
      contactEmail:  email.trim().toLowerCase(),
      adminName,
      plan:          'demo',
      trialTier,
    });

    await platform.execute(
      `UPDATE tenant_signups SET status = 'provisioned', tenant_id = ? WHERE id = ?`,
      [result.tenantId, signupId]
    );
    audit({
      actorType: 'system', tenantId: result.tenantId,
      action: 'tenant.signup', detail: { slug: finalSlug, email }, ip,
    });

    // Fire invite email
    sendInviteEmail({
      to: email,
      name: adminName,
      inviteUrl: result.setPasswordUrl,
      companyName: company,
    }).catch((e) => console.error('[invite email] failed:', e.message));

    res.status(201).json({
      ok: true,
      slug: result.slug,
      portalUrl: result.portalUrl,
      trialEndsAt: result.trialEndsAt,
    });
  } catch (e) {
    if (signupId) {
      try {
        await platform.execute(
          `UPDATE tenant_signups SET status = 'failed', error = ? WHERE id = ?`,
          [String(e.message).slice(0, 1000), signupId]
        );
      } catch (_) {}
    }
    if (e.code === 'SLUG_TAKEN' || e.code === 'INVALID_SLUG' || e.code === 'RESERVED_SLUG') {
      return res.status(400).json({ error: e.message, code: e.code });
    }
    next(e);
  }
});

async function failSignup(res, signupId, msg, status = 400) {
  try {
    await getPlatformDB().execute(
      `UPDATE tenant_signups SET status = 'failed', error = ? WHERE id = ?`,
      [msg, signupId]
    );
  } catch (_) {}
  res.status(status).json({ error: msg });
}

// GET /api/tenant/whoami — used by the FE on a tenant subdomain to display
// the workspace's branding. Tenant resolved by middleware via subdomain or
// X-Tenant header. If no tenant context is set, returns 404.
//
// Computes access_restricted server-side so the FE has a single boolean
// to gate the paywall against — no need to re-derive trial expiry, polar
// status, and tenant status in the client.
router.get('/tenant/whoami', async (req, res) => {
  if (!req.tenant) return res.status(404).json({ error: 'No tenant resolved' });
  const t = req.tenant;

  // tenant.status is the source of truth for access — the scheduler flips
  // it to 'expired' after the 14-day trial ends without a sub, and to
  // 'suspended' after the 8-day past-due grace period (or on
  // subscription.revoked). We just mirror that here.
  //
  // Edge case: trial passed but the scheduler hasn't run yet (it runs at
  // 3 AM UTC). Catch that defensively so the wall doesn't lag a few hours.
  const trialPassedNoSub = t.trial_ends_at
    && new Date(t.trial_ends_at) <= new Date()
    && !['active','trialing','past_due','canceled'].includes(t.polar_status);
  const accessRestricted =
    t.status === 'expired' ||
    t.status === 'suspended' ||
    trialPassedNoSub;

  res.json({
    slug:              t.slug,
    company_name:      t.company_name,
    status:            t.status,
    plan:              t.plan,
    trial_ends_at:     t.trial_ends_at,
    polar_status:      t.polar_status || null,
    past_due_at:       t.past_due_at || null,
    cancel_at_period_end:  !!t.cancel_at_period_end,
    current_period_end:    t.current_period_end || null,
    access_restricted: accessRestricted,
  });
});

module.exports = router;
