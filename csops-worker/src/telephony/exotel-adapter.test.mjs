// Regression tests for the Exotel adapter and client helpers.
//
//     npm test
//
// The two things pinned hardest here are the ones that fail SILENTLY in production:
// the status mapping (a wrong map produces plausible numbers, not an error) and the
// IST↔UTC handling (a UTC window queries a 5h30m-displaced slice of the day and the
// poller looks like it is working while recording nothing).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapExotelStatus, needsCallback, exotelToNormalised, exotelCallPatch, isSettled,
} from './exotel-adapter.js';
import { toIstNaive, fromIstNaive, unwrapCalls, nextCursorOf } from './exotel-client.js';

// ── status mapping — where the missed-call defect gets fixed ─────────────────

test('a completed call with talk time is answered; without it, abandoned', () => {
  assert.deepEqual(mapExotelStatus('completed', 143), { status: 'answered',  dial_status: 'completed' });
  assert.deepEqual(mapExotelStatus('completed', 0),   { status: 'abandoned', dial_status: 'completed' });
  assert.deepEqual(mapExotelStatus('completed', null),{ status: 'abandoned', dial_status: 'completed' });
});

test('unanswered outcomes become missed — this is the 0.25% defect', () => {
  // Under MyOperator `missed` sat on 45 of 17,705 rows at ~110 calls/day because it
  // only fired when call.end reported duration=0. Exotel reports the real outcome.
  assert.equal(mapExotelStatus('no-answer', 0).status, 'missed');
  assert.equal(mapExotelStatus('busy', 0).status,      'missed');
  assert.equal(mapExotelStatus('canceled', 0).status,  'missed');
  assert.equal(mapExotelStatus('failed', 0).status,    'failed');
  // dial_status keeps the granularity `status` throws away
  assert.equal(mapExotelStatus('busy', 0).dial_status, 'busy');
  assert.equal(mapExotelStatus('no-answer', 0).dial_status, 'no-answer');
});

test('in-flight calls are in_progress, and an unknown status never invents one', () => {
  assert.equal(mapExotelStatus('queued', 0).status, 'in_progress');
  assert.equal(mapExotelStatus('in-progress', 0).status, 'in_progress');

  const logged = [];
  const orig = console.log; console.log = (...a) => logged.push(a.join(' '));
  try {
    const r = mapExotelStatus('teleported', 0);
    assert.equal(r.status, 'in_progress', 'status is NOT NULL and CHECK-constrained — never guess');
    assert.equal(r.dial_status, 'teleported', 'the raw value is preserved, not discarded');
    assert.ok(logged.some(l => /unmapped status "teleported"/.test(l)));
  } finally { console.log = orig; }
});

test('every mapped status is one the DB CHECK actually admits', () => {
  const ALLOWED = new Set(['answered','missed','abandoned','in_progress','failed','busy','no_answer']);
  for (const s of ['completed','no-answer','busy','failed','canceled','queued','in-progress','nonsense']) {
    assert.ok(ALLOWED.has(mapExotelStatus(s, 0).status), `${s} maps outside the CHECK`);
  }
});

test('only inbound missed/abandoned calls raise needs_callback', () => {
  assert.equal(needsCallback('missed', 'incoming'), true);
  assert.equal(needsCallback('abandoned', 'incoming'), true);
  assert.equal(needsCallback('answered', 'incoming'), false);
  assert.equal(needsCallback('missed', 'outgoing'), false, 'we do not call ourselves back');
});

// ── IST handling — a UTC window silently queries the wrong day ───────────────

test('the DateCreated filter is built in IST, not UTC', () => {
  // 2026-08-20T09:00:00Z is 14:30 IST. A UTC-built filter would ask Exotel for 09:00,
  // i.e. a window 5h30m in the past — the poller would run clean and record nothing.
  assert.equal(toIstNaive(new Date('2026-08-20T09:00:00Z')), '2026-08-20 14:30:00');
  assert.equal(toIstNaive(new Date('2026-08-20T18:45:00Z')), '2026-08-21 00:15:00',
    'must roll the date over, not just the clock');
});

test('naive Exotel timestamps are parsed as IST and stored as UTC', () => {
  assert.equal(fromIstNaive('2026-08-20 14:30:00'), '2026-08-20T09:00:00.000Z');
  // An explicit offset is trusted rather than double-shifted.
  assert.equal(fromIstNaive('2026-08-20T09:00:00Z'), '2026-08-20T09:00:00.000Z');
  // Garbage must not become an Invalid Date in a DB write.
  assert.equal(fromIstNaive('not a date'), null);
  assert.equal(fromIstNaive(null), null);
  assert.equal(fromIstNaive(''), null);
});

test('IST round-trips', () => {
  const d = new Date('2026-08-20T09:00:00Z');
  assert.equal(fromIstNaive(toIstNaive(d)), d.toISOString());
});

// ── normalisation ───────────────────────────────────────────────────────────

const inboundCall = {
  Sid: 'CA-in-1', Status: 'completed', Direction: 'inbound',
  From: '09876543210', To: '08044656833', PhoneNumber: '08044656833',
  DateCreated: '2026-08-20 14:30:00', StartTime: '2026-08-20 14:30:02',
  EndTime: '2026-08-20 14:32:25', Duration: '143', Price: '0.85',
  RecordingUrl: 'https://recordings.exotel.com/x.mp3',
  Details: { ConversationDuration: '120', Legs: [{ Id: 1, Status: 'completed' }] },
};

test('inbound: From is the customer, To is our ExoPhone', () => {
  const n = exotelToNormalised(inboundCall);
  assert.equal(n.customer_phone, '09876543210');
  assert.equal(n.exophone, '08044656833');
  assert.equal(n.direction, 'incoming');
  assert.equal(n.status, 'answered');
  assert.equal(n.provider, 'exotel');
  assert.equal(n.call_session_id, 'CA-in-1');
  assert.equal(n.provider_call_sid, 'CA-in-1', 'the sid must be mirrored into both');
  assert.equal(n.talk_duration_seconds, 120);
  assert.equal(n.leg_duration_seconds, 143);
  assert.equal(n.price_inr, 0.85);
  assert.equal(n.started_at, '2026-08-20T09:00:02.000Z');
});

test('outbound: To is the customer — getting this backwards files calls against ourselves', () => {
  const n = exotelToNormalised({
    ...inboundCall, Sid: 'CA-out-1', Direction: 'outbound-api',
    From: '07022269161', To: '09876543210', PhoneNumber: '08044656833',
  });
  assert.equal(n.direction, 'outgoing');
  assert.equal(n.customer_phone, '09876543210');
  assert.equal(n.exophone, '08044656833');
});

test('a greeting-hangup normalises to abandoned with a callback flag', () => {
  const n = exotelToNormalised({
    ...inboundCall, Sid: 'CA-drop', Duration: '6',
    Details: { ConversationDuration: '0' },
  });
  assert.equal(n.status, 'abandoned');
  assert.equal(exotelCallPatch(n).needs_callback, true);
});

// ── the patch: never clobber a settled value with a null ─────────────────────

test('duration_seconds keeps its ORIGINAL meaning so no existing metric shifts', () => {
  const p = exotelCallPatch(exotelToNormalised(inboundCall));
  assert.equal(p.duration_seconds, 143, 'leg time, as MyOperator always wrote');
  assert.equal(p.talk_duration_seconds, 120, 'talk time is the NEW column');
});

test('an unsettled call omits null fields rather than wiping a later top-up', () => {
  // Exotel settles Duration/Price/EndTime/RecordingUrl ~2 min after the call ends, so
  // the first read carries nulls. Writing them would erase what the settle pass filled.
  const early = exotelToNormalised({
    Sid: 'CA-early', Status: 'in-progress', Direction: 'inbound',
    From: '09876543210', To: '08044656833', DateCreated: '2026-08-20 14:30:00',
  });
  const p = exotelCallPatch(early);
  assert.equal(p.status, 'in_progress');
  assert.ok(!('duration_seconds' in p), 'a null duration must not be written');
  assert.ok(!('price_inr' in p));
  assert.ok(!('recording_url' in p));
  assert.ok('started_at' in p, 'but values we DO have are written');
});

test('isSettled distinguishes "still filling in" from "legitimately empty"', () => {
  assert.equal(isSettled(exotelToNormalised(inboundCall)), true);
  assert.equal(isSettled(exotelToNormalised({ ...inboundCall, Status: 'in-progress' })), false);
  // A missed call has no talk time and never will — it is settled, not pending.
  assert.equal(isSettled(exotelToNormalised({
    ...inboundCall, Status: 'no-answer', Duration: null, Details: {},
  })), true);
  // A completed call still missing its durations is NOT settled.
  assert.equal(isSettled(exotelToNormalised({
    ...inboundCall, Duration: null, Details: {},
  })), false);
});

// ── response envelope ───────────────────────────────────────────────────────

test('call lists unwrap from every shape Exotel returns', () => {
  // Getting this wrong yields "0 calls" rather than an error — the quietest failure.
  assert.equal(unwrapCalls({ Calls: [{ Sid: 'a' }, { Sid: 'b' }] }).length, 2);
  assert.equal(unwrapCalls({ Call: { Sid: 'a' } }).length, 1, 'single-call responses use Call, not Calls');
  assert.equal(unwrapCalls([{ Sid: 'a' }]).length, 1);
  assert.equal(unwrapCalls(null).length, 0);
  assert.equal(unwrapCalls({}).length, 0);
});

test('the paging cursor is read out of NextPageUri', () => {
  assert.equal(nextCursorOf({ Metadata: { NextPageUri: '/v1/Accounts/x/Calls.json?After=abc123&PageSize=100' } }), 'abc123');
  assert.equal(nextCursorOf({ Metadata: {} }), null, 'no cursor = last page, must terminate the walk');
  assert.equal(nextCursorOf({}), null);
  assert.equal(nextCursorOf(null), null);
});
