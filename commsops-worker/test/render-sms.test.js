// renderSms — the SMS branch of the render engine.
//
// NOT in the original plan. Added during execution because send.js's render step is
// `if (channel === 'whatsapp') {...} else { renderEmail(...) }`, so an SMS send fell into the
// EMAIL branch and produced {subject, html, text} — none of the fields adapters/sms.js needs.
// The adapter was registered but could never be fed correctly, and the first live send would
// have died at `template_type_unset`.
// Run: node test/render-sms.test.js
const assert = require('assert');
const { renderSms } = require('../src/render.js');

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('  ok  ', n); }
                      catch (e) { fail++; console.log('  FAIL', n, '\n        ', e.message); } };

const TPL = {
  provider_template_id: 'vyNTAwgHa',
  content: {
    dlt_template_id: '1707176130196189451',
    template_type: 'implicit',
    body: 'Hi {first_name}, your order {order_no} is confirmed. Track: {track_url}',
    var_order: ['first_name', 'order_no', 'track_url'],
  },
  variables: [
    { token: 'first_name', source: 'profile', field: 'first_name' },
    { token: 'order_no', source: 'event', field: 'order_no' },
    { token: 'track_url', source: 'event', field: 'track_url' },
  ],
};
const CTX = {
  profile: { first_name: 'Riya' },
  event: { order_no: 'LOT1234', track_url: 'https://legendoftoys.com/t/abc' },
};

t('carries the vendor template id and the declared template_type through', () => {
  const r = renderSms(TPL, CTX);
  assert.strictEqual(r.provider_template_id, 'vyNTAwgHa');
  assert.strictEqual(r.template_type, 'implicit');
});

t('resolves the body with tokens applied', () => {
  const r = renderSms(TPL, CTX);
  assert.strictEqual(r.body, 'Hi Riya, your order LOT1234 is confirmed. Track: https://legendoftoys.com/t/abc');
});

t('passes var_order through UNCHANGED — the adapter owns the pr1..pr5 mapping', () => {
  const r = renderSms(TPL, CTX);
  assert.deepStrictEqual(r.var_order, ['first_name', 'order_no', 'track_url']);
  assert.strictEqual(r.vars.first_name, 'Riya');
  assert.strictEqual(r.vars.order_no, 'LOT1234');
});

t('an unresolved declared variable throws — same discipline as email/WA', () => {
  assert.throws(() => renderSms(TPL, { profile: {}, event: { order_no: 'X', track_url: 'https://y' } }),
    /unresolved_variables:first_name/);
});

t('has_link is true when a resolved VARIABLE carried a url', () => {
  assert.strictEqual(renderSms(TPL, CTX).has_link, true);
});

t('has_link is false when nothing resolved to a url', () => {
  const tpl = { ...TPL, content: { ...TPL.content, body: 'Hi {first_name}, order {order_no} confirmed.', var_order: ['first_name', 'order_no'] },
                variables: TPL.variables.slice(0, 2) };
  assert.strictEqual(renderSms(tpl, { profile: { first_name: 'Riya' }, event: { order_no: 'LOT1' } }).has_link, false);
});

t('F6 — a LITERAL url in the static template body is REFUSED', () => {
  // isdesturl rewrites urls in the outgoing body. A url baked into approved DLT content stops
  // matching the registered template once rewritten, and the carrier rejects it. A url must
  // always arrive inside a {#var#}.
  const bad = { ...TPL, content: { ...TPL.content, body: 'Hi {first_name}, see https://legendoftoys.com/sale', var_order: ['first_name'] },
                variables: TPL.variables.slice(0, 1) };
  assert.throws(() => renderSms(bad, CTX), /static_url_in_template/);
});

t('F9 — more than 5 variables is refused at RENDER time, not left to the vendor', () => {
  const many = { provider_template_id: 'x',
    content: { template_type: 'implicit', body: '{a}{b}{c}{d}{e}{f}', var_order: ['a','b','c','d','e','f'] },
    variables: ['a','b','c','d','e','f'].map((k) => ({ token: k, source: 'constant', value: k })) };
  assert.throws(() => renderSms(many, {}), /too_many_variables/);
});

t('an empty body is refused rather than sending a blank SMS', () => {
  const empty = { provider_template_id: 'x', content: { template_type: 'implicit', body: '', var_order: [] }, variables: [] };
  assert.throws(() => renderSms(empty, {}), /empty_sms_body/);
});

// ── guards for catalogue-seeded, not-yet-authored templates ──
// The catalog pull mirrors the 20 DLT templates into comms.templates with their REGISTERED
// body, which still carries positional {#var#} markers. send.js fetches a template by id with
// NO status gate, so "draft" does not stop a send — these two guards are what actually make an
// unauthored template fail closed instead of shipping {#var#} to a customer.

t('a body still holding {#var#} after rendering is REFUSED', () => {
  const seeded = {
    provider_template_id: 'plsFsHlz6',
    content: { template_type: 'explicit', body: 'Hi {#var#}, your order {#var#} shipped.', var_order: [] },
    variables: [],
  };
  assert.throws(() => renderSms(seeded, {}), /unfilled_dlt_placeholders/);
});

t('var_order arity must match the registered DLT placeholder count', () => {
  // Positional binding means a count mismatch silently shifts every value by one — the exact
  // "grammatical message with the wrong words in it" failure. dlt_var_count is recorded by the
  // catalog pull, so the mismatch is checkable rather than a matter of care.
  const tpl = {
    provider_template_id: 'x',
    content: { template_type: 'implicit', body: 'Hi {a}, order {b} ok', var_order: ['a'], dlt_var_count: 2 },
    variables: [{ token: 'a', source: 'constant', value: 'A' }, { token: 'b', source: 'constant', value: 'B' }],
  };
  assert.throws(() => renderSms(tpl, {}), /var_order_arity_mismatch/);
});

t('matching arity passes', () => {
  const tpl = {
    provider_template_id: 'x',
    content: { template_type: 'implicit', body: 'Hi {a}, order {b} ok', var_order: ['a', 'b'], dlt_var_count: 2 },
    variables: [{ token: 'a', source: 'constant', value: 'A' }, { token: 'b', source: 'constant', value: 'B' }],
  };
  assert.strictEqual(renderSms(tpl, {}).body, 'Hi A, order B ok');
});

t('dlt_var_count absent → arity check is skipped, not assumed zero', () => {
  const tpl = {
    provider_template_id: 'x',
    content: { template_type: 'implicit', body: 'Hi {a}', var_order: ['a'] },
    variables: [{ token: 'a', source: 'constant', value: 'A' }],
  };
  assert.doesNotThrow(() => renderSms(tpl, {}));
});


// ── F6 widened: bare domains (S327, 2026-09-01) ──────────────────────────────────
// The guard used to match only `https?://`, so `legendoftoys.com/sale` — the way a human
// actually types a link into copy — walked straight through it. These lock the widening in and,
// just as importantly, lock in what must NOT match.
const WIDE = { ...TPL, variables: TPL.variables.slice(0, 1) };
const bodyTpl = (body) => ({ ...WIDE, content: { ...TPL.content, body, var_order: ['first_name'] } });

t('F6 — a SCHEMELESS domain is refused, the case that used to slip through', () => {
  assert.throws(() => renderSms(bodyTpl('Hi {first_name}, shop legendoftoys.com/sale'), CTX),
    /static_url_in_template/);
});

t('F6 — a bare domain at end-of-body is refused (no trailing slash or space)', () => {
  assert.throws(() => renderSms(bodyTpl('Hi {first_name}, visit lottoys.in'), CTX),
    /static_url_in_template/);
});

t('F6 — ordinary copy with NO url still renders; the guard must not block real sends', () => {
  // The whole risk of widening: a false positive here hard-blocks a live transactional send.
  for (const body of [
    'Hi {first_name}, your order is confirmed. Thank you for shopping with Legend of Toys.',
    'Hi {first_name}, reply STOP to opt out. Sign in to your account for details.',
    'Hi {first_name}, your L.O.T order ships today. Rs.499 refunded.',
    'Hi {first_name}, 5.5 inch model, in stock now.',
  ]) {
    assert.doesNotThrow(() => renderSms(bodyTpl(body), CTX), `must not flag: ${body}`);
  }
});

t('F6 — a url arriving via a VARIABLE is still fine; only static urls are refused', () => {
  // The guard tests the pre-token body precisely so a tracked link can be injected.
  const okTpl = { ...TPL,
    content: { ...TPL.content, body: 'Hi {first_name}, shop {link}', var_order: ['first_name', 'link'] },
    variables: [TPL.variables[0], { token: 'link', source: 'constant', value: 'https://lottoys.in/r/abc' }] };
  const out = renderSms(okTpl, CTX);
  assert.match(out.body, /lottoys\.in\/r\/abc/);
  assert.equal(out.has_link, true, 'has_link must be set so the adapter sends isdesturl');
});


console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);