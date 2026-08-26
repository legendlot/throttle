// Tests for the Instagram token lifecycle.
//
//     node --test src/meta-token.test.mjs
//
// Two things are worth pinning here and they are both failure modes that would LOOK
// fine in the logs:
//   1. the decision gate — a */2 cron that ignored it would call Meta 720 times a day;
//   2. "refreshed but did not save" — the exact outcome the backlog item warned about
//      before this was built ("do not ship a refresh cron that discards the new token —
//      it would look like it worked and change nothing").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshDecision, refreshIgToken, REFRESH_BEFORE_DAYS } from './meta-token.js';

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);          // 2026-10-01T12:00:00Z
const iso = (ms) => new Date(ms).toISOString();
const days = (n) => n * 86400000;

// ── the gate ────────────────────────────────────────────────────────────────

test('a healthy token is left alone', () => {
  const d = refreshDecision({ ig_access_token: 't', ig_token_expires_at: iso(NOW + days(45)) }, NOW);
  assert.equal(d.act, false);
  assert.match(d.reason, /healthy/);
});

test('inside the refresh window it acts', () => {
  const d = refreshDecision({
    ig_access_token: 't',
    ig_token_expires_at: iso(NOW + days(REFRESH_BEFORE_DAYS - 1)),
    ig_refreshed_at: iso(NOW - days(30)),
  }, NOW);
  assert.equal(d.act, true);
});

test('a recent attempt blocks another — this is what stops a */2 cron hammering Meta', () => {
  const d = refreshDecision({
    ig_access_token: 't',
    ig_token_expires_at: iso(NOW + days(1)),
    ig_last_attempt_at: iso(NOW - 60 * 60 * 1000),   // 1h ago, floor is 6h
  }, NOW);
  assert.equal(d.act, false);
  assert.match(d.reason, /recently/);
});

test('an empty row bootstraps from the secret', () => {
  assert.deepEqual(refreshDecision({ ig_access_token: null }, NOW), { act: true, reason: 'bootstrap' });
});

test('unknown expiry refreshes rather than guessing one', () => {
  const d = refreshDecision({ ig_access_token: 't', ig_token_expires_at: null }, NOW);
  assert.equal(d.act, true);
  assert.match(d.reason, /unknown/);
});

test('an already-expired token does NOT call Meta, and says a human is needed', () => {
  const d = refreshDecision({ ig_access_token: 't', ig_token_expires_at: iso(NOW - days(1)) }, NOW);
  assert.equal(d.act, false);
  assert.match(d.reason, /EXPIRED/);
  assert.match(d.reason, /manual/);
});

test('a token under 24h old is not refreshed — Meta refuses those', () => {
  const d = refreshDecision({
    ig_access_token: 't',
    ig_token_expires_at: iso(NOW + days(2)),
    ig_refreshed_at: iso(NOW - 60 * 60 * 1000),
  }, NOW);
  assert.equal(d.act, false);
  assert.match(d.reason, /24h/);
});

// ── the persist step ────────────────────────────────────────────────────────

function stubSb(row, { patchReturns } = {}) {
  const calls = [];
  const sb = async (path, _env, opts = {}) => {
    calls.push({ path, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    if ((opts.method || 'GET') === 'GET') return { ok: true, status: 200, data: [row] };
    return patchReturns ?? { ok: true, status: 200, data: [{ ...row, ...JSON.parse(opts.body) }] };
  };
  return { sb, calls };
}
const okFetch = (token, expiresIn = 5184000) => async () => ({
  ok: true, status: 200, json: async () => ({ access_token: token, token_type: 'bearer', expires_in: expiresIn }),
});

test('a successful refresh PERSISTS the new token', async () => {
  const row = { id: 1, ig_access_token: 'old', ig_token_expires_at: iso(NOW + days(3)),
                ig_refreshed_at: iso(NOW - days(30)), ig_refresh_count: 2 };
  const { sb, calls } = stubSb(row);
  const r = await refreshIgToken({}, sb, { fetchImpl: okFetch('brand-new'), now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.refreshed, true);
  const patch = calls.find(c => c.method === 'PATCH');
  assert.ok(patch, 'it must write');
  assert.equal(patch.body.ig_access_token, 'brand-new');
  assert.equal(patch.body.ig_refresh_count, 3);
  assert.equal(patch.body.ig_last_error, null);
});

test('⭐ "refreshed but did not save" is reported as a FAILURE, not a success', async () => {
  const row = { id: 1, ig_access_token: 'old', ig_token_expires_at: iso(NOW + days(3)),
                ig_refreshed_at: iso(NOW - days(30)), ig_refresh_count: 0 };
  // The write silently keeps the OLD token — exactly the case that would otherwise be
  // logged as a healthy refresh and change nothing.
  const { sb } = stubSb(row, { patchReturns: { ok: true, status: 200, data: [{ ig_access_token: 'old' }] } });
  const r = await refreshIgToken({}, sb, { fetchImpl: okFetch('brand-new'), now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.error, /FAILED TO SAVE/);
});

test('a rejected refresh leaves the existing token in place', async () => {
  const row = { id: 1, ig_access_token: 'still-valid', ig_token_expires_at: iso(NOW + days(3)),
                ig_refreshed_at: iso(NOW - days(30)), ig_refresh_count: 0 };
  const { sb, calls } = stubSb(row);
  const bad = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'nope' } }) });
  const r = await refreshIgToken({}, sb, { fetchImpl: bad, now: NOW });
  assert.equal(r.ok, false);
  const patch = calls.find(c => c.method === 'PATCH');
  assert.equal(patch.body.ig_access_token, undefined, 'the live token must not be touched');
  assert.match(patch.body.ig_last_error, /nope/);
});

test('bootstrap adopts META_IG_TOKEN and refreshes from it in one pass', async () => {
  const row = { id: 1, ig_access_token: null, ig_refresh_count: 0 };
  const { sb, calls } = stubSb(row);
  const r = await refreshIgToken({ META_IG_TOKEN: 'from-secret' }, sb, { fetchImpl: okFetch('fresh'), now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.bootstrapped, true);
  assert.equal(calls.find(c => c.method === 'PATCH').body.ig_access_token, 'fresh');
});

test('bootstrap with no secret anywhere is a no-op, not a crash', async () => {
  const { sb } = stubSb({ id: 1, ig_access_token: null });
  const r = await refreshIgToken({}, sb, { fetchImpl: okFetch('x'), now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.skipped, /no token/);
});

test('the gate short-circuits before any network call', async () => {
  const row = { id: 1, ig_access_token: 't', ig_token_expires_at: iso(NOW + days(45)) };
  const { sb } = stubSb(row);
  let called = false;
  const r = await refreshIgToken({}, sb, { fetchImpl: async () => { called = true; }, now: NOW });
  assert.equal(called, false, 'Meta must not be called for a healthy token');
  assert.equal(r.ok, true);
  assert.match(r.skipped, /healthy/);
});
