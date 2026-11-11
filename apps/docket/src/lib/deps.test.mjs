import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dateClash, fmtDay, hiddenText, linkCount, rowBadge, isWaitingOn, doneConfirmText, bulkDoneConfirmText,
  sendDone, DECLINED, linkErrorMessage, historyLine } from './deps.js';

// 18:30Z is midnight IST — the boundary a UTC-day comparison gets wrong.
const T = (o) => ({ deadline: null, revised_deadline: null, ...o });

test('date clash: blocker due on a later IST day than this task', () => {
  const task = T({ deadline: '2026-11-25T06:00:00Z' });
  assert.equal(dateClash(task, { task_no: 'DKT-123', due: '2026-11-30T06:00:00Z', cleared: false }),
    'DKT-123 is due 30 Nov, after this task (25 Nov)');
  assert.equal(dateClash(task, { task_no: 'DKT-1', due: '2026-11-25T12:00:00Z', cleared: false }), null);   // same day
  assert.equal(dateClash(task, { task_no: 'DKT-1', due: '2026-11-20T06:00:00Z', cleared: false }), null);   // earlier
  assert.equal(dateClash(task, { task_no: 'DKT-1', due: '2026-11-30T06:00:00Z', cleared: true }), null);    // cleared
  assert.equal(dateClash(task, { task_no: 'DKT-1', due: null, cleared: false }), null);
  assert.equal(dateClash(T({}), { task_no: 'DKT-1', due: '2026-11-30T06:00:00Z', cleared: false }), null);  // no deadline
});

test('date clash: revised deadline wins, and the day is IST', () => {
  const task = T({ deadline: '2026-12-31T06:00:00Z', revised_deadline: '2026-11-25T06:00:00Z' });
  assert.ok(dateClash(task, { task_no: 'DKT-9', due: '2026-11-26T06:00:00Z', cleared: false }));
  // 25 Nov 19:00Z is 26 Nov IST — a day after a 25 Nov IST deadline.
  const t2 = T({ deadline: '2026-11-25T10:00:00Z' });
  assert.ok(dateClash(t2, { task_no: 'DKT-9', due: '2026-11-25T19:00:00Z', cleared: false }));
  assert.equal(fmtDay('2026-11-25T19:00:00Z'), '26 Nov');
});

test('hidden text never carries a number of the task, only a count', () => {
  assert.equal(hiddenText(1), '1 task you can’t see');
  assert.equal(hiddenText(3), '3 tasks you can’t see');
  assert.equal(hiddenText(0), '');
  assert.equal(hiddenText(undefined), '');
});

test('link count includes hidden links', () => {
  assert.equal(linkCount(null), 0);
  assert.equal(linkCount({ waiting_on: [{}], blocking: [], related: [{}, {}], hidden: { waiting_on: 1, blocking: 0, related: 0 } }), 4);
  assert.equal(linkCount({ waiting_on: [], blocking: [], related: [], hidden: {} }), 0);
});

test('row badge: waiting, blocking, cleared', () => {
  assert.equal(rowBadge({}), null);
  assert.equal(rowBadge({ waiting_open: 0, waiting_total: 0, blocking_open: 0 }), null);
  assert.deepEqual(rowBadge({ waiting_open: 2, waiting_total: 3, blocking_open: 0 }),
    { waiting: 2, blocking: 0, cleared: false, tip: 'Waiting on 2 open tasks' });
  assert.deepEqual(rowBadge({ waiting_open: 0, waiting_total: 1, blocking_open: 1 }),
    { waiting: 0, blocking: 1, cleared: true, tip: 'All 1 blocker cleared · Blocking 1 open task' });
  assert.equal(rowBadge({ waiting_open: '1', waiting_total: '1', blocking_open: '0' }).waiting, 1);   // PostgREST strings
});

test('409 waiting_on detection reads the status and the body', () => {
  const e = Object.assign(new Error('waiting_on'), { status: 409, detail: { ok: false, error: 'waiting_on' } });
  assert.equal(isWaitingOn(e), true);
  assert.equal(isWaitingOn(Object.assign(new Error('waiting_on'), { status: 422 })), false);
  assert.equal(isWaitingOn(Object.assign(new Error('changed'), { status: 409 })), false);
  assert.equal(isWaitingOn(null), false);
});

test('done confirm text: list, hidden count, hidden only', () => {
  assert.equal(doneConfirmText({ blockers: [{ task_no: 'DKT-4', title: 'Print run' }, { task_no: 'DKT-7', title: 'Art' }], hidden_open: 0 }, 'DKT-9'),
    'DKT-9 is still waiting on: DKT-4 Print run, DKT-7 Art. Mark done anyway?');
  assert.equal(doneConfirmText({ blockers: [{ task_no: 'DKT-4', title: 'Print run' }], hidden_open: 2 }, 'DKT-9'),
    'DKT-9 is still waiting on: DKT-4 Print run (+2 you can’t see). Mark done anyway?');
  assert.equal(doneConfirmText({ blockers: [], hidden_open: 1 }, 'DKT-9'),
    'DKT-9 is still waiting on: 1 task you can’t see. Mark done anyway?');
  assert.equal(bulkDoneConfirmText({ waiting_count: 3 }), '3 of these are waiting on open tasks. Mark all done anyway?');
  assert.equal(bulkDoneConfirmText({ waiting_ids: ['a'] }), '1 of these is waiting on open tasks. Mark all done anyway?');
});

test('sendDone: plain success, confirm → force, decline, other errors rethrown', async () => {
  const calls = [];
  const w409 = () => Object.assign(new Error('waiting_on'), { status: 409, detail: { error: 'waiting_on', blockers: [], hidden_open: 1 } });
  // no 409
  assert.equal(await sendDone(async (f) => { calls.push(f); return 'ok'; }, () => { throw new Error('asked'); }, () => ''), 'ok');
  assert.deepEqual(calls, [false]);
  // 409 → confirmed → resent with force
  const sent = [];
  let asked = '';
  const r = await sendDone(async (f) => { sent.push(f); if (!f) throw w409(); return 'forced'; }, (m) => { asked = m; return true; }, (d) => `hidden ${d.hidden_open}`);
  assert.equal(r, 'forced'); assert.deepEqual(sent, [false, true]); assert.equal(asked, 'hidden 1');
  // 409 → declined → no second write
  const sent2 = [];
  assert.equal(await sendDone(async (f) => { sent2.push(f); throw w409(); }, () => false, () => ''), DECLINED);
  assert.deepEqual(sent2, [false]);
  // anything else is the caller's error
  await assert.rejects(sendDone(async () => { throw Object.assign(new Error('forbidden'), { status: 403 }); }, () => true, () => ''), /forbidden/);
});

test('link refusal codes map to plain English', () => {
  for (const code of ['cycle', 'already_linked', 'self_link', 'recurring_task', 'archived_task', 'abandoned_read_only', 'other_abandoned', 'forbidden_other']) {
    const m = linkErrorMessage(new Error(code));
    assert.notEqual(m, code, code);
    assert.ok(!m.includes('—'), 'no em dash: ' + code);
  }
  assert.equal(linkErrorMessage(Object.assign(new Error('x'), { detail: { error: 'cycle' } })), linkErrorMessage(new Error('cycle')));
  assert.equal(linkErrorMessage(new Error('db_error: boom')), 'db_error: boom');
});

test('history lines for link events', () => {
  assert.equal(historyLine({ event_type: 'link_added', note: 'waiting on', new_value: 'DKT-4 · Print run' }), 'Added dependency: waiting on DKT-4 · Print run');
  assert.equal(historyLine({ event_type: 'link_removed', note: 'blocks', old_value: 'a task you can’t see' }), 'Removed dependency: blocks a task you can’t see');
  assert.equal(historyLine({ event_type: 'unblocked', new_value: 'DKT-4 · Print run' }), 'Unblocked: DKT-4 · Print run done');
  assert.equal(historyLine({ event_type: 'status_changed', new_value: 'done' }), null);
});
