import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as h from './handoff.js';

const NOW = Date.parse('2026-11-12T10:00:00+05:30');
const base = { id: 't', handoff_to_department_id: 'd2', handoff_to_department_name: 'Design' };

test('not a hand-off → nothing', () => {
  assert.equal(h.isHandoff({}), false);
  assert.equal(h.handoffStatus({ id: 't' }), null);
  assert.equal(h.handoffChip(null), null);
});

test('status: waiting (team / team+person) and accepted (IST date)', () => {
  assert.deepEqual(h.handoffStatus(base, NOW), { tone: 'pending', text: 'Waiting for Design to accept' });
  assert.deepEqual(h.handoffStatus({ ...base, handoff_to_employee_name: 'Asha' }, NOW),
    { tone: 'pending', text: 'Waiting for Design/Asha to accept' });
  // 20:00 UTC = 01:30 IST next day
  assert.deepEqual(h.handoffStatus({ ...base, handoff_accepted_at: '2026-11-12T20:00:00Z', handoff_accepted_by_name: 'Ravi' }, NOW),
    { tone: 'accepted', text: 'Accepted by Ravi · Fri 13 Nov' });
});

test('chip: "→ team", pending until accepted', () => {
  assert.deepEqual(h.handoffChip(base), { label: '→ Design', pending: true, title: 'Hand-off to Design — not accepted yet' });
  assert.equal(h.handoffChip({ ...base, handoff_accepted_at: '2026-11-12T08:00:00Z' }).pending, false);
});

test('errors: hand-off codes worded, others fall through to the plan wording / the code', () => {
  assert.equal(h.handoffErrorText(new Error('handoff_same_team')), 'That’s this task’s own team.');
  assert.equal(h.handoffErrorText(new Error('handoff_receiver_team')), 'That person isn’t in that team.');
  assert.equal(h.handoffErrorText(new Error('handoff_top_level')), 'Only a top-level task can be a hand-off.');
  assert.ok(h.handoffErrorText(new Error('not_receiver')).length > 0);
  assert.ok(h.handoffErrorText(new Error('handoff_closed')).length > 0);
  assert.equal(h.handoffErrorText(new Error('weird_code')), 'weird_code');
});

test('pickers: own team left out; people only from the receiving team', () => {
  const t = h.teamOptions([{ id: 'd1', name: 'Ops' }, { id: 'd2', name: 'Design' }], 'd1');
  assert.deepEqual(t.map(o => o.value), ['', 'd2']);
  assert.equal(t[0].label, 'Not a hand-off');
  const p = h.receiverOptions([{ id: 'e1', full_name: 'A', department_id: 'd2' }, { id: 'e2', full_name: 'B', department_id: 'd1' }], 'd2', 'Design');
  assert.deepEqual(p, [{ value: '', label: 'Anyone in Design' }, { value: 'e1', label: 'A' }]);
  assert.equal(h.receiverOptions([{ id: 'e1', department_id: null }], null).length, 1);
});

test('canAcceptIncoming: never the giver, never twice, the worker flag wins', () => {
  assert.equal(h.canAcceptIncoming({ ...base, owner_employee_id: 'g' }, 'me'), true);
  assert.equal(h.canAcceptIncoming({ ...base, owner_employee_id: 'me' }, 'me'), false);
  assert.equal(h.canAcceptIncoming({ ...base, owner_employee_id: 'g', handoff_accepted_at: '2026-11-12T08:00:00Z' }, 'me'), false);
  assert.equal(h.canAcceptIncoming({ ...base, owner_employee_id: 'g', can_accept_handoff: false }, 'me'), false);
  assert.equal(h.canAcceptIncoming({ id: 'x' }, 'me'), false);
  assert.equal(h.handoffErrorText(new Error('handoff_receiver_inactive')), 'That person has left.');
});

test('groupIncoming: named-to-me vs the team, order kept', () => {
  const g = h.groupIncoming([{ id: 1, handoff_to_employee_id: 'me' }, { id: 2 }, { id: 3, handoff_to_employee_id: 'x' }, null], 'me');
  assert.deepEqual(g.me.map(t => t.id), [1]);
  assert.deepEqual(g.team.map(t => t.id), [2, 3]);
});

test('pack rows: direction and receiver wording', () => {
  assert.equal(h.handoffDirection({ direction: 'out', to_team_name: 'Design' }), '→ To Design');
  assert.equal(h.handoffDirection({ direction: 'in', from_team_name: 'Ops' }), '← From Ops');
  assert.equal(h.handoffDirection({ from_team_name: 'Ops', to_team_name: 'Design' }), 'Ops → Design');
  assert.equal(h.receiverText({ receiver_name: null }), 'no one named');
  assert.equal(h.receiverText({ receiver_name: 'Asha' }), 'Asha');
});
