// Exact counts out of `Content-Range` (S336) — the half of paging that lies quietly.
//
// `getSuppressions` was written when `comms.suppressions` held 0 rows, deliberately: it read
// `limit=500` with no offset and returned no total. The table now holds 3,380 rows (measured
// 2026-09-02), so an unfiltered read returned the newest 500 and looked complete. Paging fixes the
// rows; the TOTAL is the part that stays wrong if you count the returned array, because the array
// is capped by the very limit you set. That is the exact bug snorkelops shipped and fixed in S334
// (asked for count=exact, then counted `data.length`, so a pool over db-max-rows reported 5000).
//
// These tests pin `totalFromRange` and the `range` passthrough so the class stays observable.
const assert = require('assert');
const A = require('../src/auth.js');

let pass = 0, fail = 0;
const t = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log('  ok  ', n); },
  (e) => { fail++; console.log('  FAIL', n, '\n        ', e.message); });

const origFetch = global.fetch;

// Drive sbProfile with a stubbed fetch whose headers we control.
async function rangeFrom(headerValue) {
  global.fetch = async () => ({
    ok: true, status: 200,
    text: async () => '[]',
    headers: { get: (k) => (k.toLowerCase() === 'content-range' ? headerValue : null) },
  });
  const r = await A.sbProfile('comms')('/rest/v1/suppressions?select=*&limit=100',
    { SUPABASE_URL: 'https://x', SUPABASE_SERVICE_ROLE_KEY: 'k' }, { prefer: 'count=exact' });
  return r.range;
}

(async () => {
  await t('a real count=exact header yields the POPULATION, not the page size', () => {
    assert.equal(A.totalFromRange('0-99/3380'), 3380);
  });

  await t('the live shape from a first page of 100 parses', () => {
    assert.equal(A.totalFromRange('0-99/3380'), 3380);
    assert.equal(A.totalFromRange('100-199/3380'), 3380);
  });

  // ⚠️ THE TRAP. `Number('')` and `Number('   ')` are both 0, not NaN, so a malformed header
  // would report a real-looking population of ZERO — "nobody is suppressed" on a table with
  // 3,380 rows in it. Blanks must be rejected BEFORE the coercion.
  await t('a blank total is null (unknown), NEVER zero', () => {
    assert.strictEqual(A.totalFromRange('0-24/'), null);
    assert.strictEqual(A.totalFromRange('0-24/   '), null);
  });

  await t('`*` (no count requested) is null, not zero', () => {
    assert.strictEqual(A.totalFromRange('0-24/*'), null);
  });

  await t('a missing or malformed header is null', () => {
    assert.strictEqual(A.totalFromRange(null), null);
    assert.strictEqual(A.totalFromRange(undefined), null);
    assert.strictEqual(A.totalFromRange(''), null);
    assert.strictEqual(A.totalFromRange('garbage'), null);
  });

  await t('a negative or fractional total is not a row count', () => {
    assert.strictEqual(A.totalFromRange('0-24/-1'), null);
    assert.strictEqual(A.totalFromRange('0-24/1.5'), null);
  });

  await t('zero is a legitimate count and survives (an empty filter, not a broken header)', () => {
    assert.strictEqual(A.totalFromRange('*/0'), 0);
  });

  await t('sbProfile surfaces content-range when the response carries it', async () => {
    assert.equal(await rangeFrom('0-99/3380'), '0-99/3380');
  });

  // The guard that keeps this from being an outage rather than a missing number: sbProfile runs
  // inside live send paths, and a response object without `headers` must degrade to "no count".
  await t('a response with NO headers object degrades to null instead of throwing', async () => {
    global.fetch = async () => ({ ok: true, status: 200, text: async () => '[]' });
    const r = await A.sbProfile('comms')('/rest/v1/suppressions?select=*',
      { SUPABASE_URL: 'https://x', SUPABASE_SERVICE_ROLE_KEY: 'k' });
    assert.strictEqual(r.range, null);
    assert.strictEqual(r.ok, true);
  });

  global.fetch = origFetch;
  console.log(`\n  ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
