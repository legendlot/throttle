import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelError, relTime, expiryNote, expiryDateInput, todayIst, allowedTeams, canPost, composerError, mirrorToast,
  announcementErrorText, mirrorStatus } from './announcements.js';

const NOW = Date.parse('2026-11-14T06:30:00.000Z');   // 12:00 IST

test('channel ids: blank is fine, C/G + 6 or more upper-case letters / digits, lower case accepted', () => {
  assert.equal(channelError(''), '');
  assert.equal(channelError(' c0zzorg01 '), '');
  assert.equal(channelError('G0ZZZZZZ'), '');
  for (const bad of ['#general', 'C12345', 'D0ZZZZZZ', 'U0ZZZZZZ', 'C0ZZ-ZZZ']) assert.ok(channelError(bad), bad);
});
test('relative time and expiry notes (IST)', () => {
  assert.equal(relTime('2026-11-14T06:29:40Z', NOW), 'just now');
  assert.equal(relTime('2026-11-14T06:00:00Z', NOW), '30m ago');
  assert.equal(relTime('2026-11-14T01:30:00Z', NOW), '5h ago');
  assert.equal(relTime('2026-11-12T06:30:00Z', NOW), '2d ago');
  assert.equal(relTime('2026-10-01T06:30:00Z', NOW), '01 Oct');
  assert.equal(relTime('', NOW), '');
  assert.equal(expiryNote('2026-11-20T18:29:59Z', NOW), 'Expires 20 Nov');
  assert.equal(expiryNote('2026-11-12T18:29:59Z', NOW), 'Expired 12 Nov');
  assert.equal(expiryNote(null, NOW), '');
  assert.equal(expiryDateInput('2026-11-20T18:29:59.000Z'), '2026-11-20');   // end of the IST day stays that day
  assert.equal(todayIst(Date.parse('2026-11-14T20:00:00Z')), '2026-11-15');
});
test('composer: allowed teams by name; checks before posting', () => {
  const deps = [{ id: 'b', name: 'ZZ Beta' }, { id: 'a', name: 'ZZ Alpha' }, { id: 'c', name: 'ZZ Gamma' }];
  assert.deepEqual(allowedTeams({ everyone: false, department_ids: ['b', 'a'] }, deps).map(t => t.name), ['ZZ Alpha', 'ZZ Beta']);
  assert.deepEqual(allowedTeams(null, deps), []);
  assert.equal(canPost({ everyone: false, department_ids: [] }), false);
  assert.equal(canPost({ everyone: false, department_ids: ['a'] }), true);
  assert.equal(canPost({ everyone: true, department_ids: [] }), true);
  const head = { everyone: false, department_ids: ['a'] };
  assert.equal(composerError({ title: ' ', body: 'x', audience: 'teams', team_ids: ['a'] }, head), 'Add a title.');
  assert.equal(composerError({ title: 'x', body: '', audience: 'teams', team_ids: ['a'] }, head), 'Write the announcement.');
  assert.equal(composerError({ title: 'x', body: 'x', audience: 'everyone' }, head), 'Only founders can post to everyone.');
  assert.equal(composerError({ title: 'x', body: 'x', audience: 'teams', team_ids: [] }, head), 'Pick at least one team.');
  assert.equal(composerError({ title: 'x', body: 'x'.repeat(5001), audience: 'teams', team_ids: ['a'] }, head), 'The announcement is over 5000 characters.');
  assert.equal(composerError({ title: 'x', body: 'x', audience: 'teams', team_ids: ['a'] }, head), '');
});
test('the post toast says where the Slack mirror goes', () => {
  assert.equal(mirrorToast({ mode: 'off', channels: [], skipped: [] }), 'Posted · Slack mirror is off');
  assert.equal(mirrorToast({ mode: 'test', channels: [{ target: 'everyone', channel: 'C0ZZORG01' }], skipped: [] }), 'Posted · Slack: test mode');
  assert.equal(mirrorToast({ mode: 'live', channels: [{ target: 'everyone', channel: 'C0ZZORG01' }], skipped: [] }), 'Posted · Slack: the org channel');
  assert.equal(mirrorToast({ mode: 'live', channels: [{ target: 'a', channel: 'C0ZZTEAMA' }], skipped: ['b'] }, { a: 'ZZ Alpha', b: 'ZZ Beta' }),
    'Posted · Slack: ZZ Alpha channel (ZZ Beta has no channel)');
  assert.equal(mirrorToast({ mode: 'live', channels: [], skipped: ['everyone'] }), 'Posted · not on Slack (no org channel set)');
});
test('worker refusals read as words; an unknown code is left to the caller', () => {
  assert.equal(announcementErrorText(new Error('not_your_team')), 'You can only post to the teams you head.');
  assert.equal(announcementErrorText(new Error('server_error: zz')), '');
});

test('composer chips: a sub-team reads "Parent › Child"; only the ids the worker allows', () => {
  const deps = [{ id: 'p', name: 'ZZ Parent' }, { id: 'c', name: 'ZZ Child', parent_department_id: 'p' }, { id: 'x', name: 'ZZ Other' }];
  assert.deepEqual(allowedTeams({ everyone: false, department_ids: ['p', 'c'] }, deps).map(t => t.name), ['ZZ Parent', 'ZZ Parent › ZZ Child']);
});
test('mirror status line (#6) from the post\'s slack results', () => {
  assert.equal(mirrorStatus([]), 'Slack: pending/none');
  assert.equal(mirrorStatus(null), 'Slack: pending/none');
  assert.equal(mirrorStatus([{ target: 'everyone', channel: null, mode: 'off', status: 'off' }]), 'Slack: mirror was off');
  assert.equal(mirrorStatus([{ target: 'everyone', channel: 'C0ZZORG01', mode: 'live', status: 'sent' }]), 'Slack: posted to #C0ZZORG01');
  assert.equal(mirrorStatus([{ target: 'a', channel: 'C0ZZA', mode: 'live', status: 'failed', error: 'not_in_channel' },
    { target: 'b', channel: null, mode: 'live', status: 'skipped', error: 'no_channel' }], { a: 'ZZ A', b: 'ZZ B' }),
    'Slack: ZZ A not_in_channel: invite the Docket bot · ZZ B skipped: no channel');
  assert.equal(mirrorStatus([{ target: 'everyone', channel: null, mode: 'test', status: 'skipped' },
    { target: 'test_dm', employee_id: 'e', mode: 'test', status: 'sent' }]), 'Slack: skipped: no channel · test DM sent');
  assert.equal(mirrorStatus([{ target: 'everyone', channel: 'C0ZZORG01', mode: 'test', status: 'test' }]),
    'Slack: test: would post to #C0ZZORG01 · no test recipients, nothing sent');
  assert.equal(mirrorStatus([{ target: 'everyone', channel: 'C0ZZORG01', mode: 'test', status: 'test' },
    { target: 'test_dm', mode: 'test', status: 'unmapped', error: 'no_slack_user' }]),
    'Slack: test: would post to #C0ZZORG01 · test DM failed for 1 (no_slack_user)');
});
