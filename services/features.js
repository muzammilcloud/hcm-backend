// ─────────────────────────────────────────────────────────────────────────────
// Plan → feature gating (single source of truth)
//
// Every paid feature is keyed by a stable string. The FEATURES map below
// is the only place where "Starter gets X" and "Growth gets Y" lives.
// Backend routes call tenantHas(tenant, 'feature_key') to decide; the FE
// reads /api/tenant/features and hides UI for features the tenant lacks.
//
// Tier resolution:
//   - tenant.plan is one of: 'demo' | 'starter' | 'growth' | 'business' | null
//   - 'demo' = self-serve trial. Trials get the FULL feature set so the
//     prospect can evaluate everything before paying.
//   - 'business' isn't actively sold right now (commented out in the FE).
//     The plan still resolves to the same superset Growth has — until we
//     ship the SSO/SAML/SLA/API features that justify a higher tier.
//   - null / unknown plan defaults to Starter, the most restrictive set.
// ─────────────────────────────────────────────────────────────────────────────

// Starter — the public 5-bullet list customers see on the pricing page.
const STARTER_FEATURES = new Set([
  'clock_in_out',           // web + Slack clock-in/out + breaks
  'attendance_leave',       // leave requests, admin approval (single-stage)
  'salary_slips',           // monthly PDF generation + email delivery
  'weekly_reports',         // weekly email digest
  'email_support',          // org-level commitment, never code-gated
  'smtp_integration',       // bring-your-own SMTP — available on every plan; only
                            // affects HOW the plan's own emails are delivered, not
                            // WHICH emails are sent (those stay feature-gated).
]);

// Growth — everything Starter has plus the larger feature set.
//
// NOTE: the Desktop App is NOT a plan feature — it's a paid add-on available
// on EVERY plan (including Starter). Desktop access is gated purely by the
// `desktop_standard` add-on (tenants.addons), see routes/desktop.js. So
// 'desktop_app' deliberately does NOT appear in any plan's feature set.
const GROWTH_FEATURES = new Set([
  ...STARTER_FEATURES,
  'overtime_detection',           // Slack OT prompt + per-session decision
  'monthly_reconciliation',       // 1st-of-month 3-bucket OT snapshot
  'custom_tax_brackets',          // edit tax brackets (Starter is preset-only)
  'custom_salary_components',     // create earnings/deductions beyond defaults
  'team_lead_role',               // two-stage approval (TL → Admin)
  'monthly_reports',              // monthly email digest in addition to weekly
  'csv_exports',                  // CSV downloads in Employees, Salary, Reports
  'audit_log',                    // append-only audit log access
]);

const FEATURES = {
  free:     STARTER_FEATURES,  // free-forever plan — same features as Starter, capped at 10 employees
  starter:  STARTER_FEATURES,
  growth:   GROWTH_FEATURES,
  business: GROWTH_FEATURES,   // alias — Business carries the same shipped feature set today
  demo:     GROWTH_FEATURES,   // legacy trials got the full evaluation experience
  trial:    GROWTH_FEATURES,   // legacy alias
};

// Map each feature to the minimum plan that includes it. Used by FE upgrade
// nudges so a 402 from any feature gate can say "Upgrade to <plan>" cleanly.
const FEATURE_MIN_PLAN = {
  // Starter-tier features (always available)
  clock_in_out:        'starter',
  attendance_leave:    'starter',
  salary_slips:        'starter',
  weekly_reports:      'starter',
  email_support:       'starter',
  smtp_integration:    'starter',   // bring-your-own SMTP available on every plan
  // Growth-tier features
  overtime_detection:         'growth',
  monthly_reconciliation:     'growth',
  custom_tax_brackets:        'growth',
  custom_salary_components:   'growth',
  team_lead_role:             'growth',
  monthly_reports:            'growth',
  csv_exports:                'growth',
  audit_log:                  'growth',
};

// Resolve a tenant's effective plan key. Treats anything unknown as 'starter'
// (most restrictive) to fail closed.
//
// During a self-serve trial (plan = demo/trial) we honour the tier the tenant
// chose to evaluate (trial_tier = 'starter' | 'growth') so the demo reflects the
// plan they intend to buy. If no choice was recorded, trials default to 'growth'
// — the full evaluation experience, matching the long-standing behaviour.
function planOf(tenant) {
  const raw = String(tenant?.plan || '').toLowerCase().trim();
  if (raw === 'demo' || raw === 'trial') {
    const tier = String(tenant?.trial_tier || '').toLowerCase().trim();
    if (tier === 'starter' || tier === 'growth' || tier === 'business') return tier;
    return 'growth';
  }
  return FEATURES[raw] ? raw : 'starter';
}

// Public: does this tenant include the given feature?
function tenantHas(tenant, feature) {
  const plan = planOf(tenant);
  return FEATURES[plan].has(feature);
}

// Public: list of all features the tenant has access to.
function tenantFeatures(tenant) {
  return [...FEATURES[planOf(tenant)]];
}

// Public: minimum plan that unlocks a given feature.
function minPlanFor(feature) {
  return FEATURE_MIN_PLAN[feature] || 'growth';
}

module.exports = {
  FEATURES,
  FEATURE_MIN_PLAN,
  planOf,
  tenantHas,
  tenantFeatures,
  minPlanFor,
};
