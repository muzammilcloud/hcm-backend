#!/usr/bin/env node
// Diagnose Polar billing config: which configured price/product IDs are ARCHIVED
// (and thus break checkout / plan switching), and which active products exist to
// point them at. Read-only.
//
//   POLAR_ACCESS_TOKEN=... POLAR_ENV=production POLAR_ORG_ID=... \
//   POLAR_STARTER_MONTHLY_PRICE_ID=... [etc] node scripts/check-polar.js
//
// Add --unarchive=<productId> to un-archive a specific product (write).

const { PRICE_IDS, ADDON_PRICE_IDS } = require('../lib/polarConstants');

const TOKEN = process.env.POLAR_ACCESS_TOKEN;
const ENV   = (process.env.POLAR_ENV || 'sandbox').toLowerCase();
const ORG   = process.env.POLAR_ORG_ID;
const HOST  = ENV === 'production' ? 'https://api.polar.sh' : 'https://sandbox-api.polar.sh';

if (!TOKEN) { console.error('Missing POLAR_ACCESS_TOKEN.'); process.exit(1); }

const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

async function listProducts() {
  const out = [];
  for (const archived of [false, true]) {
    let url = `${HOST}/v1/products?is_archived=${archived}&limit=100` + (ORG ? `&organization_id=${ORG}` : '');
    while (url) {
      const r = await fetch(url, { headers: H });
      if (!r.ok) { console.error(`Polar API ${r.status} on ${url}:`, await r.text()); process.exit(1); }
      const j = await r.json();
      for (const p of (j.items || [])) out.push({ id: p.id, name: p.name, archived: !!p.is_archived });
      url = j.pagination?.max_page && j.pagination.max_page > 1 ? null : null; // single page (limit 100) is enough here
    }
  }
  return out;
}

async function unarchive(id) {
  const r = await fetch(`${HOST}/v1/products/${id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ is_archived: false }) });
  console.log(r.ok ? `✅ Un-archived ${id}` : `❌ Failed (${r.status}): ${await r.text()}`);
}

(async () => {
  const unarchiveArg = (process.argv.find(a => a.startsWith('--unarchive=')) || '').split('=')[1];
  if (unarchiveArg) return unarchive(unarchiveArg);

  const products = await listProducts();
  const byId = Object.fromEntries(products.map(p => [p.id, p]));

  const configured = [];
  for (const [tier, cycles] of Object.entries(PRICE_IDS)) for (const [cycle, id] of Object.entries(cycles)) if (id) configured.push({ envVar: `POLAR_${tier.toUpperCase()}_${cycle.toUpperCase()}_PRICE_ID`, id });
  for (const [addon, cycles] of Object.entries(ADDON_PRICE_IDS || {})) for (const [cycle, id] of Object.entries(cycles)) if (id) configured.push({ envVar: `addon ${addon}/${cycle}`, id });

  console.log(`\nPolar env: ${ENV}  ·  ${products.length} product(s) in the org\n`);
  console.log('CONFIGURED IDs:');
  let bad = 0;
  for (const c of configured) {
    const p = byId[c.id];
    const state = !p ? '❓ NOT FOUND in this org/env' : p.archived ? '🔴 ARCHIVED — breaks checkout' : '✅ active';
    if (!p || p.archived) bad++;
    console.log(`  ${state}  ${c.envVar} = ${c.id}${p ? `  (${p.name})` : ''}`);
  }
  console.log('\nACTIVE products you can point env vars at:');
  for (const p of products.filter(p => !p.archived)) console.log(`  ${p.id}  ${p.name}`);
  console.log(bad ? `\n→ ${bad} configured ID(s) need fixing. Un-archive with: node scripts/check-polar.js --unarchive=<productId>\n` : '\n✅ All configured IDs are active.\n');
})().catch(e => { console.error(e); process.exit(1); });
