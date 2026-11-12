// Hiring O2 — interview rounds + feedback. The PURE rules (no I/O), unit-tested in test/interviews.test.mjs.
// Plan: docs/superpowers/plans/2026-11-12-podium-o2-interviews.md (decisions D1–D9).
//
// Interviewer scope is a SEPARATE surface (D5): being on a panel grants nothing on the C1/C2/C3 reads.
// Feedback is submit-once and blind until you submit (D3/D4): a panelist sees the others' feedback on that
// interview only after their own is in, even if they are also on the opening's chain.

import { encodeHeaderWords, addressOk } from './offerlink.js';
import { TERMINAL_APP_STATUSES } from './hiring.js';

export const INTERVIEW_MODES = ['in_person', 'video', 'phone'];
export const INTERVIEW_STATUSES = ['scheduled', 'completed', 'cancelled', 'no_show'];
export const VERDICTS = ['advance', 'reject', 'hold'];
export const RECOMMENDATIONS = ['strong_yes', 'yes', 'no', 'strong_no'];
// D5: the documents a panelist may open — "the CV" tier minus photo / other.
export const PANEL_DOC_TYPES = ['cv', 'education', 'experience_letter'];
// D2: an interview is scheduled / edited only while the application is at one of these.
export const SCHEDULE_APP_STATUSES = ['new', 'screening', 'interviewing'];
// D2: scheduling on these moves the application to interviewing (in the same transaction).
export const MOVES_TO_INTERVIEWING = ['new', 'screening'];
// D3: feedback can be given on these (never on cancelled / no_show).
export const FEEDBACK_OPEN_STATUSES = ['scheduled', 'completed'];

export const MAX_CRITERIA = 10;
export const MAX_PANEL = 10;
export const ROUND_NAME_MAX = 80;
export const CRITERION_LABEL_MAX = 80;
export const LOCATION_MAX = 500;
export const NOTES_MAX = 5000;
export const CANCEL_REASON_MAX = 500;
export const FEEDBACK_DUE_HOURS = 24;     // D3: due = scheduled_at + 24h
export const REMIND_GAP_HOURS = 12;       // D7: at most one reminder per panelist per 12h
export const MIN_DURATION = 10;
export const MAX_DURATION = 480;
export const PAST_DAYS_MAX = 30;          // a time up to 30 days back = recording one that already happened
export const AHEAD_DAYS_MAX = 365;

const HOUR = 3600 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ms = (v) => (v == null ? NaN : new Date(v).getTime());

// ── Round plan (D1) ──────────────────────────────────────────────────────────

export function cleanRoundName(v) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return { error: 'round_name_required' };
  if (s.length > ROUND_NAME_MAX) return { error: 'round_name_too_long' };
  return { name: s };
}

// Keys index the scores object; never let one name an Object.prototype member.
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

// [{key?, label}] → { scorecard: [{key, label}] } | { error }. Keys are stable ids the scores map onto; a missing
// key is derived from the label. Duplicate keys are refused (the scores object could not tell them apart).
export function cleanScorecard(list) {
  if (list == null) return { scorecard: [] };
  if (!Array.isArray(list)) return { error: 'bad_scorecard' };
  if (list.length > MAX_CRITERIA) return { error: 'too_many_criteria' };
  const out = [];
  const seen = new Set();
  for (const [i, c] of list.entries()) {
    const label = String((c && typeof c === 'object' ? c.label : c) ?? '').replace(/\s+/g, ' ').trim();
    if (!label) return { error: 'criterion_label_required' };
    if (label.length > CRITERION_LABEL_MAX) return { error: 'criterion_label_too_long' };
    const given = c && typeof c === 'object' && c.key != null ? String(c.key).trim() : '';
    // A label with no a-z / 0-9 at all (e.g. Devanagari only) slugs to '' → a positional key.
    const key = given || slug(label) || `c${i + 1}`;
    if (!/^[a-z0-9_]{1,40}$/.test(key) || RESERVED_KEYS.has(key)) return { error: 'bad_criterion_key' };
    if (seen.has(key)) return { error: 'duplicate_criteria' };
    seen.add(key);
    out.push({ key, label });
  }
  return { scorecard: out };
}

// Unique uuids, 1..MAX_PANEL (min 0 for a round's defaults).
export function cleanPanelIds(ids, { min = 1 } = {}) {
  if (ids == null) ids = [];
  if (!Array.isArray(ids)) return { error: 'bad_panel' };
  const list = [...new Set(ids.map(x => String(x || '').trim()).filter(Boolean))];
  if (list.some(x => !UUID_RE.test(x))) return { error: 'bad_panel' };
  if (list.length < min) return { error: 'panel_required' };
  if (list.length > MAX_PANEL) return { error: 'panel_too_large' };
  return { ids: list };
}

// ── Interview fields (D2) ────────────────────────────────────────────────────

// ISO time → { iso } | { error }. A time up to PAST_DAYS_MAX back is allowed (recording one already held).
export function parseScheduledAt(v, now = Date.now()) {
  if (v == null || v === '') return { error: 'time_required' };
  // JS rolls 2026-11-31 over to 1 Dec; refuse a calendar date that does not exist instead.
  if (typeof v === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim());
    if (!m) return { error: 'bad_time' };
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return { error: 'bad_time' };
  }
  const t = ms(v);
  if (!Number.isFinite(t)) return { error: 'bad_time' };
  if (t < now - PAST_DAYS_MAX * 24 * HOUR || t > now + AHEAD_DAYS_MAX * 24 * HOUR) return { error: 'bad_time' };
  return { iso: new Date(t).toISOString() };
}

// The editable logistics (mode / duration / location), present keys only. → { patch } | { error }
export function cleanInterviewFields(d, { requireAll = false } = {}) {
  const p = {};
  if ('mode' in d || requireAll) {
    const m = d.mode ?? 'in_person';
    if (!INTERVIEW_MODES.includes(m)) return { error: 'bad_mode' };
    p.mode = m;
  }
  if ('duration_min' in d || requireAll) {
    const n = Math.round(Number(d.duration_min ?? 60));
    if (!(n >= MIN_DURATION && n <= MAX_DURATION)) return { error: 'bad_duration' };
    p.duration_min = n;
  }
  if ('location' in d) {
    const s = String(d.location ?? '').trim();
    if (s.length > LOCATION_MAX) return { error: 'location_too_long' };
    p.location = s || null;
  }
  return { patch: p };
}

export function dueAt(scheduledAt) {
  const t = ms(scheduledAt);
  return Number.isFinite(t) ? new Date(t + FEEDBACK_DUE_HOURS * HOUR).toISOString() : null;
}

export const canSchedule = (appStatus) => SCHEDULE_APP_STATUSES.includes(appStatus);

// D6: what a verdict does to the application. advance → nothing (null).
export function verdictMove(verdict) {
  if (verdict === 'advance') return null;
  if (verdict === 'reject') return { to: 'rejected', reasonRequired: true };
  if (verdict === 'hold') return { to: 'on_hold', reasonRequired: false };
  return { error: 'bad_verdict' };
}

// D6: a verdict lands on a scheduled / completed interview whose time has passed, once.
export function verdictBlock(iv, now = Date.now()) {
  if (!iv) return 'not_found';
  if (iv.verdict) return 'verdict_exists';
  if (!FEEDBACK_OPEN_STATUSES.includes(iv.status)) return 'interview_closed';
  if (ms(iv.scheduled_at) > now) return 'too_early';
  return null;
}

// ── Feedback (D3) ────────────────────────────────────────────────────────────

// → { feedback: {rating, recommendation, scores, notes} } | { error }. Every scorecard criterion must be scored
// (submit-once — there is no draft to finish later); no score for a key the snapshot does not have.
export function checkFeedback(scorecard, body) {
  const b = body || {};
  const rating = score1to5(b.rating);
  if (rating == null) return { error: 'bad_rating' };
  if (!RECOMMENDATIONS.includes(b.recommendation)) return { error: 'bad_recommendation' };
  const keys = (Array.isArray(scorecard) ? scorecard : []).map(c => c.key);
  const raw = b.scores == null ? {} : b.scores;
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'bad_scores' };
  for (const k of Object.keys(raw)) if (!keys.includes(k) || RESERVED_KEYS.has(k)) return { error: 'bad_scores' };
  const scores = Object.create(null);
  for (const k of keys) {
    const v = Object.prototype.hasOwnProperty.call(raw, k) ? score1to5(raw[k]) : null;
    if (v == null) return { error: 'scores_incomplete' };
    scores[k] = v;
  }
  const notes = String(b.notes ?? '').trim();
  if (notes.length > NOTES_MAX) return { error: 'notes_too_long' };
  return { feedback: { rating, recommendation: b.recommendation, scores, notes: notes || null } };
}

// 1..5 from a number or a single-digit string only (never a boolean, array or object) → int | null.
function score1to5(v) {
  if (typeof v !== 'number' && !(typeof v === 'string' && /^\d$/.test(v))) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
}

// D4: nobody adds or removes THEMSELVES on an existing panel (joining a panel after feedback is in would let them
// read it; leaving would dodge it). Scheduling may include the caller: no feedback exists yet. → null | 'panel_self'
export function panelSelfBlock(meEmpId, addIds, removeIds) {
  if (!meEmpId) return null;
  return (addIds || []).includes(meEmpId) || (removeIds || []).includes(meEmpId) ? 'panel_self' : null;
}

// D3: may this panel row submit now? → null | error code.
export function feedbackBlock(iv, row, now = Date.now()) {
  if (!iv || !row) return 'not_found';
  if (row.submitted_at) return 'already_submitted';
  if (!FEEDBACK_OPEN_STATUSES.includes(iv.status)) return 'interview_closed';
  if (ms(iv.scheduled_at) > now) return 'too_early';
  return null;
}

// D4 + D8. A panelist of THIS interview sees content only once they have submitted (even when also on the chain);
// anyone else sees it when they can see the opening.
export function canSeeFeedback({ isPanelist, submittedSelf, chainSees }) {
  if (isPanelist) return !!submittedSelf;
  return !!chainSees;
}

// One panel row's state for display. Pending rows never carry content (there are no drafts).
export function feedbackState(row, iv, now = Date.now()) {
  if (row?.submitted_at) return 'submitted';
  if (!iv || !FEEDBACK_OPEN_STATUSES.includes(iv.status)) return 'not_needed';
  if (ms(iv.scheduled_at) > now) return 'upcoming';
  if (ms(row?.due_at) < now) return 'overdue';
  return 'pending';
}

// D7: one reminder per panelist per REMIND_GAP_HOURS, only while their feedback is owed.
export function remindAllowed(row, now = Date.now(), iv = null) {
  if (!row || row.submitted_at) return false;
  if (iv && (!FEEDBACK_OPEN_STATUSES.includes(iv.status) || ms(iv.scheduled_at) > now)) return false;
  if (!row.reminded_at) return true;
  return now - ms(row.reminded_at) >= REMIND_GAP_HOURS * HOUR;
}

// Panel rows → what one viewer gets. opts: { meEmpId, chainSees, interview, now, names: {empId: name} }.
export function panelView(rows, meEmpId, chainSees, { interview = null, now = Date.now(), names = {} } = {}) {
  const list = rows || [];
  const mine = list.find(r => meEmpId && r.employee_id === meEmpId) || null;
  const see = canSeeFeedback({ isPanelist: !!mine, submittedSelf: !!mine?.submitted_at, chainSees });
  return list.map(r => {
    const own = !!mine && r.id === mine.id;
    const out = {
      id: r.id, employee_id: r.employee_id, name: names[r.employee_id] || null, is_me: own,
      due_at: r.due_at, submitted_at: r.submitted_at || null, reminded_at: r.reminded_at || null,
      remind_count: Number(r.remind_count || 0), state: feedbackState(r, interview, now),
      feedback: null,
    };
    if (r.submitted_at && (own || see)) {
      out.feedback = { rating: Number(r.rating), recommendation: r.recommendation, scores: r.scores || {}, notes: r.notes ?? null };
    }
    return out;
  });
}

// getOpening's per-application line: non-cancelled count, the next upcoming time, feedback owed (time passed).
export function interviewSummary(interviews, panelRows, now = Date.now()) {
  const byApp = {};
  const ivById = {};
  for (const iv of interviews || []) {
    ivById[iv.id] = iv;
    if (iv.status === 'cancelled') continue;
    const s = (byApp[iv.application_id] ||= { count: 0, next_at: null, pending_feedback: 0 });
    s.count += 1;
    if (iv.status === 'scheduled' && ms(iv.scheduled_at) > now && (!s.next_at || ms(iv.scheduled_at) < ms(s.next_at))) s.next_at = iv.scheduled_at;
  }
  for (const r of panelRows || []) {
    const iv = ivById[r.interview_id];
    if (!iv || !byApp[iv.application_id]) continue;
    const st = feedbackState(r, iv, now);
    if (st === 'pending' || st === 'overdue') byApp[iv.application_id].pending_feedback += 1;
  }
  return byApp;
}

// A panel seat's state on My interviews: as feedbackState, except nothing is owed or upcoming on an application that
// has closed (the 0014 trigger cancels its scheduled interviews; this is the read-side net). r.interview.application_status.
export function seatState(r, now = Date.now()) {
  const st = feedbackState(r, r?.interview, now);
  if (st !== 'submitted' && TERMINAL_APP_STATUSES.includes(r?.interview?.application_status)) return 'not_needed';
  return st;
}

// My interviews (D9): one row per panel seat (cancelled interviews already excluded). → buckets + overdue_count.
export function myInterviewBuckets(rows, now = Date.now()) {
  const upcoming = [], owed = [], done = [];
  let overdue = 0;
  for (const r of rows || []) {
    const st = seatState(r, now);
    if (st === 'upcoming') upcoming.push(r);
    else if (st === 'pending' || st === 'overdue') { owed.push(r); if (st === 'overdue') overdue += 1; }
    else done.push(r);
  }
  const at = (r) => ms(r.interview?.scheduled_at);
  upcoming.sort((a, b) => at(a) - at(b));
  owed.sort((a, b) => ms(a.due_at) - ms(b.due_at));
  done.sort((a, b) => at(b) - at(a));
  return { upcoming, owed, done, overdue_count: overdue };
}

// D5: of a candidate's documents, the ones a panelist may open — panel types, and not tied to another application.
export function panelDocs(docs, applicationId) {
  return (docs || []).filter(d => PANEL_DOC_TYPES.includes(d.doc_type) && (!d.application_id || d.application_id === applicationId));
}

// ── Reminder email (D7) ──────────────────────────────────────────────────────

// "12 Nov 2026, 3:30 pm IST"
export function istLabel(iso) {
  const t = ms(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t + 330 * 60000);
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  const h = d.getUTCHours(), m = d.getUTCMinutes();
  const h12 = h % 12 || 12;
  return `${d.getUTCDate()} ${mon} ${d.getUTCFullYear()}, ${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'} IST`;
}

export const reminderMessageId = (panelId, nonce) => `<podium-interview-remind-${panelId}-${nonce}@legendoftoys.com>`;

// A short plain-text reminder. Names the candidate CODE + round + time and links My interviews. Never the
// candidate's name or contact details, salary, or anyone's feedback. → { raw, subject, text } | { error }
export function buildReminderMail({ from, fromName = '', to, toFirst = '', candidateCode, roundName, scheduledAt, dueAt: due, link, messageId }) {
  const f = String(from || '').trim(), t = String(to || '').trim();
  if (!addressOk(f)) return { error: 'bad_sender' };
  if (!addressOk(t)) return { error: 'bad_recipient' };
  if (!/^<[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+>$/.test(String(messageId || ''))) return { error: 'bad_message_id' };
  const clean = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();
  const code = clean(candidateCode), round = clean(roundName);
  const subject = `Interview feedback due: ${code} (${round})`;
  const name = clean(fromName).replace(/["\\<>]/g, '');
  const text = [
    `Hi ${clean(toFirst) || 'there'},`,
    '',
    `Your feedback for candidate ${code}, ${round} interview on ${istLabel(scheduledAt)}, is still pending.`,
    due ? `It was due by ${istLabel(due)}.` : '',
    '',
    `Submit it in Podium: ${clean(link)}`,
    '',
    name ? `Thanks,\n${name}` : 'Thanks',
  ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
  const headers = [
    `From: ${name ? `${/^[\x20-\x7E]*$/.test(name) ? `"${name}"` : encodeHeaderWords(name)} <${f}>` : f}`,
    `To: ${t}`,
    `Subject: ${encodeHeaderWords(subject)}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
  ];
  return { raw: headers.join('\r\n') + '\r\n\r\n' + text.replace(/\r?\n/g, '\r\n'), subject, text };
}

// PostgREST / RPC error → our code.
export function interviewDbErrorCode(r) {
  const d = r?.data || {};
  const m = String(d.message || '');
  for (const c of ['stale', 'opening_not_open', 'jd_required', 'panel_submitted', 'panel_required', 'not_found', 'bad_order', 'bad_verdict',
    'feedback_locked', 'reschedule_after_feedback', 'application_not_schedulable', 'close_offers_first', 'interview_closed', 'too_early']) {
    if (m === c) return c;
  }
  if (d.code === '23505' || r?.status === 409) return 'round_already_scheduled';
  if (d.code === '23514') return 'check_failed';
  return null;
}
