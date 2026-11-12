import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as r from './review.js';

const NOW = Date.parse('2026-11-12T10:00:00+05:30');   // Thu; this week ends Sun 15 Nov

test('fmtPct: one decimal, trailing .0 dropped, null/garbage → dash, string input', () => {
  assert.equal(r.fmtPct(83.3), '83.3%');
  assert.equal(r.fmtPct('100.0'), '100%');
  assert.equal(r.fmtPct(0), '0%');
  assert.equal(r.fmtPct(null), '—');
  assert.equal(r.fmtPct(undefined), '—');
  assert.equal(r.fmtPct('x'), '—');
});

test('missLabel: the three reasons, unknown passes through readable, none → empty', () => {
  assert.equal(r.missLabel('open'), 'not done');
  assert.equal(r.missLabel('done_late'), 'done late');
  assert.equal(r.missLabel('abandoned'), 'dropped');
  assert.equal(r.missLabel('re_opened'), 're opened');
  assert.equal(r.missLabel(null), '');
});

test('sourceNote: app and missing show nothing; connector is named', () => {
  assert.equal(r.sourceNote('app'), '');
  assert.equal(r.sourceNote(undefined), '');
  assert.equal(r.sourceNote('connector'), 'via connector');
  assert.equal(r.sourceNote('slack'), 'via Slack');
});

test('slackText: all teams = summary + every team, blank-line joined', () => {
  const pack = { team_id: null, slack: { summary: 'S', teams: [{ department_id: 'a', text: 'A' }, { department_id: 'b', text: 'B' }] } };
  assert.equal(r.slackText(pack), 'S\n\nA\n\nB');
});
test('slackText: one team = just that team, no summary', () => {
  const pack = { team_id: 'b', slack: { summary: 'S', teams: [{ department_id: 'a', text: 'A' }, { department_id: 'b', text: 'B' }] } };
  assert.equal(r.slackText(pack), 'B');
  assert.equal(r.slackText({ team_id: 'b', slack: { summary: 'S', teams: [{ department_id: 'b', text: 'B' }] } }), 'B');
});
test('slackText: missing pieces never print "undefined"', () => {
  assert.equal(r.slackText({}), '');
  assert.equal(r.slackText({ team_id: null, slack: { teams: [{ department_id: 'a', text: 'A' }] } }), 'A');
});

test('stepWeek / weekParam: ±7 days on the week end; the current week is "this"', () => {
  assert.equal(r.stepWeek('2026-11-15', -1), '2026-11-08');
  assert.equal(r.stepWeek('2026-11-15', 1), '2026-11-22');
  assert.equal(r.stepWeek('2026-12-27', 1), '2027-01-03');
  assert.equal(r.stepWeek('nope', 1), null);
  assert.equal(r.weekParam('2026-11-15', NOW), 'this');
  assert.equal(r.weekParam('2026-11-08', NOW), '2026-11-08');
  // a non-Sunday week end still resolves "this" on its own weekday (Sat 14 Nov)
  assert.equal(r.weekParam('2026-11-14', NOW), 'this');
});

test('weekState: opened → scored; a future start → future; otherwise unscored', () => {
  assert.equal(r.weekState({ opened: true, week_end: '2026-11-15' }, NOW), 'scored');
  assert.equal(r.weekState({ opened: false, week_end: '2026-11-15', week_start: '2026-11-09' }, NOW), 'unscored');
  assert.equal(r.weekState({ opened: false, week_end: '2026-11-22', week_start: '2026-11-16' }, NOW), 'future');
  assert.equal(r.weekState({ opened: false, week_end: '2026-11-22' }, NOW), 'future');
});

test('reviewHref: this + default team stay out of the URL', () => {
  assert.equal(r.reviewHref({ week: 'this' }), '/review');
  assert.equal(r.reviewHref({ week: '2026-11-08', team: 'all' }), '/review?week=2026-11-08&team=all');
  assert.equal(r.reviewHref({ week: 'last', team: '' }), '/review?week=last');
});

test('titles, touched, moved, bars, errors', () => {
  assert.equal(r.reviewTitle('2026-11-15', NOW), 'Review · week ending Sun 15 Nov');
  assert.equal(r.touchedText({ touched: 3, committed_open: 5, touched_pct: 60 }), '3/5 (60%)');
  assert.equal(r.touchedText({ touched: 0, committed_open: 0 }), '0/0');
  assert.equal(r.movedText(2), 'moved 2×');
  assert.equal(r.movedText(0), '');
  assert.equal(r.barPct(null), 0);
  assert.equal(r.barPct('120'), 100);
  assert.equal(r.tsDay('2026-11-15T20:00:00Z', NOW), 'Mon 16 Nov');   // 01:30 IST next day
  assert.equal(r.reviewErrorText(new Error('no_team')), 'Your profile has no team — ask an admin.');
  assert.equal(r.reviewErrorText(new Error('boom')), 'boom');
});

test('seenText / updateText: absent last_seen shows nothing; the 30-day lookback is never "never"', () => {
  assert.equal(r.seenText({ name: 'A' }), '');
  assert.equal(r.seenText({ last_seen: null }), 'never');
  assert.equal(r.seenText({ last_seen: '2026-11-12T08:35:00Z' }), '12 Nov 2026, 14:05');
  assert.equal(r.updateText({ last_update: null, last_update_older: true }), 'over 30 days ago');
  assert.equal(r.updateText({ last_update: null }), 'never');
  assert.equal(r.updateText({ last_update: '2026-11-12T08:35:00Z', last_update_older: true }), '12 Nov 2026, 14:05');
});
