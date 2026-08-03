// Node unit tests for the THREE-way Shopify marketing-consent mapping (2026-08-03, S258).
//
// Bug: mapCustomerRest mapped `undefined` (field absent from the webhook payload) and
// `NOT_SUBSCRIBED` (a real Shopify state) to the SAME `unknown`, then wrote a consent row
// either way. So an absent field fabricated a consent record out of no data.
//
// Live evidence: the customers/* webhook path had produced 39,467 marketing consent rows and
// 100.0% were `unknown` — zero opted_in, zero opted_out, ever — while the GraphQL import path,
// which requests the field explicitly, ran at 4.8% (email) / 10.7% (whatsapp) unknown with real
// states on both sides. With ~94% of import-path customers opted_in, zero knowns across 19,485
// webhook draws is not a customer-behaviour result: the field is not being delivered.
// 1,810 email + 1,622 whatsapp profiles ended up with NO known marketing state as a result.
//
// Policy:
//   · recognised state              → opted_in / opted_out, evidence records the raw string
//   · real but unmapped state       → `unknown` + evidence (information: they are not subscribed)
//   · field absent from the payload → NO marketing consent row at all
// The transactional row is OUR standing basis for order mail, not a Shopify-reported state, so
// it is unconditional and must survive the guard.
//
// Run: node test/shopify-consent-field.test.js   (Node 18+)

const assert = require('assert');
const { mapCustomerRest, mapCustomer } = require('../src/shopify.js');

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('  ok  ', n); }
                      catch (e) { fail++; console.log('  FAIL', n, '\n        ', e.message); } };

const mkt = (rows) => rows.filter((r) => r.purpose === 'marketing');
const byChannel = (rows, ch) => mkt(rows).find((r) => r.channel === ch) || null;

console.log('\nmapCustomerRest — webhook payload (the broken path)');

t('absent email_marketing_consent writes NO marketing row', () => {
  const c = mapCustomerRest({ id: 1, email: 'a@b.com', created_at: '2026-08-01T00:00:00Z' }).consent;
  assert.strictEqual(byChannel(c, 'email'), null, 'should not fabricate a marketing row');
});

t('absent field still writes the transactional row', () => {
  const c = mapCustomerRest({ id: 1, email: 'a@b.com', created_at: '2026-08-01T00:00:00Z' }).consent;
  const tx = c.find((r) => r.purpose === 'transactional');
  assert.ok(tx, 'transactional row must survive');
  assert.strictEqual(tx.state, 'opted_in');
});

t('present state=subscribed maps to opted_in + evidence', () => {
  const c = mapCustomerRest({ id: 1, email: 'a@b.com',
    email_marketing_consent: { state: 'subscribed', consent_updated_at: '2026-07-01T00:00:00Z' } }).consent;
  const row = byChannel(c, 'email');
  assert.strictEqual(row.state, 'opted_in');
  assert.deepStrictEqual(row.evidence, { shopify_state: 'subscribed' });
  assert.strictEqual(row.captured_at, '2026-07-01T00:00:00Z');
});

t('present state=unsubscribed maps to opted_out', () => {
  const c = mapCustomerRest({ id: 1, email: 'a@b.com',
    email_marketing_consent: { state: 'unsubscribed' } }).consent;
  assert.strictEqual(byChannel(c, 'email').state, 'opted_out');
});

t('present but unmapped state=not_subscribed still records unknown + evidence', () => {
  const c = mapCustomerRest({ id: 1, email: 'a@b.com',
    email_marketing_consent: { state: 'not_subscribed' } }).consent;
  const row = byChannel(c, 'email');
  assert.strictEqual(row.state, 'unknown', 'a real state is information, keep it');
  assert.deepStrictEqual(row.evidence, { shopify_state: 'not_subscribed' });
});

t('null state is treated as absent, not as unknown', () => {
  const c = mapCustomerRest({ id: 1, email: 'a@b.com',
    email_marketing_consent: { state: null } }).consent;
  assert.strictEqual(byChannel(c, 'email'), null);
});

t('absent sms_marketing_consent writes NO whatsapp row', () => {
  const c = mapCustomerRest({ id: 1, phone: '+919876543210' }).consent;
  assert.strictEqual(byChannel(c, 'whatsapp'), null);
});

t('present sms state maps whatsapp + evidence', () => {
  const c = mapCustomerRest({ id: 1, phone: '+919876543210',
    sms_marketing_consent: { state: 'SUBSCRIBED' } }).consent;
  const row = byChannel(c, 'whatsapp');
  assert.strictEqual(row.state, 'opted_in');
  assert.deepStrictEqual(row.evidence, { shopify_state: 'SUBSCRIBED' });
});

console.log('\nmapCustomer — GraphQL import path (deliberately UNCHANGED behaviour)');

t('import still writes unknown when the state is unmapped', () => {
  const c = mapCustomer({ id: 'gid://shopify/Customer/1', email: 'a@b.com',
    emailMarketingConsent: { marketingState: 'NOT_SUBSCRIBED' } }).consent;
  const row = byChannel(c, 'email');
  assert.strictEqual(row.state, 'unknown');
  assert.deepStrictEqual(row.evidence, { shopify_state: 'NOT_SUBSCRIBED' });
});

t('import still writes a row even when the field is absent (unchanged)', () => {
  const c = mapCustomer({ id: 'gid://shopify/Customer/1', email: 'a@b.com' }).consent;
  const row = byChannel(c, 'email');
  assert.ok(row, 'import path must keep its existing behaviour');
  assert.strictEqual(row.state, 'unknown');
  assert.strictEqual(row.evidence, undefined, 'no raw state to record');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
