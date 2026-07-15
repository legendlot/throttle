// Signed end-to-end smoke test against the live deliveryops worker.
// Run: APP_PROXY_SECRET='<the SHOPIFY_APP_PROXY_SECRET you set>' node smoke.mjs
// The secret stays local (used only to sign, like Shopify's App Proxy does). Nothing is sent anywhere but the worker.
import crypto from 'node:crypto';

const WORKER = 'https://deliveryops.afshaan.workers.dev';
const secret = process.env.APP_PROXY_SECRET;
if (!secret) { console.error('Set APP_PROXY_SECRET first (the same value you put into wrangler).'); process.exit(1); }

// Build the exact message the worker verifies: params (minus signature) sorted by key,
// each key=value (multi-values joined by ","), concatenated with no separator; HMAC-SHA256 hex.
function sign(params) {
  const msg = Object.keys(params).sort().map(k => `${k}=${[].concat(params[k]).join(',')}`).join('');
  return crypto.createHmac('sha256', secret).update(msg).digest('hex');
}

async function check(label, params) {
  const signature = sign(params);
  const qs = new URLSearchParams({ ...params, signature });
  const res = await fetch(`${WORKER}/?${qs}`, { headers: { Accept: 'application/json' } });
  const body = await res.text();
  console.log(`${label.padEnd(28)} ${res.status}  ${body}`);
}

const cases = [
  ['560001 Bangalore (local)', { pincode: '560001' }],
  ['400001 Mumbai',            { pincode: '400001' }],
  ['110001 Delhi',             { pincode: '110001' }],
  ['781136 Assam (far)',       { pincode: '781136' }],
  ['400001 Mumbai COD',        { pincode: '400001', cod: '1' }],
  ['999999 (likely no-serve)', { pincode: '999999' }],
];
console.log('--- signed requests to', WORKER, '---');
for (const [label, params] of cases) { await check(label, params); }
