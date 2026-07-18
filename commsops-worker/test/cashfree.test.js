// Node unit tests for the Cashfree payment-link seam (J3).
// Run: node test/cashfree.test.js   (Node 18+ — uses global crypto.subtle / btoa).
// Pure + one mocked-fetch test; no real network.
const assert = require('assert');
const CF = require('../src/cashfree.js');

let pass = 0, fail = 0;
const queue = [];
function t(name, fn) { queue.push([name, fn]); }  // collected, run sequentially below
async function run() {
  for (const [name, fn] of queue) {
    try { await fn(); pass++; console.log('  ok  ', name); }
    catch (e) { fail++; console.log('  FAIL', name, '\n        ', e.message); }
  }
}

// ── config gate / base url ──
t('isConfigured false without keys', () => {
  assert.strictEqual(CF.isConfigured({}), false);
  assert.strictEqual(CF.isConfigured({ CASHFREE_CLIENT_ID: 'x' }), false);
  assert.strictEqual(CF.isConfigured({ CASHFREE_CLIENT_ID: 'x', CASHFREE_CLIENT_SECRET: 'y' }), true);
});
t('baseUrl defaults to sandbox; production only on explicit env', () => {
  assert.strictEqual(CF.baseUrl({}), 'https://sandbox.cashfree.com');
  assert.strictEqual(CF.baseUrl({ CASHFREE_ENV: 'sandbox' }), 'https://sandbox.cashfree.com');
  assert.strictEqual(CF.baseUrl({ CASHFREE_ENV: 'production' }), 'https://api.cashfree.com');
  assert.strictEqual(CF.baseUrl({ CASHFREE_ENV: 'PRODUCTION' }), 'https://api.cashfree.com');
});

// ── createPaymentLink: inert + validation ──
t('createPaymentLink inert when unconfigured', async () => {
  const r = await CF.createPaymentLink({}, { amount: 100, phone: '9000000000' });
  assert.deepStrictEqual(r, { ok: false, error: 'cashfree_not_configured' });
});
t('createPaymentLink requires phone + positive amount', async () => {
  const env = { CASHFREE_CLIENT_ID: 'id', CASHFREE_CLIENT_SECRET: 'sec' };
  assert.strictEqual((await CF.createPaymentLink(env, { amount: 100 })).error, 'customer_phone_required');
  assert.strictEqual((await CF.createPaymentLink(env, { phone: '9000000000' })).error, 'link_amount_required');
  assert.strictEqual((await CF.createPaymentLink(env, { phone: '9000000000', amount: 0 })).error, 'link_amount_required');
});

// ── createPaymentLink: request shaping (mocked fetch) ──
t('createPaymentLink shapes headers + body + returns link', async () => {
  const env = { CASHFREE_CLIENT_ID: 'id-123', CASHFREE_CLIENT_SECRET: 'sec-456', CASHFREE_ENV: 'sandbox' };
  let captured = null;
  const orig = global.fetch;
  global.fetch = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, status: 200, text: async () => JSON.stringify({
      cf_link_id: 'CF_1', link_id: 'relay-e1-s2', link_url: 'https://payments.cashfree.com/links/xyz', link_status: 'ACTIVE',
    }) };
  };
  try {
    const r = await CF.createPaymentLink(env, {
      amount: 1999, phone: '9876543210', email: 'A@B.com', name: 'Riya',
      purpose: 'Order #40582 — pay to convert to prepaid',
      linkId: 'relay:e1/s2', notes: { order_id: '40582', enrolment: 'e1' },
      notifyUrl: 'https://commsops.afshaan.workers.dev/webhook/cashfree',
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.link_url, 'https://payments.cashfree.com/links/xyz');
    assert.strictEqual(r.cf_link_id, 'CF_1');
    // URL = sandbox base + /pg/links
    assert.strictEqual(captured.url, 'https://sandbox.cashfree.com/pg/links');
    const h = captured.opts.headers;
    assert.strictEqual(h['x-client-id'], 'id-123');
    assert.strictEqual(h['x-client-secret'], 'sec-456');
    assert.strictEqual(h['x-api-version'], CF.CF_API_VERSION);
    // linkId sanitized ([^A-Za-z0-9_-] → '-') and mirrored to x-idempotency-key
    assert.strictEqual(h['x-idempotency-key'], 'relay-e1-s2');
    const b = JSON.parse(captured.opts.body);
    assert.strictEqual(b.link_id, 'relay-e1-s2');
    assert.strictEqual(b.link_amount, 1999);
    assert.strictEqual(b.link_currency, 'INR');
    assert.strictEqual(b.customer_details.customer_phone, '+919876543210'); // normalized
    assert.strictEqual(b.customer_details.customer_email, 'a@b.com');       // lowercased
    assert.strictEqual(b.customer_details.customer_name, 'Riya');
    // native notify suppressed by default (we send the link ourselves)
    assert.deepStrictEqual(b.link_notify, { send_sms: false, send_email: false });
    assert.deepStrictEqual(b.link_notes, { order_id: '40582', enrolment: 'e1' });
    assert.strictEqual(b.link_meta.notify_url, 'https://commsops.afshaan.workers.dev/webhook/cashfree');
  } finally { global.fetch = orig; }
});
t('createPaymentLink defaults link_meta.notify_url to our own webhook', async () => {
  const env = { CASHFREE_CLIENT_ID: 'id', CASHFREE_CLIENT_SECRET: 'sec' };
  let captured = null;
  const orig = global.fetch;
  global.fetch = async (url, opts) => { captured = opts; return { ok: true, status: 200, text: async () => '{}' }; };
  try {
    await CF.createPaymentLink(env, { amount: 10, phone: '9000000000' });
    const b = JSON.parse(captured.body);
    assert.strictEqual(b.link_meta.notify_url, 'https://commsops.afshaan.workers.dev/webhook/cashfree');
  } finally { global.fetch = orig; }
});
t('createPaymentLink honours PUBLIC_BASE_URL + explicit notifyUrl', async () => {
  const orig = global.fetch;
  global.fetch = async (url, opts) => { global.__b = JSON.parse(opts.body); return { ok: true, status: 200, text: async () => '{}' }; };
  try {
    await CF.createPaymentLink({ CASHFREE_CLIENT_ID: 'i', CASHFREE_CLIENT_SECRET: 's', PUBLIC_BASE_URL: 'https://x.dev' }, { amount: 10, phone: '9000000000' });
    assert.strictEqual(global.__b.link_meta.notify_url, 'https://x.dev/webhook/cashfree');
    await CF.createPaymentLink({ CASHFREE_CLIENT_ID: 'i', CASHFREE_CLIENT_SECRET: 's' }, { amount: 10, phone: '9000000000', notifyUrl: 'https://y.dev/hook' });
    assert.strictEqual(global.__b.link_meta.notify_url, 'https://y.dev/hook');
  } finally { global.fetch = orig; delete global.__b; }
});
t('createPaymentLink surfaces a Cashfree error body', async () => {
  const env = { CASHFREE_CLIENT_ID: 'id', CASHFREE_CLIENT_SECRET: 'sec' };
  const orig = global.fetch;
  global.fetch = async () => ({ ok: false, status: 409, text: async () => JSON.stringify({ message: 'link_id already exists', code: 'link_ids_duplicate' }) });
  try {
    const r = await CF.createPaymentLink(env, { amount: 10, phone: '9000000000', linkId: 'dup' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.error, 'link_id already exists');
  } finally { global.fetch = orig; }
});

// ── webhook signature verify ──
t('verifyWebhook accepts a correct signature, rejects tampering', async () => {
  const env = { CASHFREE_CLIENT_SECRET: 'whsecret' };
  const ts = '1737200000000';
  const raw = JSON.stringify({ type: 'PAYMENT_LINK_EVENT', data: { link_status: 'PAID' } });
  const sig = await CF.computeSignature('whsecret', ts, raw);
  assert.strictEqual(await CF.verifyWebhook(env, ts, raw, sig), true);
  assert.strictEqual(await CF.verifyWebhook(env, ts, raw + ' ', sig), false); // body tampered
  assert.strictEqual(await CF.verifyWebhook(env, ts + '1', raw, sig), false); // ts tampered
  assert.strictEqual(await CF.verifyWebhook(env, ts, raw, 'AAAA'), false);    // wrong sig
  assert.strictEqual(await CF.verifyWebhook({}, ts, raw, sig), false);        // no secret
  assert.strictEqual(await CF.verifyWebhook(env, ts, raw, ''), false);        // no sig
});

// ── webhook → /ingest mapping ──
const PAID = {
  type: 'PAYMENT_LINK_EVENT', event_time: '2026-07-19T10:00:00+05:30',
  data: { link_id: 'relay-e1-s2', cf_link_id: 'CF_1', link_status: 'PAID',
    link_amount: 1999, link_amount_paid: 1999, link_currency: 'INR', link_purpose: 'Order #40582',
    link_notes: { order_id: '40582', enrolment: 'e1' },
    customer_details: { customer_phone: '9876543210', customer_email: 'Riya@B.com', customer_name: 'Riya' } },
};
t('mapPaymentLinkEvent PAID → payment_link_paid envelope', () => {
  const e = CF.mapPaymentLinkEvent(PAID);
  assert.strictEqual(e.name, 'payment_link_paid');
  assert.strictEqual(e.source, 'cashfree');
  assert.strictEqual(e.idempotency_key, 'cashfree:link:relay-e1-s2:PAID');
  assert.deepStrictEqual(e.identifiers.find(i => i.type === 'phone').value, '+919876543210');
  assert.strictEqual(e.identifiers.find(i => i.type === 'email').value, 'riya@b.com');
  assert.strictEqual(e.properties.link_amount_paid, 1999);
  assert.deepStrictEqual(e.properties.link_notes, { order_id: '40582', enrolment: 'e1' });
  assert.strictEqual(e.occurred_at, '2026-07-19T10:00:00+05:30');
});
t('mapPaymentLinkEvent reads nested data.link too', () => {
  const nested = { type: 'PAYMENT_LINK_EVENT', data: { link: { ...PAID.data } } };
  const e = CF.mapPaymentLinkEvent(nested);
  assert.strictEqual(e.name, 'payment_link_paid');
  assert.strictEqual(e.properties.link_id, 'relay-e1-s2');
});
t('mapPaymentLinkEvent EXPIRED/CANCELLED → payment_link_failed', () => {
  for (const s of ['EXPIRED', 'CANCELLED', 'USER_DROPPED']) {
    const e = CF.mapPaymentLinkEvent({ type: 'PAYMENT_LINK_EVENT', data: { ...PAID.data, link_status: s } });
    assert.strictEqual(e.name, 'payment_link_failed', s);
    assert.strictEqual(e.idempotency_key, `cashfree:link:relay-e1-s2:${s}`);
  }
});
t('mapPaymentLinkEvent non-terminal status → null (captured, not emitted)', () => {
  assert.strictEqual(CF.mapPaymentLinkEvent({ type: 'PAYMENT_LINK_EVENT', data: { ...PAID.data, link_status: 'ACTIVE' } }), null);
  assert.strictEqual(CF.mapPaymentLinkEvent({ type: 'PAYMENT_LINK_EVENT', data: { ...PAID.data, link_status: 'PARTIALLY_PAID' } }), null);
});
t('mapPaymentLinkEvent no identity → null', () => {
  const e = CF.mapPaymentLinkEvent({ type: 'PAYMENT_LINK_EVENT', data: { ...PAID.data, customer_details: {} } });
  assert.strictEqual(e, null);
});

run().then(() => {
  console.log(`\ncashfree: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
});
