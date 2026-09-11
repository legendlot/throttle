// S355 — bot transcript rows + thread rail (spec §5.3, §5.5). Real imports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { botOutboundRows, botThreadPatch, declinedTurnPatch, flattenReply, railLive, BOT_RAIL_TTL_MS } from './bot-forward.js';

test('bot rows carry the relay_bot marker, no user, uniform keys, options flattened, ticket_id', () => {
  const rows = botOutboundRows({ threadId: 'T', wabaPhoneNumberId: 'PN', ticketId: 'TK1', now: '2026-09-07T10:00:00.000Z',
    replies: [{ text: 'Hi', buttons: [{ id: 'a', label: 'Track' }, { id: 'b', label: 'Agent' }] }, { text: 'Bye', buttons: null }] });
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.template_name, 'relay_bot'); assert.equal(r.sent_by_user_id, null); assert.equal(r.sent_by_name, 'Relay (bot)');
    assert.equal(r.direction, 'outbound'); assert.equal(r.status, 'sent'); assert.equal(r.waba_phone_number_id, 'PN'); assert.equal(r.is_internal, false);
    assert.equal(r.ticket_id, 'TK1');
    assert.deepEqual(Object.keys(r).sort(), Object.keys(rows[0]).sort());
  }
  assert.equal(rows[0].body, 'Hi\n1. Track\n2. Agent');
  assert.equal(flattenReply({ text: 'x', buttons: [] }), 'x');
  // explicit created_at, strictly increasing, all after `now` — which the caller must pass as
  // the INSERT time (after the inbound row's created_at), not Meta's ts
  assert.ok(rows[0].created_at > '2026-09-07T10:00:00.000Z' && rows[1].created_at > rows[0].created_at);
  assert.equal(rows[0].created_at, rows[0].sent_at);
  // no ticket linked
  const noTicket = botOutboundRows({ threadId: 'T', wabaPhoneNumberId: 'PN', now: '2026-09-07T10:00:00.000Z', replies: [{ text: 'Hi' }] });
  assert.equal(noTicket[0].ticket_id, null);
});
test('thread patch: active -> bot_active; handoff -> open (reopened), bot_active false; ended -> closed bot_resolved', () => {
  const now = '2026-09-07T10:00:00.000Z';
  assert.deepEqual(botThreadPatch({ session_status: 'active', handoff: false, thread: { thread_state: 'open' }, now }), { bot_active: true });
  const h = botThreadPatch({ session_status: 'handed_off', handoff: true, thread: { thread_state: 'closed' }, now });
  assert.equal(h.bot_active, false); assert.equal(h.thread_state, 'open'); assert.equal(h.closed_reason, null);
  const e = botThreadPatch({ session_status: 'ended', handoff: false, thread: { thread_state: 'open' }, now });
  assert.deepEqual(e, { bot_active: false, thread_state: 'closed', closed_at: now, closed_reason: 'bot_resolved', closed_by_user_id: null, snoozed_until: null });
});

// Fix round 2 (I1): the rail has no expiry writer — an abandoned session would hold the thread out
// of Awaiting/unread/auto-assign forever. Every READER time-boxes it to the customer's last inbound.
test('railLive: live inside 6h, dead after, dead when the rail is off or nothing came in', () => {
  const now = Date.parse('2026-09-08T12:00:00.000Z');
  const at = (ms) => new Date(now - ms).toISOString();
  assert.equal(railLive({ bot_active: true, last_inbound_at: at(60e3) }, now), true);
  assert.equal(railLive({ bot_active: true, last_inbound_at: at(BOT_RAIL_TTL_MS - 1000) }, now), true);
  assert.equal(railLive({ bot_active: true, last_inbound_at: at(BOT_RAIL_TTL_MS + 1000) }, now), false);
  assert.equal(railLive({ bot_active: false, last_inbound_at: at(60e3) }, now), false);
  assert.equal(railLive({ bot_active: true, last_inbound_at: null }, now), false);
  assert.equal(railLive(null, now), false);
  assert.equal(BOT_RAIL_TTL_MS, 6 * 3600 * 1000);
});

// Fix round 2 (I2): the bot never closes a thread a human owns.
test('thread patch: ended on an ASSIGNED thread drops the rail only, leaving it open for its owner', () => {
  const now = '2026-09-07T10:00:00.000Z';
  assert.deepEqual(botThreadPatch({ session_status: 'ended', handoff: false, thread: { thread_state: 'open', assigned_agent_id: 'AGENT1' }, now }), { bot_active: false });
  const un = botThreadPatch({ session_status: 'ended', handoff: false, thread: { thread_state: 'open', assigned_agent_id: null }, now });
  assert.equal(un.thread_state, 'closed'); assert.equal(un.closed_reason, 'bot_resolved');
});

// A paused/declining bot must not keep hiding the thread: every new customer line refreshes
// last_inbound_at, so a TRUE rail left behind would keep railLive true indefinitely.
test('declinedTurnPatch: a turn the bot did not take drops a live rail; a handled turn never does', () => {
  const on = { bot_active: true }, off = { bot_active: false };
  // no m.bot at all = every decline reason (paused, pilot, opt-out, human active, handoff, …) and a bot-side error
  assert.deepEqual(declinedTurnPatch(undefined, on), { bot_active: false });
  assert.deepEqual(declinedTurnPatch(null, on), { bot_active: false });
  assert.deepEqual(declinedTurnPatch({ handled: false }, on), { bot_active: false });
  // rail already off: nothing to write
  assert.deepEqual(declinedTurnPatch(undefined, off), {});
  assert.deepEqual(declinedTurnPatch(undefined, null), {});
  // handled turns (incl. the duplicate claim) leave the rail to botThreadPatch
  assert.deepEqual(declinedTurnPatch({ handled: true, session_status: 'active' }, on), {});
  assert.deepEqual(declinedTurnPatch({ handled: true, duplicate: true, session_status: 'active' }, on), {});
  // a message the bot never takes (reaction/location/contacts/unsupported) is not a decline
  for (const t of ['reaction', 'location', 'contacts', 'unsupported']) assert.deepEqual(declinedTurnPatch(undefined, on, t), {}, t);
  for (const t of ['text', 'button', 'interactive', 'image', undefined]) assert.deepEqual(declinedTurnPatch(undefined, on, t), { bot_active: false }, String(t));
  // end to end with the reader: paused bot, customer wrote 1 min ago -> rail no longer hides the thread
  const now = Date.parse('2026-09-11T12:00:00.000Z');
  const t = { bot_active: true, last_inbound_at: new Date(now - 60e3).toISOString() };
  assert.equal(railLive(t, now), true);
  assert.equal(railLive({ ...t, ...declinedTurnPatch(undefined, t) }, now), false);
});
