import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INTERVIEW_MODES, VERDICTS, RECOMMENDATIONS, PANEL_DOC_TYPES, SCHEDULE_APP_STATUSES, MAX_CRITERIA, MAX_PANEL,
  cleanRoundName, cleanScorecard, cleanPanelIds, parseScheduledAt, cleanInterviewFields, dueAt, canSchedule,
  verdictMove, verdictBlock, checkFeedback, feedbackBlock, canSeeFeedback, feedbackState, remindAllowed, panelView,
  interviewSummary, myInterviewBuckets, panelDocs, istLabel, buildReminderMail, reminderMessageId, interviewDbErrorCode,
  panelSelfBlock, seatState,
} from '../src/interviews.js';
import { OUTCOME_REASON_CODES, checkTransition } from '../src/hiring.js';

const NOW = Date.parse('2026-11-12T10:00:00Z');
const H = 3600 * 1000;
const iso = (t) => new Date(t).toISOString();
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('enums match the migration CHECKs', () => {
  assert.deepEqual(INTERVIEW_MODES, ['in_person', 'video', 'phone']);
  assert.deepEqual(VERDICTS, ['advance', 'reject', 'hold']);
  assert.deepEqual(RECOMMENDATIONS, ['strong_yes', 'yes', 'no', 'strong_no']);
  assert.deepEqual(PANEL_DOC_TYPES, ['cv', 'education', 'experience_letter']);
  assert.deepEqual(SCHEDULE_APP_STATUSES, ['new', 'screening', 'interviewing']);
});

test('round name: trimmed, required, capped', () => {
  assert.deepEqual(cleanRoundName('  Tech   round '), { name: 'Tech round' });
  assert.equal(cleanRoundName('  ').error, 'round_name_required');
  assert.equal(cleanRoundName('x'.repeat(81)).error, 'round_name_too_long');
});

test('scorecard: keys derived from labels, unique, max 10', () => {
  assert.deepEqual(cleanScorecard(null), { scorecard: [] });
  const r = cleanScorecard([{ label: 'Problem solving' }, { key: 'comm', label: ' Communication ' }, 'Culture fit']);
  assert.deepEqual(r.scorecard, [
    { key: 'problem_solving', label: 'Problem solving' }, { key: 'comm', label: 'Communication' }, { key: 'culture_fit', label: 'Culture fit' },
  ]);
  assert.equal(cleanScorecard([{ label: 'A b' }, { label: 'a-b' }]).error, 'duplicate_criteria');
  assert.equal(cleanScorecard([{ label: '' }]).error, 'criterion_label_required');
  assert.equal(cleanScorecard([{ key: 'Bad Key', label: 'x' }]).error, 'bad_criterion_key');
  assert.equal(cleanScorecard(Array.from({ length: MAX_CRITERIA + 1 }, (_, i) => ({ label: `c${i}` }))).error, 'too_many_criteria');
  assert.equal(cleanScorecard('nope').error, 'bad_scorecard');
});

test('panel ids: deduped uuids, 1..10 (0 allowed for round defaults)', () => {
  assert.deepEqual(cleanPanelIds([U(1), U(1), U(2)]).ids, [U(1), U(2)]);
  assert.equal(cleanPanelIds([]).error, 'panel_required');
  assert.deepEqual(cleanPanelIds([], { min: 0 }).ids, []);
  assert.equal(cleanPanelIds(['x']).error, 'bad_panel');
  assert.equal(cleanPanelIds(Array.from({ length: MAX_PANEL + 1 }, (_, i) => U(i + 1))).error, 'panel_too_large');
});

test('scheduled_at: ISO, at most 30 days back and a year ahead', () => {
  assert.equal(parseScheduledAt('2026-11-13T05:30:00+05:30', NOW).iso, '2026-11-13T00:00:00.000Z');
  assert.equal(parseScheduledAt('', NOW).error, 'time_required');
  assert.equal(parseScheduledAt('soon', NOW).error, 'bad_time');
  assert.equal(parseScheduledAt(iso(NOW - 31 * 24 * H), NOW).error, 'bad_time');
  assert.equal(parseScheduledAt(iso(NOW + 366 * 24 * H), NOW).error, 'bad_time');
  assert.ok(parseScheduledAt(iso(NOW - 2 * H), NOW).iso);
});

test('interview fields: mode / duration / location', () => {
  assert.deepEqual(cleanInterviewFields({}, { requireAll: true }).patch, { mode: 'in_person', duration_min: 60 });
  assert.deepEqual(cleanInterviewFields({ mode: 'video', duration_min: '45', location: ' Meet link ' }).patch, { mode: 'video', duration_min: 45, location: 'Meet link' });
  assert.equal(cleanInterviewFields({ mode: 'zoom' }).error, 'bad_mode');
  assert.equal(cleanInterviewFields({ duration_min: 5 }).error, 'bad_duration');
  assert.equal(cleanInterviewFields({ location: 'x'.repeat(501) }).error, 'location_too_long');
  assert.deepEqual(cleanInterviewFields({ location: '' }).patch, { location: null });
});

test('due = scheduled + 24h', () => {
  assert.equal(dueAt('2026-11-12T10:00:00Z'), '2026-11-13T10:00:00.000Z');
  assert.equal(dueAt(null), null);
});

test('schedule only while new / screening / interviewing', () => {
  for (const s of ['new', 'screening', 'interviewing']) assert.equal(canSchedule(s), true);
  for (const s of ['offer', 'accepted', 'on_hold', 'rejected', 'joined']) assert.equal(canSchedule(s), false);
});

test('verdict: advance changes nothing, reject needs a reason, hold → on_hold', () => {
  assert.equal(verdictMove('advance'), null);
  assert.deepEqual(verdictMove('reject'), { to: 'rejected', reasonRequired: true });
  assert.deepEqual(verdictMove('hold'), { to: 'on_hold', reasonRequired: false });
  assert.equal(verdictMove('maybe').error, 'bad_verdict');
  // The application move reuses setApplicationStatus's transition table.
  assert.equal(checkTransition('interviewing', 'rejected', 'skills'), null);
  assert.equal(checkTransition('interviewing', 'rejected', null), 'reason_required');
  assert.equal(checkTransition('interviewing', 'on_hold', null), null);
  assert.ok(OUTCOME_REASON_CODES.includes('not_a_fit'));
});

test('verdict: scheduled / completed, time passed, once', () => {
  const past = { status: 'scheduled', scheduled_at: iso(NOW - H), verdict: null };
  assert.equal(verdictBlock(past, NOW), null);
  assert.equal(verdictBlock({ ...past, status: 'completed' }, NOW), null);
  assert.equal(verdictBlock({ ...past, scheduled_at: iso(NOW + H) }, NOW), 'too_early');
  assert.equal(verdictBlock({ ...past, status: 'cancelled' }, NOW), 'interview_closed');
  assert.equal(verdictBlock({ ...past, status: 'no_show' }, NOW), 'interview_closed');
  assert.equal(verdictBlock({ ...past, verdict: 'advance' }, NOW), 'verdict_exists');
});

const CARD = [{ key: 'craft', label: 'Craft' }, { key: 'comm', label: 'Communication' }];

test('feedback: rating 1-5, a recommendation, every criterion scored, no extras', () => {
  const ok = checkFeedback(CARD, { rating: 4, recommendation: 'yes', scores: { craft: 5, comm: '3' }, notes: '  solid  ' });
  assert.deepEqual({ ...ok.feedback, scores: { ...ok.feedback.scores } }, { rating: 4, recommendation: 'yes', scores: { craft: 5, comm: 3 }, notes: 'solid' });
  assert.equal(checkFeedback(CARD, { rating: 6, recommendation: 'yes', scores: { craft: 5, comm: 3 } }).error, 'bad_rating');
  assert.equal(checkFeedback(CARD, { rating: 2.5, recommendation: 'yes', scores: { craft: 5, comm: 3 } }).error, 'bad_rating');
  assert.equal(checkFeedback(CARD, { rating: 3, recommendation: 'maybe', scores: { craft: 5, comm: 3 } }).error, 'bad_recommendation');
  assert.equal(checkFeedback(CARD, { rating: 3, recommendation: 'no', scores: { craft: 5 } }).error, 'scores_incomplete');
  assert.equal(checkFeedback(CARD, { rating: 3, recommendation: 'no', scores: { craft: 5, comm: 3, extra: 1 } }).error, 'bad_scores');
  assert.equal(checkFeedback(CARD, { rating: 3, recommendation: 'no', scores: [5, 3] }).error, 'bad_scores');
  assert.equal(checkFeedback(CARD, { rating: 3, recommendation: 'no', scores: { craft: 5, comm: 3 }, notes: 'x'.repeat(5001) }).error, 'notes_too_long');
  // No scorecard (a free-text round): rating + recommendation only.
  const none = checkFeedback([], { rating: 1, recommendation: 'strong_no' }).feedback;
  assert.deepEqual({ ...none, scores: { ...none.scores } }, { rating: 1, recommendation: 'strong_no', scores: {}, notes: null });
});

test('feedback: only once, only after the time, never on cancelled / no-show', () => {
  const iv = { status: 'scheduled', scheduled_at: iso(NOW - H) };
  const row = { submitted_at: null };
  assert.equal(feedbackBlock(iv, row, NOW), null);
  assert.equal(feedbackBlock({ ...iv, status: 'completed' }, row, NOW), null);
  assert.equal(feedbackBlock(iv, { submitted_at: iso(NOW) }, NOW), 'already_submitted');
  assert.equal(feedbackBlock({ ...iv, scheduled_at: iso(NOW + H) }, row, NOW), 'too_early');
  assert.equal(feedbackBlock({ ...iv, status: 'cancelled' }, row, NOW), 'interview_closed');
  assert.equal(feedbackBlock({ ...iv, status: 'no_show' }, row, NOW), 'interview_closed');
});

test('D4: blind until you submit, even when also on the chain', () => {
  assert.equal(canSeeFeedback({ isPanelist: true, submittedSelf: false, chainSees: true }), false);
  assert.equal(canSeeFeedback({ isPanelist: true, submittedSelf: true, chainSees: false }), true);
  assert.equal(canSeeFeedback({ isPanelist: false, submittedSelf: false, chainSees: true }), true);
  assert.equal(canSeeFeedback({ isPanelist: false, submittedSelf: false, chainSees: false }), false);
});

test('feedback state: upcoming / pending / overdue / submitted / not needed', () => {
  const iv = { status: 'scheduled', scheduled_at: iso(NOW - 2 * H) };
  assert.equal(feedbackState({ due_at: iso(NOW + H) }, { ...iv, scheduled_at: iso(NOW + H) }, NOW), 'upcoming');
  assert.equal(feedbackState({ due_at: iso(NOW + H) }, iv, NOW), 'pending');
  assert.equal(feedbackState({ due_at: iso(NOW - H) }, iv, NOW), 'overdue');
  assert.equal(feedbackState({ due_at: iso(NOW - H), submitted_at: iso(NOW) }, iv, NOW), 'submitted');
  assert.equal(feedbackState({ due_at: iso(NOW - H) }, { ...iv, status: 'no_show' }, NOW), 'not_needed');
  assert.equal(feedbackState({ due_at: iso(NOW - H) }, { ...iv, status: 'cancelled' }, NOW), 'not_needed');
});

test('remind: owed, never submitted, at most once per 12h', () => {
  const iv = { status: 'completed', scheduled_at: iso(NOW - 30 * H) };
  assert.equal(remindAllowed({ submitted_at: null, reminded_at: null }, NOW, iv), true);
  assert.equal(remindAllowed({ submitted_at: iso(NOW) }, NOW, iv), false);
  assert.equal(remindAllowed({ reminded_at: iso(NOW - 11 * H) }, NOW, iv), false);
  assert.equal(remindAllowed({ reminded_at: iso(NOW - 12 * H) }, NOW, iv), true);
  assert.equal(remindAllowed({}, NOW, { ...iv, status: 'cancelled' }), false);
  assert.equal(remindAllowed({}, NOW, { ...iv, scheduled_at: iso(NOW + H) }), false);
});

const IV = { id: U(90), application_id: U(80), status: 'completed', scheduled_at: iso(NOW - 30 * H) };
const ROWS = [
  { id: U(11), employee_id: U(1), due_at: iso(NOW - 6 * H), submitted_at: iso(NOW - 7 * H), rating: '4', recommendation: 'yes', scores: { craft: 4 }, notes: 'good' },
  { id: U(12), employee_id: U(2), due_at: iso(NOW - 6 * H), submitted_at: null, rating: null, recommendation: null, scores: {}, notes: null, remind_count: '1' },
];

test('panelView: a pending panelist sees no one else\'s feedback, and no pending row carries content', () => {
  const v = panelView(ROWS, U(2), true, { interview: IV, now: NOW });   // on the chain AND on the panel, not submitted
  assert.equal(v[0].feedback, null);
  assert.equal(v[1].feedback, null);
  assert.equal(v[1].is_me, true);
  assert.equal(v[1].state, 'overdue');
  assert.equal(v[1].remind_count, 1);
});

test('panelView: after submitting, a panelist sees the others; the chain sees all submitted', () => {
  const v = panelView(ROWS, U(1), false, { interview: IV, now: NOW, names: { [U(1)]: 'Panel One' } });
  assert.deepEqual(v[0].feedback, { rating: 4, recommendation: 'yes', scores: { craft: 4 }, notes: 'good' });
  assert.equal(v[0].name, 'Panel One');
  const chain = panelView(ROWS, U(3), true, { interview: IV, now: NOW });
  assert.ok(chain[0].feedback);
  assert.equal(chain[1].feedback, null);
  const outsider = panelView(ROWS, U(3), false, { interview: IV, now: NOW });
  assert.equal(outsider[0].feedback, null);
});

test('summary per application: count excludes cancelled, next upcoming, feedback owed', () => {
  const ivs = [
    IV,
    { id: U(91), application_id: U(80), status: 'scheduled', scheduled_at: iso(NOW + 5 * H) },
    { id: U(92), application_id: U(80), status: 'scheduled', scheduled_at: iso(NOW + 2 * H) },
    { id: U(93), application_id: U(80), status: 'cancelled', scheduled_at: iso(NOW + H) },
  ];
  const rows = [...ROWS.map(r => ({ ...r, interview_id: IV.id })), { id: U(13), interview_id: U(91), due_at: iso(NOW + 29 * H) }];
  const s = interviewSummary(ivs, rows, NOW)[U(80)];
  assert.equal(s.count, 3);
  assert.equal(s.next_at, iso(NOW + 2 * H));
  assert.equal(s.pending_feedback, 1);
});

test('my interviews: upcoming / owed / done + overdue count', () => {
  const rows = [
    { id: 'a', due_at: iso(NOW + 30 * H), interview: { status: 'scheduled', scheduled_at: iso(NOW + 6 * H) } },
    { id: 'b', due_at: iso(NOW - H), interview: { status: 'scheduled', scheduled_at: iso(NOW - 25 * H) } },
    { id: 'c', due_at: iso(NOW + 20 * H), interview: { status: 'completed', scheduled_at: iso(NOW - 4 * H) } },
    { id: 'd', due_at: iso(NOW - H), submitted_at: iso(NOW - 2 * H), interview: { status: 'completed', scheduled_at: iso(NOW - 25 * H) } },
    { id: 'e', due_at: iso(NOW - H), interview: { status: 'no_show', scheduled_at: iso(NOW - 25 * H) } },
  ];
  const b = myInterviewBuckets(rows, NOW);
  assert.deepEqual(b.upcoming.map(r => r.id), ['a']);
  assert.deepEqual(b.owed.map(r => r.id), ['b', 'c']);
  assert.deepEqual(b.done.map(r => r.id).sort(), ['d', 'e']);
  assert.equal(b.overdue_count, 1);
});

test('D5: panel documents = CV / education / experience, never another application\'s', () => {
  const docs = [
    { id: 1, doc_type: 'cv', application_id: null },
    { id: 2, doc_type: 'education', application_id: U(80) },
    { id: 3, doc_type: 'experience_letter', application_id: U(81) },
    { id: 4, doc_type: 'payslip', application_id: null },
    { id: 5, doc_type: 'photo', application_id: null },
    { id: 6, doc_type: 'other', application_id: null },
    { id: 7, doc_type: 'id_proof', application_id: null },
    { id: 8, doc_type: 'offer_evidence', application_id: U(80) },
  ];
  assert.deepEqual(panelDocs(docs, U(80)).map(d => d.id), [1, 2]);
});

test('IST label', () => {
  assert.equal(istLabel('2026-11-12T10:00:00Z'), '12 Nov 2026, 3:30 pm IST');
  assert.equal(istLabel('2026-11-12T18:45:00Z'), '13 Nov 2026, 12:15 am IST');
  assert.equal(istLabel(null), '');
});

test('reminder mail: plain text, code + round only, no injection', () => {
  const m = buildReminderMail({
    from: 'lead@legendoftoys.com', fromName: 'Team Lead', to: 'panel@legendoftoys.com', toFirst: 'Sam',
    candidateCode: 'CAN-0042', roundName: 'Tech\r\nBcc: x@evil.test', scheduledAt: '2026-11-12T10:00:00Z',
    dueAt: '2026-11-13T10:00:00Z', link: 'https://podium.legendoftoys.com/hiring/interviews/', messageId: reminderMessageId(U(12), 'abc'),
  });
  assert.ok(m.raw);
  const cut = m.raw.indexOf('\r\n\r\n');
  const head = m.raw.slice(0, cut), body = m.raw.slice(cut + 4);
  assert.match(head, /^From: "Team Lead" <lead@legendoftoys\.com>/);
  assert.match(head, /Content-Type: text\/plain/);
  assert.doesNotMatch(head, /^Bcc:/m);
  assert.match(body, /candidate CAN-0042, Tech Bcc: x@evil\.test interview on 12 Nov 2026, 3:30 pm IST/);
  assert.match(body, /due by 13 Nov 2026, 3:30 pm IST/);
  const at = (now) => buildReminderMail({ from: 'lead@legendoftoys.com', to: 'panel@legendoftoys.com', candidateCode: 'CAN-0042',
    roundName: 'Tech', scheduledAt: '2026-11-12T10:00:00Z', dueAt: '2026-11-13T10:00:00Z', link: 'https://x.test/',
    messageId: reminderMessageId(U(12), 'abc'), now }).raw;
  assert.match(at(Date.parse('2026-11-13T09:00:00Z')), /It is due by 13 Nov 2026/);
  assert.match(at(Date.parse('2026-11-13T11:00:00Z')), /It was due by 13 Nov 2026/);
  assert.match(body, /hiring\/interviews/);
  assert.equal(buildReminderMail({ from: 'x', to: 'panel@legendoftoys.com', messageId: '<a@b>' }).error, 'bad_sender');
  assert.equal(buildReminderMail({ from: 'a@legendoftoys.com', to: 'a, b@c.com', messageId: '<a@b>' }).error, 'bad_recipient');
});

test('db error codes', () => {
  assert.equal(interviewDbErrorCode({ ok: false, data: { message: 'stale' } }), 'stale');
  assert.equal(interviewDbErrorCode({ ok: false, data: { message: 'panel_submitted' } }), 'panel_submitted');
  assert.equal(interviewDbErrorCode({ ok: false, status: 409, data: { code: '23505' } }), 'round_already_scheduled');
  assert.equal(interviewDbErrorCode({ ok: false, data: { code: '23514' } }), 'check_failed');
  assert.equal(interviewDbErrorCode({ ok: false, data: { message: 'other' } }), null);
});

test('review: a label with no latin letters gets a positional key; reserved keys refused', () => {
  assert.deepEqual(cleanScorecard([{ label: 'Craft' }, { label: 'संवाद' }]).scorecard, [{ key: 'craft', label: 'Craft' }, { key: 'c2', label: 'संवाद' }]);
  assert.equal(cleanScorecard([{ label: 'Constructor' }]).error, 'bad_criterion_key');
  assert.equal(cleanScorecard([{ key: '__proto__', label: 'x' }]).error, 'bad_criterion_key');
  assert.equal(cleanScorecard([{ label: 'Prototype' }]).error, 'bad_criterion_key');
});

test('review: impossible calendar dates are refused, not rolled over', () => {
  assert.equal(parseScheduledAt('2026-11-31T10:00:00+05:30', NOW).error, 'bad_time');
  assert.equal(parseScheduledAt('2026-02-30T10:00:00+05:30', NOW).error, 'bad_time');
  assert.equal(parseScheduledAt('2026-13-01T10:00:00+05:30', NOW).error, 'bad_time');
  assert.ok(parseScheduledAt('2026-11-30T10:00:00+05:30', NOW).iso);
  assert.ok(parseScheduledAt('2026-12-01T10:00:00Z', NOW).iso);
});

test('review: feedback values are numbers or single-digit strings, scores map is prototype-free', () => {
  const ok = { recommendation: 'yes', scores: { craft: 4, comm: '3' } };
  assert.equal(checkFeedback(CARD, { ...ok, rating: true }).error, 'bad_rating');
  assert.equal(checkFeedback(CARD, { ...ok, rating: [3] }).error, 'bad_rating');
  assert.equal(checkFeedback(CARD, { ...ok, rating: '10' }).error, 'bad_rating');
  assert.equal(checkFeedback(CARD, { ...ok, rating: ' 3' }).error, 'bad_rating');
  assert.equal(checkFeedback(CARD, { ...ok, rating: 3, scores: { craft: true, comm: 3 } }).error, 'scores_incomplete');
  assert.equal(checkFeedback(CARD, { ...ok, rating: 3, scores: { craft: [4], comm: 3 } }).error, 'scores_incomplete');
  assert.equal(checkFeedback(CARD, { ...ok, rating: 3, scores: JSON.parse('{"__proto__":5,"craft":4,"comm":3}') }).error, 'bad_scores');
  const f = checkFeedback(CARD, { ...ok, rating: '4' }).feedback;
  assert.equal(f.rating, 4);
  assert.equal(Object.getPrototypeOf(f.scores), null);
  assert.deepEqual({ ...f.scores }, { craft: 4, comm: 3 });
});

test('review: nobody adds or removes themselves on an existing panel (D4)', () => {
  assert.equal(panelSelfBlock(U(1), [U(1)], []), 'panel_self');
  assert.equal(panelSelfBlock(U(1), [], [U(1)]), 'panel_self');
  assert.equal(panelSelfBlock(U(1), [U(2)], [U(3)]), null);
  assert.equal(panelSelfBlock(null, [U(1)], []), null);
});

test('review: nothing is owed or upcoming on a closed application (read-side net)', () => {
  const owedRow = { id: 'o', due_at: iso(NOW - H), interview: { status: 'scheduled', scheduled_at: iso(NOW - 25 * H), application_status: 'rejected' } };
  const upRow = { id: 'u', due_at: iso(NOW + 30 * H), interview: { status: 'scheduled', scheduled_at: iso(NOW + 6 * H), application_status: 'withdrawn' } };
  const liveRow = { id: 'l', due_at: iso(NOW - H), interview: { status: 'scheduled', scheduled_at: iso(NOW - 25 * H), application_status: 'interviewing' } };
  const doneRow = { id: 'd', due_at: iso(NOW - H), submitted_at: iso(NOW - 2 * H), interview: { status: 'completed', scheduled_at: iso(NOW - 25 * H), application_status: 'joined' } };
  assert.equal(seatState(owedRow, NOW), 'not_needed');
  assert.equal(seatState(doneRow, NOW), 'submitted');
  const b = myInterviewBuckets([owedRow, upRow, liveRow, doneRow], NOW);
  assert.deepEqual(b.owed.map(r => r.id), ['l']);
  assert.deepEqual(b.upcoming, []);
  assert.equal(b.overdue_count, 1);
  assert.deepEqual(b.done.map(r => r.id).sort(), ['d', 'o', 'u']);
});
