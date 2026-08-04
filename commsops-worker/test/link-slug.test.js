// Campaign-link slugs.
//
// A slug is the OPPOSITE of a minted recipient code: chosen, memorable, permanent, and shared with
// thousands of strangers. That is safe only because a campaign link carries no personal context —
// see the kind table in migration 0040. These assertions pin the shape so nobody later relaxes it
// into something that could shadow a route or arrive with surprising casing.
// Run: node test/link-slug.test.js
const assert = require('node:assert');
const { normalizeSlug, SLUG_RE } = require('../src/links.js');

// ── accepted, and lower-cased on the way in ─────────────────────────────────
assert.equal(normalizeSlug('diwali26'), 'diwali26');
assert.equal(normalizeSlug('Diwali26'), 'diwali26', 'must lower-case');
assert.equal(normalizeSlug('  diwali26  '), 'diwali26', 'must trim');
assert.equal(normalizeSlug('box-insert-ghost'), 'box-insert-ghost');
assert.equal(normalizeSlug('a1'), 'a1', 'two chars is the floor');
assert.equal(normalizeSlug('c'.repeat(31)), 'c'.repeat(31), '31 chars is the ceiling');

// ── rejected ────────────────────────────────────────────────────────────────
for (const bad of [
  null, '', 'a',                     // too short — a 1-char slug is a typo waiting to happen
  'c'.repeat(32),                    // too long
  '-lead',                           // must start alphanumeric
  'has space', 'has/slash',          // would change the path shape
  'has.dot',                         // reads as a hostname in a message and looks like a typo
  'under_score',                     // '-' only, so a slug is unambiguous when read aloud
  'Ünicode', 'emoji😀',              // must survive being typed off a printed page
  '../etc', '%2e%2e',                // path traversal, even though the route never uses it as a path
]) {
  assert.equal(normalizeSlug(bad), null, `should reject: ${JSON.stringify(bad)}`);
}

// The regex is exported so the UI validates identically to the worker. A UI that accepts what the
// worker rejects is a form that fails on save with no explanation.
assert.ok(SLUG_RE instanceof RegExp);
assert.ok(SLUG_RE.test('diwali26'));
assert.ok(!SLUG_RE.test('Diwali26'), 'the RE itself is lower-case-only; normalizeSlug does the casing');

// ── slugs cannot shadow a worker route ──────────────────────────────────────
// Every slug is served under /r/, so /health, /ingest, /send etc. are unreachable by construction.
// This is a note in assertion form: if someone ever moves campaign links to the root, these names
// become dangerous and this test should start failing loudly.
for (const name of ['health', 'ingest', 'send', 'pixel', 'unsubscribe', 'webhooks']) {
  assert.ok(SLUG_RE.test(name),
    `'${name}' is a VALID slug — safe only because slugs live under /r/. If links ever move to the ` +
    `root, add a reserved-name check before shipping it.`);
}

console.log('link-slug.test.js: all assertions passed');
