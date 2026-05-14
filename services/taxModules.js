// ─────────────────────────────────────────────────────────────────────────────
// Bundled income-tax presets per country.
//
// These are STARTING POINTS — the sys-admin reviews + confirms (or edits)
// them in the Tax page. Where the actual law is more complex (multi-status
// brackets, cess, surcharges, regional taxes), we simplify to the most
// common salaried employee case and document the assumption.
//
// All amounts in the country's local currency, expressed in WHOLE units
// (not thousands / lakh / millions). Tax engine treats `band_to: null` as
// "and above".
//
// Year tag in `year` is the tax year these slabs reflect — the UI shows it
// so the admin knows whether the preset is current.
// ─────────────────────────────────────────────────────────────────────────────

const PRESETS = {
  // Pakistan — salaried individuals, FY 2025-26 (Jul 2025 – Jun 2026)
  PK: {
    year: '2025-26',
    notes: 'Salaried individual slabs per Finance Act. Excludes surcharge.',
    brackets: [
      { band_from: 0,        band_to: 600000,   rate: 0  },
      { band_from: 600000,   band_to: 1200000,  rate: 5  },
      { band_from: 1200000,  band_to: 2200000,  rate: 15 },
      { band_from: 2200000,  band_to: 3200000,  rate: 25 },
      { band_from: 3200000,  band_to: 4100000,  rate: 30 },
      { band_from: 4100000,  band_to: null,     rate: 35 },
    ],
  },

  // India — new regime, FY 2025-26
  IN: {
    year: '2025-26',
    notes: 'New regime (default). Excludes cess (4% on tax) and surcharge.',
    brackets: [
      { band_from: 0,        band_to: 400000,   rate: 0  },
      { band_from: 400000,   band_to: 800000,   rate: 5  },
      { band_from: 800000,   band_to: 1200000,  rate: 10 },
      { band_from: 1200000,  band_to: 1600000,  rate: 15 },
      { band_from: 1600000,  band_to: 2000000,  rate: 20 },
      { band_from: 2000000,  band_to: 2400000,  rate: 25 },
      { band_from: 2400000,  band_to: null,     rate: 30 },
    ],
  },

  // United Kingdom — England/Wales/NI, 2025-26
  GB: {
    year: '2025-26',
    notes: 'England/Wales/NI bands. Personal allowance (£12,570) is the 0% band.',
    brackets: [
      { band_from: 0,        band_to: 12570,    rate: 0  },
      { band_from: 12570,    band_to: 50270,    rate: 20 },
      { band_from: 50270,    band_to: 125140,   rate: 40 },
      { band_from: 125140,   band_to: null,     rate: 45 },
    ],
  },

  // United States — federal, single filer, 2025
  US: {
    year: '2025',
    notes: 'Federal income tax, single filer. Excludes FICA (SS+Medicare) and state tax.',
    brackets: [
      { band_from: 0,        band_to: 11925,    rate: 10 },
      { band_from: 11925,    band_to: 48475,    rate: 12 },
      { band_from: 48475,    band_to: 103350,   rate: 22 },
      { band_from: 103350,   band_to: 197300,   rate: 24 },
      { band_from: 197300,   band_to: 250525,   rate: 32 },
      { band_from: 250525,   band_to: 626350,   rate: 35 },
      { band_from: 626350,   band_to: null,     rate: 37 },
    ],
  },

  // Canada — federal, 2025 (provincial tax not included)
  CA: {
    year: '2025',
    notes: 'Federal slabs only. Provincial tax is on top — add as a deduction component if needed.',
    brackets: [
      { band_from: 0,        band_to: 57375,    rate: 15  },
      { band_from: 57375,    band_to: 114750,   rate: 20.5 },
      { band_from: 114750,   band_to: 177882,   rate: 26  },
      { band_from: 177882,   band_to: 253414,   rate: 29  },
      { band_from: 253414,   band_to: null,     rate: 33  },
    ],
  },

  // Australia — 2024-25, resident individuals
  AU: {
    year: '2024-25',
    notes: 'Resident individual rates. Excludes Medicare levy (2%).',
    brackets: [
      { band_from: 0,        band_to: 18200,    rate: 0    },
      { band_from: 18200,    band_to: 45000,    rate: 16   },
      { band_from: 45000,    band_to: 135000,   rate: 30   },
      { band_from: 135000,   band_to: 190000,   rate: 37   },
      { band_from: 190000,   band_to: null,     rate: 45   },
    ],
  },

  // Singapore — resident, YA 2025
  SG: {
    year: '2025',
    notes: 'Resident individual progressive rates.',
    brackets: [
      { band_from: 0,        band_to: 20000,    rate: 0    },
      { band_from: 20000,    band_to: 30000,    rate: 2    },
      { band_from: 30000,    band_to: 40000,    rate: 3.5  },
      { band_from: 40000,    band_to: 80000,    rate: 7    },
      { band_from: 80000,    band_to: 120000,   rate: 11.5 },
      { band_from: 120000,   band_to: 160000,   rate: 15   },
      { band_from: 160000,   band_to: 200000,   rate: 18   },
      { band_from: 200000,   band_to: 240000,   rate: 19   },
      { band_from: 240000,   band_to: 280000,   rate: 19.5 },
      { band_from: 280000,   band_to: 320000,   rate: 20   },
      { band_from: 320000,   band_to: 500000,   rate: 22   },
      { band_from: 500000,   band_to: 1000000,  rate: 23   },
      { band_from: 1000000,  band_to: null,     rate: 24   },
    ],
  },

  // Malaysia — resident, YA 2024
  MY: {
    year: '2024',
    notes: 'Resident individual rates.',
    brackets: [
      { band_from: 0,        band_to: 5000,     rate: 0  },
      { band_from: 5000,     band_to: 20000,    rate: 1  },
      { band_from: 20000,    band_to: 35000,    rate: 3  },
      { band_from: 35000,    band_to: 50000,    rate: 6  },
      { band_from: 50000,    band_to: 70000,    rate: 11 },
      { band_from: 70000,    band_to: 100000,   rate: 19 },
      { band_from: 100000,   band_to: 400000,   rate: 25 },
      { band_from: 400000,   band_to: 600000,   rate: 26 },
      { band_from: 600000,   band_to: 2000000,  rate: 28 },
      { band_from: 2000000,  band_to: null,     rate: 30 },
    ],
  },

  // Bangladesh — individuals, FY 2024-25
  BD: {
    year: '2024-25',
    notes: 'Individual taxpayer (general). Excludes investment rebate.',
    brackets: [
      { band_from: 0,        band_to: 350000,   rate: 0  },
      { band_from: 350000,   band_to: 450000,   rate: 5  },
      { band_from: 450000,   band_to: 850000,   rate: 10 },
      { band_from: 850000,   band_to: 1350000,  rate: 15 },
      { band_from: 1350000,  band_to: 1850000,  rate: 20 },
      { band_from: 1850000,  band_to: null,     rate: 25 },
    ],
  },

  // Germany — simplified single filer, 2025
  // German tax uses a formula (Einkommensteuertarif), this approximates with bands.
  DE: {
    year: '2025',
    notes: 'Approximate progressive bands for single filer. Real calc uses a continuous formula.',
    brackets: [
      { band_from: 0,        band_to: 12096,    rate: 0    },
      { band_from: 12096,    band_to: 17443,    rate: 14   },
      { band_from: 17443,    band_to: 68480,    rate: 24   },
      { band_from: 68480,    band_to: 277825,   rate: 42   },
      { band_from: 277825,   band_to: null,     rate: 45   },
    ],
  },

  // France — single filer, 2025
  FR: {
    year: '2025',
    notes: 'Single filer (1 part). Family quotient simplifies to 1 here.',
    brackets: [
      { band_from: 0,        band_to: 11497,    rate: 0  },
      { band_from: 11497,    band_to: 29315,    rate: 11 },
      { band_from: 29315,    band_to: 83823,    rate: 30 },
      { band_from: 83823,    band_to: 180294,   rate: 41 },
      { band_from: 180294,   band_to: null,     rate: 45 },
    ],
  },

  // Zero-income-tax jurisdictions
  AE: { year: '2025', notes: 'UAE has no personal income tax for residents.',
        brackets: [{ band_from: 0, band_to: null, rate: 0 }] },
  SA: { year: '2025', notes: 'Saudi Arabia has no personal income tax for residents.',
        brackets: [{ band_from: 0, band_to: null, rate: 0 }] },
  QA: { year: '2025', notes: 'Qatar has no personal income tax for residents.',
        brackets: [{ band_from: 0, band_to: null, rate: 0 }] },
  KW: { year: '2025', notes: 'Kuwait has no personal income tax for residents.',
        brackets: [{ band_from: 0, band_to: null, rate: 0 }] },
  BH: { year: '2025', notes: 'Bahrain has no personal income tax for residents.',
        brackets: [{ band_from: 0, band_to: null, rate: 0 }] },
  OM: { year: '2025', notes: 'Oman has no personal income tax for residents.',
        brackets: [{ band_from: 0, band_to: null, rate: 0 }] },
};

function hasPreset(countryCode) {
  return Boolean(PRESETS[countryCode]);
}

function getPreset(countryCode) {
  return PRESETS[countryCode] || null;
}

function listSupportedCountries() {
  return Object.keys(PRESETS).sort();
}

// Progressive tax engine — given an annual taxable income and a list of
// bracket rows (in order), returns total tax owed.
function calculateTax(income, brackets) {
  if (!Array.isArray(brackets) || brackets.length === 0) return 0;
  let tax = 0;
  for (const b of brackets) {
    const from = Number(b.band_from) || 0;
    const to   = b.band_to == null ? Infinity : Number(b.band_to);
    if (income <= from) break;
    const taxableInBand = Math.min(income, to) - from;
    tax += (taxableInBand * Number(b.rate)) / 100;
  }
  return Math.round(tax * 100) / 100;
}

module.exports = { PRESETS, hasPreset, getPreset, listSupportedCountries, calculateTax };
