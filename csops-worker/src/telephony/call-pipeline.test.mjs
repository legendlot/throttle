// Regression tests for the vendor-neutral call pipeline.
//
//     node --test src/telephony/
//
// Why this file exists (S301): the pipeline was extracted from the MyOperator handlers
// with the requirement "behaviour byte-identical", and the MyOperator path has had ZERO
// traffic since 2026-08-19 — so a regression in it is invisible until the day it is
// needed as a fallback. It also encodes two real incidents (S144 leg-picking, S156
// ticket ownership) that must not be re-derived by a future refactor.
//
// No framework: node:test + a stubbed `sb` that records every PostgREST call.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeCallPipeline, pickConnectedLeg, normaliseDirection, agentEmailFromLegs,
  COALESCE_WINDOW_MS,
} from './call-pipeline.js';

// ── stub harness ─────────────────────────────────────────────────────────────

/**
 * routes: array of [regexp, handler(path, opts) -> {ok,status,data}]
 * First match wins; anything unmatched returns an empty 200 so a missing stub shows
 * up as a failed assertion rather than a crash.
 */
function stubSb(routes) {
  const calls = [];
  const sb = async (path, _env, opts = {}) => {
    calls.push({ path, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    for (const [re, fn] of routes) {
      if (re.test(path) && (!fn.method || fn.method === (opts.method || 'GET'))) {
        return fn(path, opts);
      }
    }
    return { ok: true, status: 200, data: [] };
  };
  return { sb, calls };
}

const baseDeps = (sb) => ({
  env: {},
  sb,
  toE164: (raw) => (raw ? (String(raw).startsWith('+') ? String(raw) : '+91' + String(raw).replace(/\D/g, '').slice(-10)) : null),
  shopifyLookup: async () => ({ found: false, customer: null, recent_orders: [] }),
  resolveAgentByEmail: async () => ({ id: null, name: null }),
  inferOrderLink: () => null,
  SLA_DAYS: { pending: 7 },
});

const myopCall = (over = {}) => ({
  provider: 'myoperator',
  call_session_id: 'sess-1',
  provider_call_sid: null,
  account_id: 'acct-1',
  department_id: 'dept-1',
  direction: 'incoming',
  exophone: '+912262054541',
  customer_phone: '9876543210',
  started_at: '2026-08-20T10:00:00Z',
  legs: [],
  agent_ref: {},
  ...over,
});

// ── identity: the two vendors key differently, and that is load-bearing ──────

test('MyOperator keeps its original identity key (myop_account_id + call_session_id)', async () => {
  const { sb, calls } = stubSb([]);
  const pipe = makeCallPipeline(baseDeps(sb));
  await pipe.upsertCall(myopCall(), { status: 'answered' });

  const lookup = calls[0].path;
  assert.match(lookup, /myop_account_id=eq\.acct-1/);
  assert.match(lookup, /call_session_id=eq\.sess-1/);
  assert.doesNotMatch(lookup, /provider=eq/,
    'MyOperator must NOT key on provider — UNIQUE (myop_account_id, call_session_id) still governs it');
});

test('Exotel keys on (provider, provider_call_sid) and MIRRORS the sid into call_session_id', async () => {
  const { sb, calls } = stubSb([]);
  const pipe = makeCallPipeline(baseDeps(sb));
  await pipe.upsertCall(myopCall({
    provider: 'exotel', provider_call_sid: 'CAxyz', call_session_id: 'CAxyz', account_id: null,
  }), { status: 'in_progress' });

  assert.match(calls[0].path, /provider=eq\.exotel/);
  assert.match(calls[0].path, /provider_call_sid=eq\.CAxyz/);

  const insert = calls.find(c => c.method === 'POST' && c.path === '/rest/v1/cs_calls');
  assert.equal(insert.body.provider_call_sid, 'CAxyz');
  assert.equal(insert.body.call_session_id, 'CAxyz',
    'call_session_id is NOT NULL and ~20 call sites read it — the sid must be mirrored, not only stored in provider_call_sid');
});

test('a failed INSERT is reported, not swallowed', async () => {
  const { sb, calls } = stubSb([
    [/^\/rest\/v1\/cs_calls$/, () => ({ ok: false, status: 400, data: { message: 'boom' } })],
  ]);
  const errs = [];
  const origErr = console.error; console.error = (...a) => errs.push(a.join(' '));
  try {
    const pipe = makeCallPipeline(baseDeps(sb));
    const r = await pipe.upsertCall(myopCall(), { status: 'answered' });
    assert.equal(r, null);
    assert.ok(errs.some(e => /cs_calls insert failed 400/.test(e)),
      'a rejected insert must log — a customer phoning us and leaving no record is the dropped-reel failure class');
  } finally { console.error = origErr; }
});

// ── ticket policy ────────────────────────────────────────────────────────────

test('a call with no prior ticket creates one, credited to the vendor actor', async () => {
  const { sb, calls } = stubSb([
    [/cs_tickets\?call_session_id=/, () => ({ ok: true, status: 200, data: [] })],
    [/cs_tickets\?customer_phone=/,  () => ({ ok: true, status: 200, data: [] })],
    [/rpc\/next_cs_ticket_seq/,      () => ({ ok: true, status: 200, data: 42 })],
    [/^\/rest\/v1\/cs_tickets$/,     () => ({ ok: true, status: 201, data: [{ id: 999 }] })],
  ]);
  const pipe = makeCallPipeline(baseDeps(sb));
  const r = await pipe.ensureTicket(myopCall());

  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.match(r.ticket_no, /^CS-\d{4}-00042$/);

  const ins = calls.find(c => c.method === 'POST' && c.path === '/rest/v1/cs_tickets');
  assert.equal(ins.body.auto_created, true);
  assert.equal(ins.body.stage, 'intake');
  assert.equal(ins.body.disposition, 'pending');
  assert.equal(ins.body.intake_channel, 'phone');
  assert.equal(ins.body.created_by_name, 'MyOperator (auto)',
    'history/created_by must stay byte-identical — ~17,700 existing rows say this');

  const hist = calls.find(c => c.path === '/rest/v1/cs_ticket_history' && c.body?.field_name === 'ticket_created');
  assert.equal(hist.body.changed_by_name, 'MyOperator (auto)');
});

test('RULE-PITSTOP-018: a repeat call coalesces instead of spawning a duplicate ticket', async () => {
  const { sb, calls } = stubSb([
    [/cs_tickets\?call_session_id=/, () => ({ ok: true, status: 200, data: [] })],
    [/cs_tickets\?customer_phone=/,  () => ({ ok: true, status: 200, data: [{ id: 555, ticket_no: 'CS-2026-00100' }] })],
  ]);
  const pipe = makeCallPipeline(baseDeps(sb));
  const r = await pipe.ensureTicket(myopCall({ call_session_id: 'sess-2' }));

  assert.equal(r.coalesced_into, 'CS-2026-00100');
  assert.equal(r.ticket_id, 555);
  assert.ok(!calls.some(c => c.method === 'POST' && c.path === '/rest/v1/cs_tickets'),
    'coalescing must NOT create a ticket');
  const hist = calls.find(c => c.body?.field_name === 'call_coalesced');
  assert.equal(hist.body.new_value, 'sess-2');
});

test('coalescing is scoped to phone + department + window', async () => {
  const { sb, calls } = stubSb([
    [/cs_tickets\?call_session_id=/, () => ({ ok: true, status: 200, data: [] })],
    [/cs_tickets\?customer_phone=/,  () => ({ ok: true, status: 200, data: [] })],
    [/rpc\/next_cs_ticket_seq/,      () => ({ ok: true, status: 200, data: 1 })],
    [/^\/rest\/v1\/cs_tickets$/,     () => ({ ok: true, status: 201, data: [{ id: 1 }] })],
  ]);
  const pipe = makeCallPipeline(baseDeps(sb));
  await pipe.ensureTicket(myopCall());

  const q = calls.find(c => /cs_tickets\?customer_phone=/.test(c.path)).path;
  assert.match(q, /stage=not\.in\.\(closed,cancelled,rejected\)/);
  assert.match(q, /cs_department_id=eq\.dept-1/);
  const since = decodeURIComponent(q.match(/created_at=gte\.([^&]+)/)[1]);
  const ageMs = Date.now() - new Date(since).getTime();
  assert.ok(Math.abs(ageMs - COALESCE_WINDOW_MS) < 5000, 'window must be the 24h COALESCE_WINDOW_MS');
});

test('a second event for the SAME call relinks rather than creating a second ticket', async () => {
  const { sb, calls } = stubSb([
    [/cs_tickets\?call_session_id=/, () => ({ ok: true, status: 200, data: [{ id: 7, ticket_no: 'CS-2026-00007' }] })],
  ]);
  const pipe = makeCallPipeline(baseDeps(sb));
  const r = await pipe.ensureTicket(myopCall());
  assert.equal(r.deduped, true);
  assert.ok(!calls.some(c => c.method === 'POST' && c.path === '/rest/v1/cs_tickets'));
});

// ── S144: pick the leg that actually connected ───────────────────────────────

test('S144 — a routed call credits the agent who ANSWERED, not the one who missed', () => {
  const legs = [
    { agent: { email: 'maria@legendoftoys.com' },   status: 'no-answer', duration: 0 },
    { agent: { email: 'sunitha@legendoftoys.com' }, status: 'answered',  duration: 143 },
  ];
  assert.equal(agentEmailFromLegs(legs), 'sunitha@legendoftoys.com',
    'crediting the first leg is the exact S144 regression');
});

test('S144 — falls back to positive duration, then to the LAST agent leg', () => {
  assert.equal(pickConnectedLeg([
    { agent: { email: 'a@x.com' }, duration: 0 },
    { agent: { email: 'b@x.com' }, duration: 60 },
  ]).agent.email, 'b@x.com');

  assert.equal(pickConnectedLeg([
    { agent: { email: 'a@x.com' } },
    { agent: { email: 'b@x.com' } },
  ]).agent.email, 'b@x.com', 'no signal at all → the terminal hop, not the first');

  assert.equal(pickConnectedLeg([]), null);
  assert.equal(pickConnectedLeg(null), null);
  assert.equal(pickConnectedLeg([{ status: 'answered' }]), null, 'a leg with no agent is not a candidate');
});

// ── S156: who owns a coalesced call's ticket ─────────────────────────────────

test('S156 — an INCOMING coalesced call takes ownership of the ticket it attached to', async () => {
  const { sb, calls } = stubSb([
    [/cs_tickets\?call_session_id=/, () => ({ ok: true, status: 200, data: [] })],   // no ticket of its own
    [/cs_calls\?.*select=ticket_id/, () => ({ ok: true, status: 200, data: [{ ticket_id: 321 }] })],
  ]);
  const pipe = makeCallPipeline(baseDeps(sb));
  const r = await pipe.attributeAgent(myopCall({ direction: 'incoming' }),
    { agent: { id: 'u1', name: 'Sunitha B' } });

  assert.equal(r.ticket_id, 321);
  const patch = calls.find(c => c.path === '/rest/v1/cs_tickets?id=eq.321');
  assert.equal(patch.body.assigned_agent_name, 'Sunitha B');
});

test('S156 — an OUTGOING coalesced call NEVER steals the ticket', async () => {
  const { sb, calls } = stubSb([
    [/cs_tickets\?call_session_id=/, () => ({ ok: true, status: 200, data: [] })],
    [/cs_calls\?.*select=ticket_id/, () => ({ ok: true, status: 200, data: [{ ticket_id: 321 }] })],
  ]);
  const pipe = makeCallPipeline(baseDeps(sb));
  const r = await pipe.attributeAgent(myopCall({ direction: 'outgoing' }),
    { agent: { id: 'u1', name: 'Dhiraj Sharma' } });

  assert.equal(r.ticket_id, null);
  assert.ok(!calls.some(c => /cs_tickets\?id=eq/.test(c.path)),
    'an outgoing COD-confirmation call must not take a support ticket it merely coalesced into');
});

test('an unresolved agent still persists raw_meta and changes no assignment', async () => {
  const { sb, calls } = stubSb([]);
  const pipe = makeCallPipeline(baseDeps(sb));
  const r = await pipe.attributeAgent(myopCall(), { agent: null, callMeta: { last_event: 'summary' } });
  assert.equal(r.skipped, 'no agent resolved');
  const patch = calls.find(c => c.method === 'PATCH');
  assert.deepEqual(patch.body, { raw_meta: { last_event: 'summary' } });
});

// ── direction mapping — the dropped-reel failure class ───────────────────────

test('direction: known vocabularies map, unknown becomes NULL and is never passed through', () => {
  assert.equal(normaliseDirection('incoming'), 'incoming');
  assert.equal(normaliseDirection('inbound'), 'incoming');
  assert.equal(normaliseDirection('outgoing'), 'outgoing');
  assert.equal(normaliseDirection('outbound'), 'outgoing');
  assert.equal(normaliseDirection('outbound-dial'), 'outgoing', 'Exotel vocabulary');
  assert.equal(normaliseDirection('outbound-api'), 'outgoing',  'Exotel click-to-call');
  assert.equal(normaliseDirection('OUTBOUND-API'), 'outgoing',  'case-insensitive');

  const logged = [];
  const orig = console.log; console.log = (...a) => logged.push(a.join(' '));
  try {
    assert.equal(normaliseDirection('sideways', 'exotel'), null,
      'an unfamiliar value must be NULL — the CHECK passes on NULL so the call still records');
    assert.ok(logged.some(l => /unmapped direction "sideways"/.test(l)), 'and it must be logged');
  } finally { console.log = orig; }

  assert.equal(normaliseDirection(null), null);
  assert.equal(normaliseDirection(''), null);
});

// ── out-of-order delivery ────────────────────────────────────────────────────

test('out-of-order: call.end before call.answered still stamps started_at', async () => {
  // Regression guard for a defect introduced during the S301 extraction and caught on
  // review: the original delegated to webhookCallAnswered(), which stamped started_at
  // and reset raw_meta.last_event to 'answered' BEFORE creating the ticket. An
  // extraction that only calls ensureTicket() leaves started_at NULL forever whenever
  // call.answered never follows. Invisible in production — this path has had no traffic
  // since 2026-08-19 — so it is pinned here instead.
  const { sb, calls } = stubSb([
    [/cs_tickets\?call_session_id=/, () => ({ ok: true, status: 200, data: [] })],
    [/cs_tickets\?customer_phone=/,  () => ({ ok: true, status: 200, data: [] })],
    [/rpc\/next_cs_ticket_seq/,      () => ({ ok: true, status: 200, data: 5 })],
    [/^\/rest\/v1\/cs_tickets$/,     () => ({ ok: true, status: 201, data: [{ id: 5 }] })],
  ]);
  const pipe = makeCallPipeline(baseDeps(sb));
  const norm = myopCall();

  await pipe.upsertCall(norm, { status: 'answered', ended_at: 'x', raw_meta: { last_event: 'end' } });
  await pipe.upsertCall(norm, {
    status: 'answered', started_at: '2026-08-20T10:00:00Z', raw_meta: { last_event: 'answered' },
  });
  await pipe.ensureTicket(norm);

  const stamped = calls.filter(c => c.body && 'started_at' in c.body);
  assert.equal(stamped.length, 1, 'started_at must be written on the out-of-order path');
  assert.equal(stamped[0].body.raw_meta.last_event, 'answered');
});
