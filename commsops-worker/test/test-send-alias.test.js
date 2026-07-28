// Test sends accept a variable's TOKEN as an alias for its source FIELD (2026-07-28).
//
// An event-sourced variable resolves on `field` (render.js resolveVar), but the Test-values
// box shows the TOKEN and the failure message names the TOKEN. Where they differ — token
// `order_total` reading field `total` — the error pointed at a key that does not work, so the
// author retyped the name the error gave them and it failed again. Two people lost a round to
// it on the same day.
//
// The aliasing is TEST-ONLY. A real send's event is the true wire payload and must keep
// failing loudly when a field is genuinely absent.
//
// Run: node test/test-send-alias.test.js   (Node 18+)
const assert = require('assert');
const { renderWhatsapp } = require('../src/render.js');

let pass = 0, fail = 0;
const t = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log('  ok  ', n); },
  (e) => { fail++; console.log('  FAIL', n, '\n        ', e && e.message); });

// Mirrors send.js: for each declared variable whose token differs from its field, copy a
// token-keyed test value onto the field the resolver actually reads.
function aliasForTest(eventContext, variables) {
  const ev = { ...(eventContext || {}) };
  for (const v of (Array.isArray(variables) ? variables : [])) {
    const field = v.field || v.token;
    if (field !== v.token && ev[field] === undefined && ev[v.token] !== undefined) ev[field] = ev[v.token];
  }
  return ev;
}

// lot_order_placed_01's real shape: order_total reads `total`, order_url reads
// `order_status_url`. order_number's token and field are identical.
const VARS = [
  { token: 'first_name', source: 'profile', field: 'display_name', fallback: 'there' },
  { token: 'order_number', source: 'event', field: 'order_number' },
  { token: 'order_total', source: 'event', field: 'total' },
  { token: 'order_url', source: 'event', field: 'order_status_url', fallback: 'https://legendoftoys.com/account' },
];
const TPL = {
  language: 'en',
  variables: VARS,
  content: {
    meta_name: 'lot_order_placed_01', language: 'en',
    body: 'Hi {{1}}, order #{{2}} for {{3}}. Track: {{4}}. Thanks.',
    mapping: [
      { pos: 1, token: 'first_name', component: 'body' },
      { pos: 2, token: 'order_number', component: 'body' },
      { pos: 3, token: 'order_total', component: 'body' },
      { pos: 4, token: 'order_url', component: 'body' },
    ],
  },
};
const render = (ev) => renderWhatsapp(TPL, { profile: {}, event: ev });
const slots = (r) => r.template.components.find((c) => c.type === 'body').parameters.map((p) => p.text);

(async () => {
  await t('BEFORE: token-keyed values fail — this is what Pruthvi and Afshaan both hit', () => {
    assert.throws(() => render({ order_number: '44779', order_total: '2249' }),
      /unresolved_variables:order_total/);
  });

  await t('AFTER: the same token-keyed values now resolve', () => {
    const ev = aliasForTest({ order_number: '44779', order_total: '2249' }, VARS);
    assert.deepStrictEqual(slots(render(ev)),
      ['there', '44779', '2249', 'https://legendoftoys.com/account']);
  });

  await t('the real FIELD key still works (nothing regressed)', () => {
    const ev = aliasForTest({ order_number: '44779', total: '2249' }, VARS);
    assert.strictEqual(slots(render(ev))[2], '2249');
  });

  await t('the field key WINS when both are supplied (event shape is authoritative)', () => {
    const ev = aliasForTest({ order_number: '1', total: 'FIELD', order_total: 'TOKEN' }, VARS);
    assert.strictEqual(slots(render(ev))[2], 'FIELD');
  });

  await t('aliasing does not invent values — a genuinely missing var still throws', () => {
    const ev = aliasForTest({ order_total: '2249' }, VARS);   // order_number absent entirely
    assert.throws(() => render(ev), /unresolved_variables:order_number/);
  });

  await t('a variable whose token EQUALS its field is untouched', () => {
    const ev = aliasForTest({ order_number: '44779', total: '1' }, VARS);
    assert.strictEqual(ev.order_number, '44779');
  });

  await t('fallbacks still apply to aliased-but-absent variables', () => {
    const ev = aliasForTest({ order_number: '44779', total: '2249' }, VARS);
    assert.strictEqual(slots(render(ev))[3], 'https://legendoftoys.com/account');
  });

  await t('empty test values leave the event untouched', () => {
    assert.deepStrictEqual(aliasForTest({}, VARS), {});
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
