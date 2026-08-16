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

t('a URL button with {{1}} and no example anywhere is NOT blocked', () => {
  // Was `button_no_example`. buildComponents() now falls back to DEFAULT_URL_EXAMPLE_SUFFIX for
  // every {{n}} URL button, so an absent example cannot reach Meta and blocking on it would only
  // stop templates that serialise fine — the Pruthvi 2026-08-05 failure mode.
  const r = lintWaTemplate(good({
    buttons: [{ type: 'URL', text: 'Pay now', url: 'https://x.com/pay/{{1}}' }],
    mapping: [...good().mapping, { component: 'button', index: 0, token: 'link' }],
  }));
  assert.ok(!codes(r).includes('button_no_example'));
  assert.ok(!codes(r).includes('button_example_is_url'));
});

t('an example holding the DESTINATION url is caught', () => {
  // `Freedom to Play Sale_15Aug`, 2026-08-14: "example" reads like "where the link goes", so the
  // collections url went in the slot. The suffix is appended to https://<host>/r/, so that
  // serialises to https://lottoys.in/r/https://www.legendoftoys.com/collections/all.
  const r = lintWaTemplate(good({
    buttons: [{ type: 'URL', text: 'Shop', url: 'https://lottoys.in/r/{{1}}' }],
    mapping: [...good().mapping, {
      component: 'button', index: 0, token: 'link',
      example: 'https://www.legendoftoys.com/collections/all',
    }],
  }));
  assert.ok(codes(r).includes('button_example_is_url'));
});

t('a mapping token with no matching variable is caught', () => {
  const r = lintWaTemplate(good({
    buttons: [{ type: 'URL', text: 'Shop', url: 'https://lottoys.in/r/{{1}}' }],
    mapping: [...good().mapping, { component: 'button', index: 0, token: 'link', example: 'abc' }],
  }), [{ token: 'something_else', source: 'constant', value: 'x' }]);
  assert.ok(codes(r).includes('mapping_token_undeclared'));
});

t("a source:'system' variable naming a field the send context never sets is caught", () => {
  // The real one: token `first` declared source:'system'. renderWhatsapp always passes system:{},
  // so it resolves for nobody and EVERY send throws unresolved_variables — silent until send,
  // and on a broadcast that is the whole campaign at once.
  const r = lintWaTemplate(good({
    buttons: [{ type: 'URL', text: 'Shop', url: 'https://lottoys.in/r/{{1}}' }],
    mapping: [...good().mapping, { component: 'button', index: 0, token: 'first', example: 'abc' }],
  }), [{ token: 'first', field: 'first', source: 'system' }]);
  assert.ok(codes(r).includes('variable_system_unknown'));
});

t("...but a source:'system' variable WITH a fallback is fine", () => {
  const r = lintWaTemplate(good({
    buttons: [{ type: 'URL', text: 'Shop', url: 'https://lottoys.in/r/{{1}}' }],
    mapping: [...good().mapping, { component: 'button', index: 0, token: 'first', example: 'abc' }],
  }), [{ token: 'first', field: 'first', source: 'system', fallback: 'there' }]);
  assert.ok(!codes(r).includes('variable_system_unknown'));
});

t('omitting variables entirely skips the cross-check (back-compat)', () => {
  const r = lintWaTemplate(good({
    buttons: [{ type: 'URL', text: 'Shop', url: 'https://lottoys.in/r/{{1}}' }],
    mapping: [...good().mapping, { component: 'button', index: 0, token: 'link', example: 'abc' }],
  }));
  assert.ok(!codes(r).includes('mapping_token_undeclared'));
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

// ── the static-URL clone shape (2026-08-16) ──────────────────────────────────────────
// A `/r/{{1}}` button whose suffix is minted at SEND time from `target_base` needs no mapping
// slot — links.js synthesizes the button component. Without this exception the whole static-URL
// clone wave is unsubmittable.
t('a {{1}} URL button with target_base and NO mapping slot is allowed', () => {
  const r = lintWaTemplate(good({
    buttons: [{ type: 'URL', text: 'Dive Back In', url: 'https://lottoys.in/r/{{1}}',
                target_base: 'https://legendoftoys.com/collections/all' }],
  }));
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.ok(!codes(r).includes('button_var_unmapped'));
});

t('a {{1}} URL button with NEITHER a mapping slot NOR target_base is still caught', () => {
  const r = lintWaTemplate(good({
    buttons: [{ type: 'URL', text: 'Shop', url: 'https://lottoys.in/r/{{1}}' }],
  }));
  assert.ok(codes(r).includes('button_var_unmapped'),
    'nothing supplies the parameter — that is still a dead link');
});

t('the clone shape serialises a valid Meta sample url from the default suffix', () => {
  // buildComponents falls back to DEFAULT_URL_EXAMPLE_SUFFIX when there is no example_suffix and
  // no button slot, so the clone needs no `example` of its own — and must NOT carry a full url in
  // one, which is the button_example_is_url trap.
  const r = lintWaTemplate(good({
    buttons: [{ type: 'URL', text: 'Shop Now', url: 'https://lottoys.in/r/{{1}}',
                target_base: 'https://www.legendoftoys.com/collections/all',
                example: 'https://lottoys.in/r/kQ7mZ2xW9pLd4RtV6nBh8s' }],
  }));
  assert.ok(codes(r).includes('button_example_is_url'),
    'a full url in `example` is the nested-sample trap and must still be refused');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
