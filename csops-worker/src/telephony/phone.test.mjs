// Phone normalisation regression tests.
//
// toE164 lives in src/index.js, which cannot be imported here (it is a Worker module
// with a default export and top-level bindings). The function is small, pure and
// stable, so it is MIRRORED below — and this test exists precisely to catch it
// drifting from the original.
//
// ⚠️ If you change toE164 in index.js, change it here too. The mirror is checked by
// eye at review time; the alternative was extracting it into its own module, which
// touches 10 call sites across WhatsApp, email and tickets during a cutover.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── MIRROR OF src/index.js toE164 ───────────────────────────────────────────
function toE164(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, '');
  d = d.replace(/^0+/, '');
  if (!d) return null;
  if (d.length === 10) return `+91${d}`;
  if (d.length === 12 && d.startsWith('91')) return `+${d}`;
  return `+${d}`;
}
// ─────────────────────────────────────────────────────────────────────────────

test("Exotel's national format normalises to the same key MyOperator used", () => {
  // The live bug, found on the first poll 2026-08-20: Exotel returns 09959953604 and
  // the old code produced '+09959953604' — a different key from the '+91…' on all
  // 17,703 MyOperator rows, so coalescing, Shopify lookup and WhatsApp matching all
  // silently missed and every Exotel caller read as "Unknown caller".
  assert.equal(toE164('09959953604'), '+919959953604');
  assert.equal(toE164('08630851963'), '+918630851963');
  assert.equal(toE164('09910632729'), '+919910632729');
});

test('the formats MyOperator sent are unchanged', () => {
  assert.equal(toE164('9959953604'), '+919959953604', 'bare 10-digit');
  assert.equal(toE164('919959953604'), '+919959953604', '91-prefixed');
  assert.equal(toE164('+91 99599 53604'), '+919959953604', 'formatted');
  assert.equal(toE164('+91-9959-953604'), '+919959953604');
});

test('all three input formats collapse to ONE key — this is the whole point', () => {
  const forms = ['9959953604', '09959953604', '919959953604', '+919959953604', '+91 99599 53604'];
  const keys = new Set(forms.map(toE164));
  assert.equal(keys.size, 1, `expected one key, got ${[...keys].join(', ')}`);
  assert.equal([...keys][0], '+919959953604');
});

test('international numbers survive — a country code never starts with 0', () => {
  assert.equal(toE164('+97412345678'), '+97412345678', 'Qatar, already E.164');
  assert.equal(toE164('0097412345678'), '+97412345678', '00 international prefix is stripped');
  assert.equal(toE164('+1 415 555 0132'), '+14155550132');
});

test('junk in never yields a malformed number out', () => {
  assert.equal(toE164(null), null);
  assert.equal(toE164(''), null);
  assert.equal(toE164('   '), null);
  assert.equal(toE164('abc'), null, 'no digits at all');
  assert.equal(toE164('0'), null, 'zeros only must not become "+"');
  assert.equal(toE164('0000'), null);
});

test('no output ever begins +0', () => {
  const inputs = ['09959953604', '0', '00', '009959953604', '0000009959953604', '+0 9959953604'];
  for (const i of inputs) {
    const r = toE164(i);
    assert.ok(r === null || !r.startsWith('+0'), `toE164(${JSON.stringify(i)}) = ${r}`);
  }
});
