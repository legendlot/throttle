// Phase-B link codes. The code is a CAPABILITY, not an id: it maps to one customer's cart or
// order, so anything enumerable or derived from a known value would leak one customer's context
// to anyone who guesses it. These assertions exist to stop a later "simplification" to a counter
// or a hash of message_id.
// Run: node test/link-code.test.js
const assert = require('node:assert');
const { newLinkCode, CODE_ALPHABET, CODE_LENGTH } = require('../src/links.js');

// ── shape ────────────────────────────────────────────────────────────────────
const code = newLinkCode();
assert.equal(typeof code, 'string');
assert.equal(code.length, CODE_LENGTH);
assert.ok(CODE_LENGTH >= 16, `code must be >= 16 chars (spec), got ${CODE_LENGTH}`);
// URL-path safe with no escaping, and no lookalike-sensitive punctuation.
assert.ok(/^[A-Za-z0-9]+$/.test(code), code);
for (const ch of code) assert.ok(CODE_ALPHABET.includes(ch), `unexpected char ${ch}`);

// ── unguessable ──────────────────────────────────────────────────────────────
// Collision/dupe check over a decent sample. Not a randomness proof — it is a regression guard
// against someone swapping in a sequence or a timestamp, which this would catch instantly.
const seen = new Set();
for (let i = 0; i < 5000; i++) seen.add(newLinkCode());
assert.equal(seen.size, 5000, 'codes must not repeat across 5000 draws');

// Consecutive codes must not share a long prefix — a timestamp- or counter-derived code would.
const a = newLinkCode(), b = newLinkCode();
let shared = 0;
while (shared < a.length && a[shared] === b[shared]) shared++;
assert.ok(shared < 4, `consecutive codes share a ${shared}-char prefix — looks sequential`);

// ── takes no input, so it cannot embed one ───────────────────────────────────
// The signature itself is the guarantee: nothing about the customer can end up in the path.
assert.equal(newLinkCode.length, 0, 'newLinkCode must take no arguments');

// Even when called with something (a later caller passing an id by mistake), the id must not
// appear in the output.
const withId = newLinkCode('9f8e7d6c-1234-4321-abcd-000000000000');
assert.ok(!withId.includes('9f8e7d6c'), 'a passed value must never reach the code');
assert.ok(!withId.includes('1234'), 'a passed value must never reach the code');

// ── alphabet is unbiased ─────────────────────────────────────────────────────
// Rejection sampling, not `% 62`. A modulo over 256 favours the first 8 chars by ~1.5x; over a
// large sample that skew is visible, and it shrinks the real keyspace.
const counts = new Map();
for (let i = 0; i < 20000; i++)
  for (const ch of newLinkCode()) counts.set(ch, (counts.get(ch) || 0) + 1);
assert.equal(counts.size, CODE_ALPHABET.length, 'every alphabet char should appear');
const freqs = [...counts.values()];
const lo = Math.min(...freqs), hi = Math.max(...freqs);
// Generous bound — this is catching a 1.5x systematic bias, not testing entropy quality.
assert.ok(hi / lo < 1.25, `character frequency skew ${(hi / lo).toFixed(2)}x suggests modulo bias`);

console.log('link-code.test.js: all assertions passed');
