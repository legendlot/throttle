// test_mode_allow matching. The gate that decides whether a send reaches a real handset, so the
// rule it enforces has to be exactly as wide as intended — no wider, no narrower.
//
// Written after a live test came back test_mode_blocked purely because the number was typed
// "+91 7019103926" with a space while the allow-list entry was compact.
const assert = require('assert');
const { testModeAllows } = require('../src/gate.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n        ', e.message); }
}

const ALLOW = ['@legendoftoys.com', '+917709991011', '+917019103926', '7019103926'];

// ── the regression ──
t('a phone typed with spaces still matches a compact entry', () => {
  assert.equal(testModeAllows('+91 7019103926', ALLOW), true);
  assert.equal(testModeAllows('+91 70191 03926', ALLOW), true);
  assert.equal(testModeAllows('+91-7019103926', ALLOW), true);
  assert.equal(testModeAllows('(+91) 7019103926', ALLOW), true);
});

t('compact form still matches (unchanged behaviour)', () => {
  assert.equal(testModeAllows('+917019103926', ALLOW), true);
  assert.equal(testModeAllows('7019103926', ALLOW), true);
});

// ── the part that must NOT widen ──
t('a different number is still blocked', () => {
  assert.equal(testModeAllows('+917019103927', ALLOW), false);
  assert.equal(testModeAllows('+919999999999', ALLOW), false);
});

t('digits are never stripped, so a substring cannot match', () => {
  assert.equal(testModeAllows('917019103926', ALLOW), false);   // missing the +
  assert.equal(testModeAllows('19103926', ALLOW), false);       // tail of an allowed number
});

t('domain patterns match by suffix on the raw address', () => {
  assert.equal(testModeAllows('afshaan@legendoftoys.com', ALLOW), true);
  assert.equal(testModeAllows('AFSHAAN@LegendOfToys.com', ALLOW), true);   // case-insensitive
  assert.equal(testModeAllows('someone@gmail.com', ALLOW), false);
  assert.equal(testModeAllows('spoof@legendoftoys.com.evil.com', ALLOW), false);
});

t('empty / missing inputs are blocked, never allowed', () => {
  assert.equal(testModeAllows('', ALLOW), false);
  assert.equal(testModeAllows(null, ALLOW), false);
  assert.equal(testModeAllows('+917019103926', []), false);
  assert.equal(testModeAllows('+917019103926', null), false);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
