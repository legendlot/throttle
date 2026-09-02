// Origin-scoped CORS on the PUBLIC blocks (`/web/*` bot widget, `/f/*` capture forms).
//
// The bug this pins (S332, 2026-09-02): `ok()`/`err()` in index.js build their Response from the
// module-level `CORS` const, which carries `Access-Control-Allow-Origin: *`. `corsHeaders()`
// returns `{}` for a disallowed origin, so a SET-ONLY loop leaves that wildcard in place and the
// allow-list enforces nothing. `/f/*` (SP1) shipped with the delete; `/web/*` did not.
//
// These assertions run against the REAL `makeWithCors` and the REAL wildcard-carrying Response
// shape, so they fail if either block regresses to a set-only loop.
const assert = require('assert');
const BW = require('../src/bot-web.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n        ', e.message); }
};

// Verbatim from index.js:41-48 — the wildcard is the whole point, so the test must carry it.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, apikey, Authorization',
};
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const err = (msg, status = 400) => json({ ok: false, error: msg }, status);

const ALLOWED = 'https://www.legendoftoys.com';
const EVIL = 'https://evil.example';

t('corsHeaders echoes an allowed origin', () => {
  assert.strictEqual(BW.corsHeaders(ALLOWED)['Access-Control-Allow-Origin'], ALLOWED);
});

t('corsHeaders returns {} for a disallowed origin', () => {
  assert.deepStrictEqual(BW.corsHeaders(EVIL), {});
});

t('corsHeaders returns {} for an absent Origin header', () => {
  assert.deepStrictEqual(BW.corsHeaders(''), {});
});

t('allowed origin: the wildcard is REPLACED by the caller origin', () => {
  const resp = BW.makeWithCors(BW.corsHeaders(ALLOWED))(err('not_found', 404));
  assert.strictEqual(resp.headers.get('Access-Control-Allow-Origin'), ALLOWED);
  assert.strictEqual(resp.status, 404);
});

// ⭐ THE REGRESSION TEST. A set-only loop passes every assertion above and fails this one.
t('disallowed origin: NO Access-Control-Allow-Origin header survives', () => {
  const resp = BW.makeWithCors(BW.corsHeaders(EVIL))(err('bad_origin', 403));
  assert.strictEqual(resp.headers.get('Access-Control-Allow-Origin'), null,
    'the module-level wildcard leaked through — origin scoping is decorative');
  assert.strictEqual(resp.status, 403);
});

t('absent Origin: NO Access-Control-Allow-Origin header survives', () => {
  const resp = BW.makeWithCors(BW.corsHeaders(''))(err('not_found', 404));
  assert.strictEqual(resp.headers.get('Access-Control-Allow-Origin'), null);
});

// The other two wildcard headers are harmless without ACAO (a browser needs ACAO to accept any of
// them) and are left in place deliberately — asserted so a future "tidy-up" is a conscious change.
t('the non-ACAO wildcard headers are left alone', () => {
  const resp = BW.makeWithCors(BW.corsHeaders(EVIL))(err('bad_origin', 403));
  assert.strictEqual(resp.headers.get('Access-Control-Allow-Methods'), 'GET, POST, OPTIONS');
});

t('the response body is untouched', async () => {
  const resp = BW.makeWithCors(BW.corsHeaders(EVIL))(err('bad_origin', 403));
  assert.strictEqual(resp.headers.get('Content-Type'), 'application/json');
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
