import test from 'node:test';
import assert from 'node:assert/strict';
import { rememberScroll, takeScroll, MAX_AGE_MS } from '../src/lib/useListScroll.js';

// Back from a deal lands where you left the deals list (Nandeswari, #bugs 1791356178.730839).
// The position is saved on open and taken back ONCE — so a later fresh load / deep link starts
// at the top instead of inheriting an old position.

function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

test('takeScroll returns the remembered position once, then nothing', () => {
  const s = memStorage();
  rememberScroll(s, 'engagements', 1234.6);
  assert.equal(takeScroll(s, 'engagements'), 1235);
  assert.equal(takeScroll(s, 'engagements'), null);
});

test('nothing remembered (fresh load / deep link) → null, i.e. stay at the top', () => {
  assert.equal(takeScroll(memStorage(), 'engagements'), null);
});

test('positions are per list, and 0 / junk restore nothing', () => {
  const s = memStorage();
  rememberScroll(s, 'engagements', 500);
  assert.equal(takeScroll(s, 'ugc'), null);
  assert.equal(takeScroll(s, 'engagements'), 500);
  rememberScroll(s, 'engagements', 0);
  assert.equal(takeScroll(s, 'engagements'), null);
  rememberScroll(s, 'engagements', 'abc');
  assert.equal(takeScroll(s, 'engagements'), null);
});

test('a throwing storage (private mode) degrades to "no restore", never an error', () => {
  const bad = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() {} };
  assert.doesNotThrow(() => rememberScroll(bad, 'engagements', 300));
  assert.equal(takeScroll(bad, 'engagements'), null);
});

test('a stale position (older than MAX_AGE_MS) is ignored and still consumed', () => {
  const s = memStorage();
  const t0 = 1_000_000;
  rememberScroll(s, 'engagements', 800, t0);
  assert.equal(takeScroll(s, 'engagements', t0 + MAX_AGE_MS + 1), null);
  rememberScroll(s, 'engagements', 800, t0);
  assert.equal(takeScroll(s, 'engagements', t0 + MAX_AGE_MS - 1), 800);
  assert.equal(takeScroll(s, 'engagements', t0 + MAX_AGE_MS - 1), null);
});

test('a pre-change bare-number value restores nothing', () => {
  const s = memStorage();
  s.setItem('ignition.scroll.engagements', '500');
  assert.equal(takeScroll(s, 'engagements'), null);
});
