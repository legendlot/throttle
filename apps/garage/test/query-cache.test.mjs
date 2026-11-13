import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCache, writeCache, clearCache } from '../../../packages/db/queryCache.js';

// Minimal Web Storage stand-in.
function fakeStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    keys: () => [...m.keys()].sort(),
    map: m,
  };
}

test('round trip returns the data and when it was written', () => {
  const storage = fakeStorage();
  const before = Date.now();
  assert.equal(writeCache('u1', 'garage:kpis', { a: 1, list: [1, 2] }, { storage }), true);
  const hit = readCache('u1', 'garage:kpis', { storage });
  assert.deepEqual(hit.data, { a: 1, list: [1, 2] });
  assert.ok(hit.at >= before && hit.at <= Date.now());
  assert.deepEqual(storage.keys(), ['lotq:v1:garage:kpis']);
  const raw = JSON.parse(storage.getItem('lotq:v1:garage:kpis'));
  assert.equal(raw.u, 'u1');
});

test('null is a value worth caching; a miss is null', () => {
  const storage = fakeStorage();
  assert.equal(writeCache('u1', 'ops', null, { storage }), true);
  assert.deepEqual(readCache('u1', 'ops', { storage }).data, null);
  assert.equal(readCache('u1', 'nothing-here', { storage }), null);
});

test('a different user purges every lotq key (and only those) and gets null', () => {
  const storage = fakeStorage({ 'other-app': 'keep', 'throttle-brand-user': '{"x":1}' });
  writeCache('u1', 'a', [1], { storage });
  writeCache('u1', 'b', [2], { storage });
  storage.setItem('lotq:v0:old', 'whatever');
  assert.equal(readCache('u2', 'a', { storage }), null);
  assert.deepEqual(storage.keys(), ['other-app', 'throttle-brand-user']);
  assert.equal(readCache('u1', 'b', { storage }), null);
});

test('entries older than maxAgeMs are removed', () => {
  const storage = fakeStorage();
  storage.setItem('lotq:v1:k', JSON.stringify({ u: 'u1', at: Date.now() - 13 * 3600e3, d: 1 }));
  assert.equal(readCache('u1', 'k', { storage }), null, 'default max age is 12 h');
  assert.equal(storage.getItem('lotq:v1:k'), null);
  storage.setItem('lotq:v1:k', JSON.stringify({ u: 'u1', at: Date.now() - 5000, d: 1 }));
  assert.equal(readCache('u1', 'k', { storage, maxAgeMs: 1000 }), null);
  storage.setItem('lotq:v1:k', JSON.stringify({ u: 'u1', at: Date.now() - 5000, d: 1 }));
  assert.equal(readCache('u1', 'k', { storage, maxAgeMs: 60000 }).data, 1);
});

test('corrupt or malformed JSON is removed and reads as null', () => {
  const storage = fakeStorage({ 'lotq:v1:k': '{not json', 'lotq:v1:j': '"a string"', 'lotq:v1:n': '{"u":"u1","d":1}' });
  assert.equal(readCache('u1', 'k', { storage }), null);
  assert.equal(readCache('u1', 'j', { storage }), null);
  assert.equal(readCache('u1', 'n', { storage }), null);
  assert.deepEqual(storage.keys(), []);
});

test('oversize values are skipped, not written', () => {
  const storage = fakeStorage();
  assert.equal(writeCache('u1', 'big', 'x'.repeat(300001), { storage }), false);
  assert.deepEqual(storage.keys(), []);
  assert.equal(writeCache('u1', 'ok', 'x'.repeat(1000), { storage }), true);
});

test('a skipped write removes the old entry so a stale small value cannot re-seed', () => {
  const storage = fakeStorage();
  writeCache('u1', 'k', [1], { storage });
  assert.equal(writeCache('u1', 'k', 'x'.repeat(300001), { storage }), false);
  assert.equal(readCache('u1', 'k', { storage }), null, 'oversize');

  writeCache('u1', 'k', [1], { storage });
  assert.equal(writeCache('u1', 'k', undefined, { storage }), false);
  assert.equal(readCache('u1', 'k', { storage }), null, 'undefined data');

  writeCache('u1', 'k', [1], { storage });
  storage.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.equal(writeCache('u1', 'k', [2], { storage }), false);
  assert.equal(readCache('u1', 'k', { storage }), null, 'quota');
  assert.deepEqual(storage.keys(), []);
});

test('undefined data and unserialisable data are skipped', () => {
  const storage = fakeStorage();
  assert.equal(writeCache('u1', 'k', undefined, { storage }), false);
  const cyclic = {}; cyclic.self = cyclic;
  assert.equal(writeCache('u1', 'k', cyclic, { storage }), false);
  assert.deepEqual(storage.keys(), []);
});

test('storage that throws never throws into the caller', () => {
  const boom = () => { throw new Error('QuotaExceededError'); };
  const broken = { length: 3, key: boom, getItem: boom, setItem: boom, removeItem: boom };
  assert.equal(writeCache('u1', 'k', [1], { storage: broken }), false);
  assert.equal(readCache('u1', 'k', { storage: broken }), null);
  assert.doesNotThrow(() => clearCache({ storage: broken }));

  // getItem works but every write/remove fails (full quota / private mode).
  const readOnly = fakeStorage({ 'lotq:v1:k': '{bad' });
  readOnly.setItem = boom; readOnly.removeItem = boom;
  assert.equal(writeCache('u1', 'k', [1], { storage: readOnly }), false);
  assert.equal(readCache('u1', 'k', { storage: readOnly }), null);
  assert.equal(readCache('u2', 'k', { storage: fakeStorage({ 'lotq:v1:k': JSON.stringify({ u: 'u1', at: Date.now(), d: 1 }) }) }), null);
});

test('missing userId or key reads null and writes nothing', () => {
  const storage = fakeStorage();
  writeCache('u1', 'k', [1], { storage });
  assert.equal(readCache(null, 'k', { storage }), null);
  assert.equal(readCache('', 'k', { storage }), null);
  assert.equal(readCache(undefined, 'k', { storage }), null);
  assert.equal(writeCache(null, 'k2', [1], { storage }), false);
  assert.equal(writeCache('u1', '', [1], { storage }), false);
  assert.deepEqual(storage.keys(), ['lotq:v1:k'], 'a missing userId does not purge');
});

test('clearCache removes lotq keys only', () => {
  const storage = fakeStorage({ 'sb-auth-token': 't', 'lotqx': 'not ours either? starts with lotq but no colon' });
  writeCache('u1', 'a', 1, { storage });
  writeCache('u1', 'b', 2, { storage });
  clearCache({ storage });
  assert.deepEqual(storage.keys(), ['lotqx', 'sb-auth-token']);
});

test('no window → no-op storage: reads null, writes false, never throws', () => {
  assert.equal(typeof window, 'undefined');
  assert.equal(writeCache('u1', 'k', 1), false);
  assert.equal(readCache('u1', 'k'), null);
  assert.doesNotThrow(() => clearCache());
});
