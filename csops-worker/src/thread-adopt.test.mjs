// S362 (2026-09-09) — adoption of the phone's existing numberless thread. Real imports.
//
// The defect this covers: `handleRelayWebForward` looked its thread up by
// `relay_web_session_id` (new every session), so a returning customer's insert always hit
// `cs_wa_threads_phone_null_waba_idx` (UNIQUE customer_phone WHERE waba_phone_number_id IS
// NULL), csops answered 500 and the whole transcript was dropped.
//
// The guard worth defending is the LAST test: adoption must never relabel the thread it adopts.
// 8,977 of the 10,253 threads with a phone and no waba id are legacy `whatsapp`, so the thread the
// web bot adopts is usually a WhatsApp one, and writing `relay_web=true` onto it would break the
// positive marker that separates Relay web threads from the legacy Chatwoot web widget.
//
// ⚠️ AND A GREEN RUN HERE IS NOT ENOUGH ON ITS OWN — the S362 hostile review's sharpest point. That
// guard is exactly what left an adopted WhatsApp thread with `relay_web=false`, which the agent
// reply path then routed to the WhatsApp rail, 422'ing on a stale 24h window while the customer sat
// in the widget unanswered. The guard is right; the routing that read the flag was wrong. It now
// reads the rail off the newest message (`threadOnWebRail` in index.js) instead. If you ever relax
// this test, check that router too.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isUniqueViolation, adoptPatch, adoptNumberlessThread, ADOPT_PROTECTED_KEYS,
} from './thread-adopt.js';

const quiet = { error: () => {}, log: () => {} };
const THREAD = { id: 'T1', channel: 'whatsapp', relay_web: false, customer_phone: '+917709991011' };

/** Minimal sb() double: records calls, replays queued responses in order. */
function fakeSb(responses) {
  const calls = [];
  const q = [...responses];
  const fn = async (path, env, opts) => {
    calls.push({ path, method: opts?.method || 'GET', body: opts?.body ? JSON.parse(opts.body) : null });
    return q.shift();
  };
  fn.calls = calls;
  return fn;
}

// ── isUniqueViolation ────────────────────────────────────────────────────────

test('a 409 is a unique violation — that is what PostgREST returns for 23505', () => {
  assert.equal(isUniqueViolation({ status: 409, data: {} }), true);
});

test('SQLSTATE 23505 in the body counts even if the status is not 409', () => {
  assert.equal(isUniqueViolation({ status: 400, data: { code: '23505' } }), true);
});

test('other failures are NOT adopted into — a 500 or a 403 must keep failing loudly', () => {
  for (const res of [{ status: 500, data: {} }, { status: 403, data: { code: '42501' } },
                     { status: 201, data: [{}] }, null, undefined]) {
    assert.equal(isUniqueViolation(res), false, JSON.stringify(res));
  }
});

// S362 hostile review: PostgREST also maps FK and exclusion violations to 409. Adopting on one of
// those would turn a diagnosable error into a silent behaviour change, so the SQLSTATE decides
// whenever the body carries one.
test('a 409 that is NOT 23505 is refused — the SQLSTATE decides, not the status', () => {
  assert.equal(isUniqueViolation({ status: 409, data: { code: '23503' } }), false, 'foreign-key violation must not adopt');
  assert.equal(isUniqueViolation({ status: 409, data: { code: '23P01' } }), false, 'exclusion violation must not adopt');
  assert.equal(isUniqueViolation({ status: 409, data: { code: '23505' } }), true);
});

test('a 409 whose body did not parse still counts — status is the fallback, not the test', () => {
  assert.equal(isUniqueViolation({ status: 409, data: null }), true);
  assert.equal(isUniqueViolation({ status: 409, data: 'gateway junk' }), true);
});

// ── adoptNumberlessThread ────────────────────────────────────────────────────

test('the lookup asks for exactly the index predicate — phone AND a null waba id', async () => {
  const sb = fakeSb([{ ok: true, status: 200, data: [THREAD] }]);
  const t = await adoptNumberlessThread('+917709991011', {}, null, { sb, log: quiet });
  assert.equal(t.id, 'T1');
  assert.equal(sb.calls.length, 1, 'no patch when there is nothing to stamp');
  assert.match(sb.calls[0].path, /customer_phone=eq\.%2B917709991011/);
  assert.match(sb.calls[0].path, /waba_phone_number_id=is\.null/);
});

test('the web-bot patch stamps the session id so later turns of that session find it', async () => {
  const sb = fakeSb([
    { ok: true, status: 200, data: [THREAD] },
    { ok: true, status: 200, data: [{ ...THREAD, relay_web_session_id: 'S9' }] },
  ]);
  const t = await adoptNumberlessThread('+917709991011', {}, { relay_web_session_id: 'S9' }, { sb, log: quiet });
  assert.equal(sb.calls[1].method, 'PATCH');
  assert.deepEqual(sb.calls[1].body, { relay_web_session_id: 'S9' });
  assert.equal(t.relay_web_session_id, 'S9', 'the returned thread carries the stamp');
});

test('nothing to adopt returns null — the caller must report its ORIGINAL error, not invent a thread', async () => {
  const sb = fakeSb([{ ok: true, status: 200, data: [] }]);
  assert.equal(await adoptNumberlessThread('+917709991011', {}, null, { sb, log: quiet }), null);
});

test('a failed patch returns null rather than a half-adopted thread', async () => {
  const sb = fakeSb([
    { ok: true, status: 200, data: [THREAD] },
    { ok: false, status: 500, data: { message: 'boom' } },
  ]);
  assert.equal(await adoptNumberlessThread('+917709991011', {}, { relay_web_session_id: 'S9' }, { sb, log: quiet }), null);
});

test('no phone and no sb are both refused before any network call', async () => {
  const sb = fakeSb([]);
  assert.equal(await adoptNumberlessThread(null, {}, null, { sb, log: quiet }), null);
  assert.equal(await adoptNumberlessThread('+917709991011', {}, null, {}), null);
  assert.equal(sb.calls.length, 0);
});

// ── THE INVARIANT ────────────────────────────────────────────────────────────

test('adoption NEVER rewrites channel or relay_web — the adopted thread is usually a WhatsApp one', async () => {
  const sb = fakeSb([
    { ok: true, status: 200, data: [THREAD] },
    { ok: true, status: 200, data: [THREAD] },
  ]);
  const t = await adoptNumberlessThread('+917709991011', {},
    { relay_web_session_id: 'S9', channel: 'web', relay_web: true }, { sb, log: quiet });

  assert.deepEqual(sb.calls[1].body, { relay_web_session_id: 'S9' }, 'protected keys must not reach the DB');
  assert.equal(t.channel, 'whatsapp', 'the thread keeps its own channel');
  assert.equal(t.relay_web, false, 'the legacy-vs-Relay web marker survives adoption');
});

test('adoptPatch reports what it dropped, and the protected list is the documented pair', () => {
  const { patch, dropped } = adoptPatch({ a: 1, channel: 'web', relay_web: true });
  assert.deepEqual(patch, { a: 1 });
  assert.deepEqual(dropped.sort(), ['channel', 'relay_web']);
  assert.deepEqual([...ADOPT_PROTECTED_KEYS].sort(), ['channel', 'relay_web']);
  assert.deepEqual(adoptPatch(null).patch, {}, 'a null patch is an empty patch, not a throw');
});
