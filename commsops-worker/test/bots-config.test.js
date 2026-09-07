// S355 — pilot switch is activate-tier only; saveBot cannot flip it. Run: node test/bots-config.test.js
const assert = require('assert');
const B = require('../src/bots.js');
assert.deepEqual(B.sanitizeBuilderConfig({ mode: 'public', pilot_numbers: ['1'], greeting_delay: 2 }, { mode: 'pilot', pilot_numbers: ['917709991011'] }),
  { mode: 'pilot', pilot_numbers: ['917709991011'], greeting_delay: 2 });
assert.deepEqual(B.sanitizeBuilderConfig({}, {}), { mode: 'pilot', pilot_numbers: [] });
assert.deepEqual(B.normalizeMode({ mode: 'public', pilot_numbers: ['+91 77099 91011', 'x', '12'] }), { mode: 'public', pilot_numbers: ['917709991011'] });
assert.deepEqual(B.normalizeMode({ mode: 'weird' }), null);
console.log('bots-config ok');
