const fs = require('fs');
const path = require('path');
// Local English-only helpers (i18n module was removed). If/when we re-add
// localization, these become call sites for a new t()/formatter layer.
const formatCurrency = (n, currency) => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: currency || 'USD', maximumFractionDigits: 0,
}).format(Number(n) || 0);
const formatDate   = (date) => new Intl.DateTimeFormat('en-US', {
  year: 'numeric', month: 'short', day: 'numeric',
}).format(date instanceof Date ? date : new Date(date));
const formatNumber = (n) => new Intl.NumberFormat('en-US').format(Number(n) || 0);

// ─────────────────────────────────────────────────────────────────────────────
// Server-side PDF generation via Puppeteer.
//
// Why Puppeteer (not jsPDF):
//   - CJK glyph coverage. Japanese/Chinese/Korean names render as □□□ in
//     jsPDF without manually bundling 5-15MB TTF files per script. Chrome
//     handles fonts natively as long as they're installed in the image,
//     and the Dockerfile installs font-noto-cjk (Noto Sans JP / SC / KR
//     in one Alpine package).
//   - HTML templating beats jsPDF's imperative `doc.text(x, y, ...)` API
//     by a wide margin for tenant-branded slips.
//   - Pixel-perfect, deterministic rendering across machines.
//
// Trade-off: spawn a Chrome instance per render. We use a singleton browser
// kept alive and just open/close pages, which keeps memory bounded
// (~300MB resident) and per-PDF time around 400ms.
// ─────────────────────────────────────────────────────────────────────────────

let _browser = null;
let _launching = null;

async function getBrowser() {
  if (_browser && _browser.connected !== false) return _browser;
  if (_launching) return _launching;

  const puppeteer = require('puppeteer-core');
  const execPath = (process.env.PUPPETEER_EXECUTABLE_PATH || '').trim()
    || '/usr/bin/chromium-browser'; // alpine default after apk add chromium

  _launching = puppeteer.launch({
    executablePath: execPath,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--font-render-hinting=none',
    ],
  }).then(b => {
    _browser = b;
    b.on('disconnected', () => { _browser = null; });
    _launching = null;
    return b;
  }).catch(e => {
    _launching = null;
    throw e;
  });

  return _launching;
}

// renderHtmlToPdf(html, options?) — converts an HTML string into a PDF
// Buffer. The HTML should be a complete document with all CSS inline.
async function renderHtmlToPdf(html, options = {}) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 });
    const pdf = await page.pdf({
      format: options.format || 'A4',
      printBackground: true,
      margin: options.margin || { top: '15mm', right: '12mm', bottom: '15mm', left: '12mm' },
      ...options,
    });
    return pdf;
  } finally {
    // Close the page (not the browser) so the next render can reuse it.
    await page.close().catch(() => {});
  }
}

// Tiny template engine — replaces {{ key }} with values. Keeps PDF
// templates dependency-free. Conditional `{{#if name}}...{{/if}}` blocks
// are also supported for optional fields.
function render(template, vars) {
  let out = template;
  // Conditionals first (so the variable substitution doesn't break inside them)
  out = out.replace(/\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, name, body) =>
    vars[name] ? body : ''
  );
  // Variables
  out = out.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) =>
    vars[name] != null ? String(vars[name]) : ''
  );
  return out;
}

const SALARY_SLIP_TEMPLATE = fs.readFileSync(
  path.join(__dirname, '..', 'templates', 'salary-slip.html'),
  'utf8'
);

// generateSalarySlipPdf({ employee, slip, settings }) → Buffer
//
// English-only output for now. The CJK fonts (Noto Sans JP/SC/KR) are still
// embedded in the HTML template so non-Latin employee names render
// correctly; only the LABEL strings are English.
async function generateSalarySlipPdf({ employee, slip, settings }) {
  const currency = settings?.currency || 'USD';
  const month = slip?.month || '';
  const money = (n) => formatCurrency(Number(n) || 0, currency);

  // Compose earnings/deductions rows from the slip object.
  const earnings = (slip?.earnings || []).map(e => ({
    label:  e.name || e.label || '',
    amount: money(e.amount),
  }));
  const deductions = (slip?.deductions || []).map(d => ({
    label:  d.name || d.label || '',
    amount: money(d.amount),
  }));

  const html = render(SALARY_SLIP_TEMPLATE, {
    LOCALE:           'en',
    BRAND_NAME:       settings?.company_name || settings?.brand_name || 'Tickin',
    SLIP_TITLE:       settings?.slip_title || 'Salary Slip',
    LABEL_EMPLOYEE:   'Employee Name',
    LABEL_DESIG:      'Designation',
    LABEL_DEPT:       'Department',
    LABEL_EMPCODE:    'Employee Code',
    LABEL_MONTH:      'Month',
    LABEL_DAYS:       'Days Worked',
    LABEL_EARNINGS:   'Earnings',
    LABEL_DEDUCTIONS: 'Deductions',
    LABEL_GROSS:      'Gross Salary',
    LABEL_NET:        'Net Salary',
    LABEL_TOTAL_DED:  'Total Deductions',
    LABEL_CONFIDENTIAL: 'Confidential',
    LABEL_GENERATED:  `Generated on ${formatDate(new Date())}`,

    EMP_NAME:    employee?.name || '',
    EMP_DESIG:   employee?.role || '',
    EMP_DEPT:    employee?.department || '',
    EMP_CODE:    employee?.emp_code || '—',
    SLIP_MONTH:  month,
    DAYS_WORKED: formatNumber(slip?.days_worked ?? slip?.days_paid ?? 0),

    // calculateSlip returns total_earnings / net; accept both shapes so the slip
    // never renders Gross/Net as 0 (was reading non-existent gross_salary/net_salary).
    GROSS:           money(slip?.gross_salary ?? slip?.total_earnings ?? 0),
    NET:             money(slip?.net_salary   ?? slip?.net           ?? 0),
    TOTAL_DEDUCT:    money(slip?.total_deductions ?? 0),

    EARNINGS_ROWS:   earnings.map(r => `<tr><td>${r.label}</td><td class="amt">${r.amount}</td></tr>`).join(''),
    DEDUCTION_ROWS:  deductions.map(r => `<tr><td>${r.label}</td><td class="amt">${r.amount}</td></tr>`).join(''),
  });

  return renderHtmlToPdf(html);
}

module.exports = { renderHtmlToPdf, generateSalarySlipPdf, getBrowser };
