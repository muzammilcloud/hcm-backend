const { calculateTax } = require('./taxModules');

// ─────────────────────────────────────────────────────────────────────────────
// Salary calculator
//
// Given an employee + the tenant's components + (optional) overrides + tax
// brackets, returns a structured slip:
//
//   {
//     basic, gross, taxable_income, total_tax, total_deductions, net,
//     earnings:   [{ component_id, code, name, amount, taxable, show_on_slip, ... }],
//     deductions: [{ component_id, code, name, amount, show_on_slip, ... }],
//     tax_line:   { name: "Income Tax", amount, brackets_used, ... },
//   }
//
// Calculation order:
//   1. Resolve "basic_salary" component value (employee's basic salary)
//   2. percent_of_basic components
//   3. fixed components
//   4. percent_of_gross components (gross = basic + sum of resolved earnings so far)
//   5. percent_of_ctc components (CTC = gross + employer contributions; for
//      now we treat CTC == gross until Phase E adds employer-side components)
//   6. Apply caps where set
//   7. taxable_income = sum of earnings flagged taxable=1
//   8. Income tax = calculateTax(taxable_income, brackets)
//   9. Net = total earnings − total deductions
// ─────────────────────────────────────────────────────────────────────────────

function applyCap(value, cap) {
  if (cap == null || cap === '' || isNaN(Number(cap))) return value;
  return Math.min(value, Number(cap));
}

function resolveOne({ method, amount, percent, cap_amount, basic, gross, ctc }) {
  let v;
  switch (method) {
    case 'fixed':            v = Number(amount   || 0); break;
    case 'percent_of_basic': v = (Number(percent || 0) / 100) * basic; break;
    case 'percent_of_gross': v = (Number(percent || 0) / 100) * gross; break;
    case 'percent_of_ctc':   v = (Number(percent || 0) / 100) * ctc;   break;
    default: v = 0;
  }
  return Math.round(applyCap(v, cap_amount) * 100) / 100;
}

async function calculateSlip(pool, employeeId) {
  // Employee + basic salary
  const [empRows] = await pool.execute(`
    SELECT e.id, e.name, e.email, e.emp_code, e.department, e.role,
           s.basic_salary
    FROM employees e
    LEFT JOIN employee_salaries s ON s.employee_id = e.id
    WHERE e.id = ?
    LIMIT 1
  `, [employeeId]);
  if (!empRows.length) throw new Error('Employee not found');
  const emp = empRows[0];
  const basic = Number(emp.basic_salary || 0);

  // Components + overrides
  const [components] = await pool.execute(
    `SELECT id, code, name, kind, calc_method, amount, percent, cap_amount,
            taxable, show_on_slip, sort_order, system_managed
     FROM salary_components
     WHERE active = 1
     ORDER BY
       CASE calc_method
         WHEN 'fixed' THEN 1
         WHEN 'percent_of_basic' THEN 2
         WHEN 'percent_of_gross' THEN 3
         WHEN 'percent_of_ctc' THEN 4
       END,
       sort_order ASC, name ASC`
  );
  const [overrides] = await pool.execute(
    `SELECT * FROM employee_component_overrides WHERE employee_id = ?`,
    [employeeId]
  );
  const overrideMap = new Map(overrides.map(o => [o.component_id, o]));

  // Tax brackets + on/off toggle. If tax_enabled is 0, the calculator
  // skips tax calculation entirely — no tax line on the slip.
  const [brackets] = await pool.execute(
    `SELECT band_from, band_to, rate FROM tax_brackets ORDER BY sort_order ASC, band_from ASC`
  );
  let taxEnabled = true;
  try {
    const [metaRows] = await pool.execute(
      `SELECT tax_enabled FROM tax_bracket_meta WHERE singleton_key = 1 LIMIT 1`
    );
    if (metaRows.length && metaRows[0].tax_enabled != null) taxEnabled = !!metaRows[0].tax_enabled;
  } catch (_) { /* legacy DB without column — default to enabled */ }

  const taxBrackets = taxEnabled
    ? brackets.map(b => ({
        band_from: Number(b.band_from),
        band_to:   b.band_to == null ? null : Number(b.band_to),
        rate:      Number(b.rate),
      }))
    : [];

  // First pass: compute basic + fixed + percent_of_basic earnings/deductions
  let gross = basic;
  const earnings   = [];
  const deductions = [];
  const dependsOnGross = [];

  for (const c of components) {
    // Special handling for the system "basic_salary" component — its value is
    // the employee's basic, not the component default.
    if (c.code === 'basic_salary') {
      earnings.push(toLine(c, basic, false));
      continue;
    }

    const ov = overrideMap.get(c.id);
    const eff = {
      method:     ov?.calc_method ?? c.calc_method,
      amount:     ov?.amount  ?? c.amount,
      percent:    ov?.percent ?? c.percent,
      cap_amount: ov?.cap_amount ?? c.cap_amount,
    };

    if (eff.method === 'percent_of_gross' || eff.method === 'percent_of_ctc') {
      // Deferred — needs gross / CTC after first pass
      dependsOnGross.push({ c, eff });
      continue;
    }

    const value = resolveOne({ ...eff, basic, gross: 0, ctc: 0 });
    const line  = toLine(c, value, !!ov);
    if (c.kind === 'earning')   { earnings.push(line);   gross += value; }
    else                         deductions.push(line);
  }

  // Second pass: percent_of_gross / percent_of_ctc components.
  // CTC currently == gross; will diverge once employer-side components land.
  for (const { c, eff } of dependsOnGross) {
    const ctc   = gross;
    const value = resolveOne({ ...eff, basic, gross, ctc });
    const line  = toLine(c, value, false);
    if (c.kind === 'earning')   { earnings.push(line); gross += value; }
    else                         deductions.push(line);
  }

  const total_earnings = earnings.reduce((s, l) => s + l.amount, 0);
  const total_deductions_pre_tax = deductions.reduce((s, l) => s + l.amount, 0);

  const taxable_income = earnings
    .filter(l => l.taxable)
    .reduce((s, l) => s + l.amount, 0);

  const total_tax = calculateTax(taxable_income, taxBrackets);

  const tax_line = total_tax > 0
    ? { component_id: null, code: 'income_tax', name: 'Income Tax', amount: total_tax, kind: 'deduction', show_on_slip: 1, system: true }
    : null;

  const total_deductions = total_deductions_pre_tax + total_tax;
  const net = total_earnings - total_deductions;

  return {
    employee: {
      id: emp.id, name: emp.name, email: emp.email,
      emp_code: emp.emp_code, department: emp.department, role: emp.role,
    },
    basic,
    earnings,
    deductions: tax_line ? [...deductions, tax_line] : deductions,
    taxable_income,
    total_earnings:   round2(total_earnings),
    total_deductions: round2(total_deductions),
    total_tax:        round2(total_tax),
    net:              round2(net),
  };
}

function toLine(c, amount, isOverride) {
  return {
    component_id: c.id,
    code: c.code,
    name: c.name,
    kind: c.kind,
    amount: round2(amount),
    taxable: !!c.taxable,
    show_on_slip: !!c.show_on_slip,
    overridden: !!isOverride,
  };
}

function round2(n) { return Math.round(n * 100) / 100; }

module.exports = { calculateSlip };
