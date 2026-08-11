// A.checkWrite (S272) — makes a fire-and-forget webhook write observable.
//
// The class it closes: sbProfile returns {ok:false} on an HTTP error and never throws, so a
// bare `await A.sbComms(...)` discarded failed writes in complete silence — a lost status
// PATCH, a lost engagement event, a lost 24h wa_window. Pure, so it tests without a DB.
const assert = require('assert');
const A = require('../src/auth.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n        ', e.message); }
};

// capture console.log without losing it for the rest of the run
function capture(fn) {
  const orig = console.log; const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  try { fn(); } finally { console.log = orig; }
  return lines;
}

t('ok:true is silent', () => {
  const lines = capture(() => A.checkWrite('m', { ok: true, status: 200, data: [] }, { a: 1 }));
  assert.equal(lines.length, 0);
});

t('ok:false logs the marker, status, detail and context', () => {
  const lines = capture(() =>
    A.checkWrite('wa_status_patch_failed', { ok: false, status: 409, data: { code: '23505' } },
      { message_id: 'abc', to: 'delivered' }));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith('wa_status_patch_failed'), 'marker leads the line');
  assert.ok(lines[0].includes('409'));
  assert.ok(lines[0].includes('23505'));
  assert.ok(lines[0].includes('abc'), 'context is merged in');
  assert.ok(lines[0].includes('delivered'));
});

t('every marker ends in _failed so `wrangler tail | grep _failed` finds the whole class', () => {
  const lines = capture(() => A.checkWrite('sms_dlr_patch_failed', { ok: false }, null));
  assert.ok(/_failed\b/.test(lines[0]));
});

// The dangerous shapes: a write that never resolved, or resolved to something unexpected.
// Treating any of these as success is what the original bare `await` effectively did.
t('undefined / null result is treated as FAILURE, not success', () => {
  assert.equal(capture(() => A.checkWrite('m', undefined, null)).length, 1);
  assert.equal(capture(() => A.checkWrite('m', null, null)).length, 1);
});

t('a truthy-but-not-true ok is a FAILURE (strict ===, no coercion)', () => {
  // guards against a future sbProfile returning ok:'false' or ok:1 and silently passing
  assert.equal(capture(() => A.checkWrite('m', { ok: 'false' }, null)).length, 1);
  assert.equal(capture(() => A.checkWrite('m', { ok: 1 }, null)).length, 1);
  assert.equal(capture(() => A.checkWrite('m', { ok: true }, null)).length, 0);
});

t('unserialisable context still logs the marker rather than throwing', () => {
  const circular = {}; circular.self = circular;
  let lines;
  assert.doesNotThrow(() => { lines = capture(() => A.checkWrite('m', { ok: false }, circular)); });
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith('m'));
});

t('returns the result unchanged so it can wrap an expression in place', () => {
  const res = { ok: false, status: 500 };
  let out;
  capture(() => { out = A.checkWrite('m', res, null); });
  assert.strictEqual(out, res);
});

t('missing context is fine', () => {
  assert.doesNotThrow(() => capture(() => A.checkWrite('m', { ok: false })));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
