const fs = require('fs');
const path = require('path');
const { t, formatCurrency, formatDate, formatNumber } = require('./i18n');

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

// generateSalarySlipPdf({ employee, slip, settings, locale }) → Buffer
//
// `locale` is the RECIPIENT'S preferred locale (employee.preferred_locale),
// not the requester's. A Japanese employee's slip renders in Japanese with
// Noto Sans JP whether the admin downloading it is in en or de.
async function generateSalarySlipPdf({ employee, slip, settings, locale }) {
  const L = locale || 'en';
  const currency = settings?.currency || 'USD';
  const month = slip?.month || '';

  const tt = (key, vars) => t(L, `pdf.salarySlip.${key}`, vars);
  const money = (n) => formatCurrency(L, Number(n) || 0, currency);

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
    LOCALE:           L,
    BRAND_NAME:       settings?.company_name || settings?.brand_name || 'Tickin',
    SLIP_TITLE:       settings?.slip_title || tt('title'),
    LABEL_EMPLOYEE:   tt('employeeName'),
    LABEL_DESIG:      tt('designation'),
    LABEL_DEPT:       tt('department'),
    LABEL_EMPCODE:    tt('empCode'),
    LABEL_MONTH:      tt('month'),
    LABEL_DAYS:       tt('daysWorked'),
    LABEL_EARNINGS:   tt('earnings'),
    LABEL_DEDUCTIONS: tt('deductions'),
    LABEL_GROSS:      tt('grossSalary'),
    LABEL_NET:        tt('netSalary'),
    LABEL_TOTAL_DED:  tt('totalDeductions'),
    LABEL_CONFIDENTIAL: tt('confidential'),
    LABEL_GENERATED:  tt('generatedOn', { date: formatDate(L, new Date()) }),

    EMP_NAME:    employee?.name || '',
    EMP_DESIG:   employee?.role || '',
    EMP_DEPT:    employee?.department || '',
    EMP_CODE:    employee?.emp_code || '—',
    SLIP_MONTH:  month,
    DAYS_WORKED: formatNumber(L, slip?.days_worked || 0),

    GROSS:           money(slip?.gross_salary || 0),
    NET:             money(slip?.net_salary || 0),
    TOTAL_DEDUCT:    money(slip?.total_deductions || 0),

    EARNINGS_ROWS:   earnings.map(r => `<tr><td>${r.label}</td><td class="amt">${r.amount}</td></tr>`).join(''),
    DEDUCTION_ROWS:  deductions.map(r => `<tr><td>${r.label}</td><td class="amt">${r.amount}</td></tr>`).join(''),
  });

  return renderHtmlToPdf(html);
}

module.exports = { renderHtmlToPdf, generateSalarySlipPdf, getBrowser };
