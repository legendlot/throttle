// The db-max-rows truncation detector (S289).
//
// PostgREST caps an unlimited read at db-max-rows — measured 2026-08-16 as exactly 5,000 against
// the live endpoint (`/rest/v1/units?select=upc` → 5,000 rows, `content-range: 0-4999/159092`) —
// and reports it ONLY in a header sbProfile discards. Three read sites had already been bitten,
// every one found by a user reporting a wrong number rather than by looking. These tests pin the
// detector so the class stays observable.
const assert = require('assert');
const A = require('../src/auth.js');

let pass = 0, fail = 0;
const t = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log('  ok  ', n); },
  (e) => { fail++; console.log('  FAIL', n, '\n        ', e.message); });

const origFetch = global.fetch;
const logs = [];
const origLog = console.log;

// Drive sbProfile with a stubbed fetch returning `n` rows, and capture what it logged.
async function run(path, n, opts = {}) {
  logs.length = 0;
  global.fetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify(Array.from({ length: n }, (_, i) => ({ i }))),
  });
  console.log = (...a) => { if (String(a[0]).startsWith('db_max_rows')) logs.push(a); };
  try {
    await A.sbProfile('comms')(path, { SUPABASE_URL: 'https://x', SUPABASE_SERVICE_ROLE_KEY: 'k' }, opts);
  } finally { console.log = origLog; }
  return logs.length;
}

(async () => {
  await t('the cap is 5,000 — the measured value, exported so nothing re-guesses it', () => {
    assert.equal(A.DB_MAX_ROWS, 5000);
  });

  await t('exactly the cap on an UNLIMITED read is flagged', async () => {
    assert.equal(await run('/rest/v1/messages?select=id', 5000), 1);
  });

  await t('under the cap is silent — the overwhelming normal case', async () => {
    assert.equal(await run('/rest/v1/messages?select=id', 4999), 0);
    assert.equal(await run('/rest/v1/messages?select=id', 0), 0);
  });

  await t('a caller that asked for a bounded page is NOT a truncation', async () => {
    // it asked for 5,000 and got 5,000 — that is the contract, not a silent loss
    assert.equal(await run('/rest/v1/messages?select=id&limit=5000', 5000), 0);
    assert.equal(await run('/rest/v1/messages?limit=5000&select=id', 5000), 0);
    // a Range-paged caller likewise
    assert.equal(await run('/rest/v1/messages?select=id', 5000, { headers: { Range: '0-4999' } }), 0);
  });

  await t('a non-array body never trips it (single-row reads, RPCs, errors)', async () => {
    logs.length = 0;
    global.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ total: 5000 }) });
    console.log = (...a) => { if (String(a[0]).startsWith('db_max_rows')) logs.push(a); };
    try {
      await A.sbProfile('comms')('/rest/v1/rpc/preview_segment', { SUPABASE_URL: 'https://x', SUPABASE_SERVICE_ROLE_KEY: 'k' }, {});
    } finally { console.log = origLog; }
    assert.equal(logs.length, 0);
  });

  global.fetch = origFetch;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
