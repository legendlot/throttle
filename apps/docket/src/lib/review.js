// F9 R6a — the review pack (/review, spec docs/superpowers/specs/2026-11-11-docket-plan-layer.md §8.1–§8.5).
// Pure helpers for the page: number + label formatting, the Copy-for-Slack text, week stepping and the
// page's URL. The pack itself comes whole from docketops getReviewPack — nothing here re-scores a week.
import { addDays, isoDow, isDateStr, istDate, shortDay, thisWeekEnd, weekStartOf } from './weeks.js';
import { fmtPlanStamp } from './plan.js';

// pct arrives 0–100 with one decimal (docket.score_pct), possibly as a string; null = no denominator.
export function fmtPct(pct) {
  if (pct == null || pct === '') return '—';
  const n = Number(pct);
  if (!Number.isFinite(n)) return '—';
  return `${n.toFixed(1).replace(/\.0$/, '')}%`;
}

export const MISS_LABEL = { open: 'not done', done_late: 'done late', abandoned: 'dropped' };
export function missLabel(reason) { return MISS_LABEL[reason] || (reason ? String(reason).replace(/_/g, ' ') : ''); }

// A history / revision source, as shown next to the row ('app' — and a missing source — show nothing).
const SOURCE_LABEL = { connector: 'via connector', slack: 'via Slack', system: 'by the system' };
export function sourceNote(source) { return !source || source === 'app' ? '' : (SOURCE_LABEL[source] || `via ${source}`); }

export function movedText(n) { const k = Number(n) || 0; return k > 0 ? `moved ${k}×` : ''; }

// "3/5 (60%)" — open committed tasks with a qualifying update this week.
export function touchedText(p) {
  const t = Number(p?.touched) || 0, of = Number(p?.committed_open) || 0;
  return of > 0 ? `${t}/${of} (${fmtPct(p?.touched_pct)})` : `${t}/0`;
}

// Staleness per person. last_seen is sent only to plan admins (and for the viewer's own row): absent → ''
// (show nothing); present but null → 'never'. last_update_older = an update exists but before the worker's
// 30-day lookback — never 'never'.
export function seenText(p) {
  if (!p || !Object.prototype.hasOwnProperty.call(p, 'last_seen')) return '';
  return p.last_seen ? fmtPlanStamp(p.last_seen) : 'never';
}
export function updateText(p) {
  if (p?.last_update) return fmtPlanStamp(p.last_update);
  return (p?.last_update_before || p?.last_update_older) ? 'over 30 days ago' : 'never';
}

// An ISO timestamp → its IST calendar date, as 'Sun 15 Nov'.
export function tsDay(ts, now = Date.now()) { const d = istDate(ts); return d ? shortDay(d, now) : '—'; }

// Copy for Slack (§8.4): the summary and every team's message, blank-line separated; when the pack is ONE
// team (team_id set), just that team's message — the summary is the all-teams roll-up.
export function slackText(pack) {
  const s = pack?.slack || {};
  const teams = (s.teams || []).map(t => t?.text).filter(Boolean);
  if (pack?.team_id) {
    const own = (s.teams || []).filter(t => t?.department_id === pack.team_id).map(t => t.text).filter(Boolean);
    return (own.length ? own : teams).join('\n\n');
  }
  return [s.summary, ...teams].filter(Boolean).join('\n\n');
}

// ── weeks ────────────────────────────────────────────────────────────────────
// Step from a week-ending date by n weeks (its own weekday is the org's week end, so ±7 days stays on it).
export function stepWeek(end, n) { return isDateStr(end) ? addDays(end, 7 * n) : null; }
// The ?week= value for a week-ending date: 'this' for the current week, else the date.
export function weekParam(end, now = Date.now()) {
  if (!isDateStr(end)) return 'this';
  return end === thisWeekEnd(now, isoDow(end)) ? 'this' : end;
}
// 'scored' | 'future' (not started yet) | 'unscored' (before the first scored week, or never opened).
export function weekState(week, now = Date.now()) {
  if (week?.opened) return 'scored';
  const start = week?.week_start || (isDateStr(week?.week_end) ? weekStartOf(week.week_end) : null);
  const today = istDate(now);
  return start && today && start > today ? 'future' : 'unscored';
}
export function reviewTitle(end, now = Date.now()) { return `Review · week ending ${shortDay(end, now)}`; }

// /review?week=…&team=… — 'this' and the default team are left out of the URL.
export function reviewHref({ week, team } = {}) {
  const q = new URLSearchParams();
  if (week && week !== 'this') q.set('week', week);
  if (team) q.set('team', team);
  const s = q.toString();
  return '/review' + (s ? '?' + s : '');
}

const ERR = {
  no_team: 'Your profile has no team — ask an admin.',
  bad_week: 'That isn’t a week this page knows.',
  bad_team: 'That team doesn’t exist.',
  week_not_open: 'This week has no score yet, so there’s nothing to hold.',
  forbidden: 'You can only see your own team’s review.',
  not_found: 'A slot points at something you can’t open any more — clear that slot and save again.',
};
export function reviewErrorText(e) {
  const code = e?.message || String(e || '');
  return ERR[code] || code || 'Something went wrong.';
}

// Trend bar height (0–100) for a pct; null → 0 (drawn as an empty bar).
export function barPct(pct) { const n = Number(pct); return pct == null || !Number.isFinite(n) ? 0 : Math.max(0, Math.min(100, n)); }

// ── R6b: the founders' catch-up (§8.6) ───────────────────────────────────────
export const FOCUS_SLOTS = 5;
export const FOCUS_NOTE_MAX = 500;
// A founder's stored top 5 → exactly five editable slots, by rank (gaps kept empty).
export function focusSlots(items = []) {
  const slots = Array.from({ length: FOCUS_SLOTS }, () => ({ plan_item_id: null, task_id: null, note: '', ref: null }));
  for (const it of items || []) {
    const i = Number(it?.rank) - 1;
    if (!Number.isInteger(i) || i < 0 || i >= FOCUS_SLOTS) continue;
    slots[i] = { plan_item_id: it.plan_item_id || null, task_id: it.task_id || null, note: it.note || '', ref: it.ref || null };
  }
  return slots;
}
export function slotFilled(s) { return !!(s && (s.plan_item_id || s.task_id || String(s.note || '').trim())); }
// The setFounderFocus body: only filled slots, ranks renumbered 1..n, at most one of plan_item_id / task_id.
export function focusPayload(slots = []) {
  return (slots || []).filter(slotFilled).map((s, i) => {
    const out = { rank: i + 1 };
    if (s.plan_item_id) out.plan_item_id = s.plan_item_id;
    else if (s.task_id) out.task_id = s.task_id;
    const note = String(s.note || '').trim();
    if (note) out.note = note;
    return out;
  });
}
// A slot's reference line. A task the viewer can't open arrives with ref null (the note is kept).
export function focusRefText(s) {
  const r = s?.ref;
  if (r?.kind === 'item') return [r.code, r.title].filter(Boolean).join(' · ');
  if (r?.kind === 'task') return [r.task_no, r.title].filter(Boolean).join(' · ');
  if (s?.task_id) return 'A task you can’t open';
  if (s?.plan_item_id) return 'A plan item you can’t see';
  return '';
}
export function hiddenAsksText(n) { const k = Number(n) || 0; return k > 0 ? `+${k} involve spaces you’re not in` : ''; }
export function foundersTitle(end, now = Date.now()) { return `Founders’ catch-up · week ending ${shortDay(end, now)}`; }
export function foundersHref({ week } = {}) { return '/review/founders' + (week && week !== 'this' ? '?week=' + encodeURIComponent(week) : ''); }
