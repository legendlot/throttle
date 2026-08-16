// renderRcs — the vendor-template binding: named [param] slots, fail-closed resolution,
// and the mandatory SMS fallback reference.
// Run: node test/render-rcs.test.js
const assert = require('assert');
const { renderRcs } = require('../src/render.js');

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('  ok  ', n); }
                      catch (e) { fail++; console.log('  FAIL', n, '\n        ', e.message); } };

const BASE = {
  provider_template_id: 'rcs_tpl_1',
  content: { rcs_type: 'text_message', var_params: [], sms_fallback_template_id: 'fb-uuid' },
  variables: [],
};

t('a fully literal template (no params) renders with an empty vars map', () => {
  const r = renderRcs(BASE, {});
  assert.deepStrictEqual(r.vars, {});
  assert.strictEqual(r.provider_template_id, 'rcs_tpl_1');
  assert.strictEqual(r.sms_fallback_template_id, 'fb-uuid');
});

t('declared variables map onto the registered [param] names by token', () => {
  const tpl = {
    ...BASE,
    content: { ...BASE.content, var_params: ['name', 'link'] },
    variables: [
      { token: 'name', source: 'constant', value: 'Riya' },
      { token: 'link', source: 'constant', value: 'https://x/y' },
    ],
  };
  const r = renderRcs(tpl, { constants: {} });
  assert.deepStrictEqual(r.vars, { name: 'Riya', link: 'https://x/y' });
});

t('a registered param with no resolvable value fails closed', () => {
  const tpl = { ...BASE, content: { ...BASE.content, var_params: ['name'] }, variables: [] };
  assert.throws(() => renderRcs(tpl, {}), /unresolved_variables:name/);
});

t('an unregistered template (no provider id) is refused before anything renders', () => {
  assert.throws(() => renderRcs({ ...BASE, provider_template_id: null }, {}), /rcs_template_not_registered/);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
