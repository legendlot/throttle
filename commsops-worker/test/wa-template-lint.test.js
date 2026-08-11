// Pre-submit lint — every rule here is a rejection we have already paid for, or a published
// Meta limit. Run: node test/wa-template-lint.test.js
//
// The point of this gate is that Meta allows ONE edit per active template per 24h, and its
// rejections are usually a bare "Invalid parameter". Catching a mistake here costs nothing;
// catching it at Meta costs a day.

const assert = require('assert');
const { lintWaTemplate } = require('../src/wa-template-lint.js');

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('  ok  ', n); }
  catch (e) { fail++; console.log('  FAIL', n, '\n        ', e.message); } };

// A template that should lint clean — the shape all 8 C2P drafts follow.
const good = (o = {}) => Object.assign({
  meta_name: 'lot_c2p_confirmed_01',
  language: 'en',
  category: 'UTILITY',
  waba_id: '1734668990887383',
  body: 'Hi {{1}},\n\nYour order #{{2}} is confirmed for Cash on Delivery.\n\nThank you for shopping with L.O.T.',
  footer: 'Legend of Toys',
  mapping: [
    { pos: 1, token: 'first_name', example: 'Rahul', component: 'body' },
    { pos: 2, token: 'order_number', example: '43269', component: 'body' },
  ],
}, o);

const codes = (r) => r.errors.map((e) => e.code);

t('a well-formed utility template lints CLEAN', () => {
  const r = lintWaTemplate(good());
  assert.ok(r.ok, 'expected ok, got: ' + JSON.stringify(r.errors));
});

// ── the rule that cost a real review round-trip ──────────────────────────────────────
t('body ENDING in a placeholder is caught (the lot_checkout_abandoned_02 rejection)', () => {
  const r = lintWaTemplate(good({ body: 'Your order is confirmed, {{1}}' }));
  assert.ok(codes(r).includes('body_ends_with_placeholder'));
});

t('body STARTING with a placeholder is caught', () => {
  const r = lintWaTemplate(good({ body: '{{1}}, your order #{{2}} is confirmed. Thanks!' }));
  assert.ok(codes(r).includes('body_starts_with_placeholder'));
});

t('adjacent placeholders are caught', () => {
  const r = lintWaTemplate(good({ body: 'Hi {{1}} {{2}} your order is confirmed. Thanks!' }));
  assert.ok(codes(r).includes('body_adjacent_placeholders'));
});

t('non-sequential placeholders are caught', () => {
  const r = lintWaTemplate(good({
    body: 'Hi {{1}}, order {{3}} is confirmed. Thanks!',
    mapping: [{ pos: 1, token: 'a', example: 'x', component: 'body' },
              { pos: 2, token: 'b', example: 'y', component: 'body' }],
  }));
  assert.ok(codes(r).includes('body_placeholder_sequence'));
});

// ── mapping ↔ placeholder drift: approved but every SEND fails ───────────────────────
t('mapping count mismatch is caught (would send-fail with #132000 post-approval)', () => {
  const r = lintWaTemplate(good({ mapping: [{ pos: 1, token: 'first_name', example: 'R', component: 'body' }] }));
  assert.ok(codes(r).includes('mapping_count'));
});

t('a variable with no example is caught (Meta requires samples)', () => {
  const r = lintWaTemplate(good({
    mapping: [{ pos: 1, token: 'first_name', example: 'R', component: 'body' },
              { pos: 2, token: 'order_number', component: 'body' }],
  }));
  assert.ok(codes(r).includes('mapping_no_example'));
});

// ── identity / routing ───────────────────────────────────────────────────────────────
t('unpinned waba_id is caught (the S232 dead-WABA bug)', () => {
  const r = lintWaTemplate(good({ waba_id: undefined }));
  assert.ok(codes(r).includes('waba_unpinned'));
});

t('a capitalised / hyphenated meta_name is caught', () => {
  assert.ok(codes(lintWaTemplate(good({ meta_name: 'LOT_C2P_01' }))).includes('name_charset'));
  assert.ok(codes(lintWaTemplate(good({ meta_name: 'lot-c2p-01' }))).includes('name_charset'));
});

t('a bad category is caught; an ABSENT one is fine (derived from purpose)', () => {
  assert.ok(lintWaTemplate(good({ category: undefined })).ok, 'absent category must not block');
  assert.ok(codes(lintWaTemplate(good({ category: 'TRANSACTIONAL' }))).includes('category_invalid'));
});

// ── buttons: the documented dead-link trap ───────────────────────────────────────────
t('a URL button whose {{1}} is NOT trailing is caught (passes review, dead link)', () => {
  const r = lintWaTemplate(good({
    buttons: [{ type: 'URL', text: 'Pay now', url: 'https://x.com/{{1}}/pay', example: 'https://x.com/a/pay' }],
    mapping: [...good().mapping, { component: 'button', index: 0, token: 'link', example: 'abc' }],
  }));
  assert.ok(codes(r).includes('button_var_not_trailing'));
});

t('a URL button with {{1}} but no example is caught', () => {
  // ⚠️ The mapping slot must carry NO `example` — this fixture was copy-pasted from the
  // button_var_not_trailing test above and kept its `example: 'abc'`, which satisfies
  // `hasExample`, so the rule correctly did not fire and this test failed from the day it
  // was written. The RULE was always right; the test was asserting the wrong scenario.
  const r = lintWaTemplate(good({
    buttons: [{ type: 'URL', text: 'Pay now', url: 'https://x.com/pay/{{1}}' }],
    mapping: [...good().mapping, { component: 'button', index: 0, token: 'link' }],
  }));
  assert.ok(codes(r).includes('button_no_example'));
});

t('...and is NOT raised when the example rides on the mapping slot', () => {
  // the other half of the pair, which is what the broken fixture was accidentally testing
  const r = lintWaTemplate(good({
    buttons: [{ type: 'URL', text: 'Pay now', url: 'https://x.com/pay/{{1}}' }],
    mapping: [...good().mapping, { component: 'button', index: 0, token: 'link', example: 'abc' }],
  }));
  assert.ok(!codes(r).includes('button_no_example'));
});

t('a mapping slot against a STATIC url button is caught (S241 send failure)', () => {
  const r = lintWaTemplate(good({
    buttons: [{ type: 'URL', text: 'Track', url: 'https://legendoftoys.com/track' }],
    mapping: [...good().mapping, { component: 'button', index: 0, token: 'link', example: 'abc' }],
  }));
  assert.ok(codes(r).includes('button_mapped_but_static'));
});

t('a valid trailing-variable button lints clean', () => {
  const r = lintWaTemplate(good({
    buttons: [{ type: 'URL', text: 'Pay now', url: 'https://pay.lot.com/{{1}}', example: 'https://pay.lot.com/abc' }],
    mapping: [...good().mapping, { component: 'button', index: 0, token: 'pay_suffix', example: 'abc' }],
  }));
  assert.ok(r.ok, JSON.stringify(r.errors));
});

// ── media header ─────────────────────────────────────────────────────────────────────
t('IMAGE header with no asset at all is caught', () => {
  const r = lintWaTemplate(good({ header_format: 'IMAGE' }));
  assert.ok(codes(r).includes('media_header_no_asset'));
});

t('IMAGE header with a static url is fine', () => {
  const r = lintWaTemplate(good({ header_format: 'IMAGE', header_media_url: 'https://x/y.png' }));
  assert.ok(r.ok, JSON.stringify(r.errors));
});

// ── limits ───────────────────────────────────────────────────────────────────────────
t('over-long body / footer / button text are caught', () => {
  assert.ok(codes(lintWaTemplate(good({ body: 'a'.repeat(1100) }))).includes('body_too_long'));
  assert.ok(codes(lintWaTemplate(good({ footer: 'f'.repeat(70) }))).includes('footer_too_long'));
  assert.ok(codes(lintWaTemplate(good({
    buttons: [{ type: 'URL', text: 'x'.repeat(30), url: 'https://a.com' }],
  }))).includes('button_text_too_long'));
});

t('a placeholder in the footer is caught', () => {
  assert.ok(codes(lintWaTemplate(good({ footer: 'Order {{3}}' }))).includes('footer_has_placeholder'));
});

// ── advisory, not blocking ───────────────────────────────────────────────────────────
t('marketing with no opt-out WARNS but does not block', () => {
  const r = lintWaTemplate(good({ category: 'MARKETING' }));
  assert.ok(r.ok, 'must not block');
  assert.ok(r.warnings.some((w) => w.code === 'marketing_no_optout'));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
