// S315 hostile review — the DLQ alert now prints the dead-lettered payload when the durable
// write fails, so it must not become a PII channel. Today's queue bodies are ids and cursors
// only; this guards the FUTURE body that carries a recipient.
//
// The first implementation redacted by value with a loose phone-shaped regex and mangled every
// uuid in the payload — the exact opposite of useful. These tests pin both halves: PII goes,
// ids survive.
// Run: node test/dlq-redact.test.js
const assert = require('assert');

// mirror of redactForAlert in src/index.js (an ES module, so it cannot be required here)
const PII_KEY = /(phone|mobile|msisdn|email|to_address|recipient|address|full_?name|display_?name)/i;
const EMAIL_VAL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164_VAL = /^\+\d{8,15}$/;
function redactForAlert(body) {
  const seen = new WeakSet();
  const walk = (v, key) => {
    if (v === null || v === undefined) return v;
    if (typeof v === 'string') {
      if (key && PII_KEY.test(key)) return '[redacted]';
      if (EMAIL_VAL.test(v)) return '[email-redacted]';
      if (E164_VAL.test(v)) return '[phone-redacted]';
      return v;
    }
    if (typeof v !== 'object') return v;
    if (seen.has(v)) return '[circular]';
    seen.add(v);
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
  };
  try { return JSON.stringify(walk(body, null)).slice(0, 1500); }
  catch { return '(unserialisable payload)'; }
}

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('  ok  ', n); }
                      catch (e) { fail++; console.log('  FAIL', n, '\n        ', e.message); } };

// ── ids must survive intact: this is the regression the first cut introduced ──────────
t('a real build_roster body is untouched', () => {
  const out = redactForAlert({ kind: 'build_roster', campaignId: '4363574c-18f4-42b2-b908-1f40e009f38e', after: null });
  assert.ok(out.includes('4363574c-18f4-42b2-b908-1f40e009f38e'), out);
  assert.ok(!out.includes('redacted'), out);
});
t('a shard fan-out body keeps BOTH uuids', () => {
  const out = redactForAlert({ campaignId: 'ddb9c4b1-6789-4512-819b-d44e9adc5227',
    after: 'f994fdb2-a1cd-4c86-8227-62ab489bc2da', shard: 3, shardCount: 8 });
  assert.ok(out.includes('ddb9c4b1-6789-4512-819b-d44e9adc5227'), 'campaignId mangled: ' + out);
  assert.ok(out.includes('f994fdb2-a1cd-4c86-8227-62ab489bc2da'), 'cursor mangled: ' + out);
});
t('an enrol body keeps journeyId/profileId/eventId', () => {
  const out = redactForAlert({ kind: 'enrol', journeyId: '6250651e-38d4-4ae7-9c89-bacbc1d9c3b1',
    profileId: '2bdfcd88-c8a9-491b-a1e4-f2fee0c8054c', eventId: '0e336225-d39a-4879-87c0-f710fe266841' });
  assert.ok(!out.includes('redacted'), out);
});
t('a base64 shopify cursor is untouched', () => {
  const out = redactForAlert({ kind: 'shopify_backfill', after: 'eyJsYXN0X2lkIjo1NTUsImxhc3RfdmFsdWUiOiIyMDI2LTA4LTI2In0=' });
  assert.ok(!out.includes('redacted'), out);
});

// ── PII must go: the case this exists for ────────────────────────────────────────────
t('email + phone on a future body are redacted', () => {
  const out = redactForAlert({ kind: 'x', to: 'customer@example.com', phone: '+917709991011' });
  assert.ok(!out.includes('customer@example.com'), out);
  assert.ok(!out.includes('+917709991011'), out);
});
t('redacted by KEY even when the value looks innocuous', () => {
  const out = redactForAlert({ recipient: 'Ravi K', to_address: 'x' });
  assert.ok(!out.includes('Ravi K'), out);
});
t('nested + arrayed PII is reached', () => {
  const out = redactForAlert({ batch: [{ email: 'a@b.com' }, { profile: { phone: '+919999999999' } }] });
  assert.ok(!out.includes('a@b.com') && !out.includes('+919999999999'), out);
});

// ── degenerate input must not throw: the alert is the last copy of the message ────────
t('cyclic body does not hang or throw', () => {
  const a = { kind: 'x' }; a.self = a;
  const out = redactForAlert(a);
  assert.ok(out.includes('[circular]'), out);
});
t('null / undefined / primitives survive', () => {
  assert.equal(redactForAlert(null), 'null');
  assert.ok(redactForAlert({ a: undefined, b: 0, c: false, d: null }).length > 0);
});
t('output is capped at 1500 chars', () => {
  assert.ok(redactForAlert({ big: 'x'.repeat(9000) }).length <= 1500);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
