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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
