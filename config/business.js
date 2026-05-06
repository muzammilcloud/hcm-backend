// Business rules — single source of truth.
// Edit here, not in route files.

// Standard working day. Hours past this on a single session are overtime.
const OT_THRESHOLD_HOURS = 9;
const OT_THRESHOLD_MS    = OT_THRESHOLD_HOURS * 60 * 60 * 1000;

// Monthly target (used by OT/payroll banners on the FE; mirrored in src/config.js).
const MONTHLY_TARGET_HOURS = 180;

module.exports = {
  OT_THRESHOLD_HOURS,
  OT_THRESHOLD_MS,
  MONTHLY_TARGET_HOURS,
};
