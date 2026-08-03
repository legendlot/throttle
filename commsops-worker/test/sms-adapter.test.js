// SMS template binding: positional variables and the route/consent-type cross-check.
// Run: node test/sms-adapter.test.js
const assert = require('assert');
const { buildSmsParams, routeForPurpose, assertBindable, PURPOSE_ROUTE } = require('../src/adapters/sms.js');

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('  ok  ', n); }
                      catch (e) { fail++; console.log('  FAIL', n, '\n        ', e.message); } };

t('var_order maps named vars onto pr1..prN IN ORDER', () => {
  const out = buildSmsParams(['first_name', 'product_url'], { product_url: 'https://x/y', first_name: 'Riya' });
  assert.deepStrictEqual(out, { pr1: 'Riya', pr2: 'https://x/y' });
});

t('order is positional, NOT alphabetical — the whole point', () => {
  const out = buildSmsParams(['zeta', 'alpha'], { alpha: 'A', zeta: 'Z' });
  assert.strictEqual(out.pr1, 'Z');
  assert.strictEqual(out.pr2, 'A');
});

t('a missing variable throws rather than sending a hole', () => {
  assert.throws(() => buildSmsParams(['first_name'], {}), /unresolved_variables:first_name/);
});

t('more than 5 variables is refused (pr1..pr5 is a hard ceiling)', () => {
  assert.throws(() => buildSmsParams(['a','b','c','d','e','f'], { a:1,b:2,c:3,d:4,e:5,f:6 }), /too_many_variables/);
});

t('exactly 5 is allowed', () => {
  const out = buildSmsParams(['a','b','c','d','e'], { a:'1',b:'2',c:'3',d:'4',e:'5' });
  assert.strictEqual(out.pr5, '5');
});

t('purpose maps to the documented routes', () => {
  assert.strictEqual(routeForPurpose('marketing'), 'promotional');
  assert.strictEqual(routeForPurpose('utility'), 'transactional');
  assert.strictEqual(routeForPurpose('transactional'), 'transactional');
});

t('an unknown purpose is refused — never defaults to a sendable route', () => {
  assert.throws(() => routeForPurpose('nonsense'), /unmapped_purpose/);
});

t('`global` is unreachable from a purpose (it is the no-template route)', () => {
  assert.ok(!Object.values(PURPOSE_ROUTE).includes('global'));
});

t('binding a utility journey to an `explicit` template is a hard error (F3)', () => {
  assert.throws(
    () => assertBindable({ purpose: 'utility', template_type: 'explicit' }),
    /route_template_type_mismatch/);
});

t('binding marketing to `explicit` is fine', () => {
  assert.doesNotThrow(() => assertBindable({ purpose: 'marketing', template_type: 'explicit' }));
});

t('an EMPTY template_type is refused — create-without-update leaves it "" (F15)', () => {
  assert.throws(() => assertBindable({ purpose: 'utility', template_type: '' }), /template_type_unset/);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
