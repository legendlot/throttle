// S355 — bot transcript rows + thread rail (spec §5.3, §5.5). Real imports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { botOutboundRows, botThreadPatch, flattenReply } from './bot-forward.js';

test('bot rows carry the relay_bot marker, no user, uniform keys, options flattened', () => {
  const rows = botOutboundRows({ threadId: 'T', wabaPhoneNumberId: 'PN', now: '2026-09-07T10:00:00.000Z',
    replies: [{ text: 'Hi', buttons: [{ id: 'a', label: 'Track' }, { id: 'b', label: 'Agent' }] }, { text: 'Bye', buttons: null }] });
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.template_name, 'relay_bot'); assert.equal(r.sent_by_user_id, null); assert.equal(r.sent_by_name, 'Relay (bot)');
    assert.equal(r.direction, 'outbound'); assert.equal(r.status, 'sent'); assert.equal(r.waba_phone_number_id, 'PN'); assert.equal(r.is_internal, false);
    assert.deepEqual(Object.keys(r).sort(), Object.keys(rows[0]).sort());
  }
  assert.equal(rows[0].body, 'Hi\n1. Track\n2. Agent');
  assert.equal(flattenReply({ text: 'x', buttons: [] }), 'x');
  // explicit created_at, strictly increasing, all after the inbound's timestamp
  assert.ok(rows[0].created_at > '2026-09-07T10:00:00.000Z' && rows[1].created_at > rows[0].created_at);
  assert.equal(rows[0].created_at, rows[0].sent_at);
});
test('thread patch: active -> bot_active; handoff -> open+unassigned; ended -> closed bot_resolved', () => {
  const now = '2026-09-07T10:00:00.000Z';
  assert.deepEqual(botThreadPatch({ session_status: 'active', handoff: false, thread: { thread_state: 'open' }, now }), { bot_active: true });
  const h = botThreadPatch({ session_status: 'handed_off', handoff: true, thread: { thread_state: 'closed' }, now });
  assert.equal(h.bot_active, false); assert.equal(h.thread_state, 'open'); assert.equal(h.closed_reason, null);
  const e = botThreadPatch({ session_status: 'ended', handoff: false, thread: { thread_state: 'open' }, now });
  assert.deepEqual(e, { bot_active: false, thread_state: 'closed', closed_at: now, closed_reason: 'bot_resolved', closed_by_user_id: null });
});
