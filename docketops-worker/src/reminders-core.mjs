// F9 R7b — Slack reminders (spec §9.2; the chase list + escalation from §8.3, the catch-up from §8.6). Pure:
// the settings, which slots are due in a half-hour, who may be sent to (mode gating), and the messages.
// The worker (index.js) reads as each recipient through the app's own read handlers and only renders here.
// Times are IST and live in docket.settings.slack_reminders — never in the cron expression, which only wakes
// the worker at :00 and :30.
import { DOCKET_URL, taskLink, taskButtons } from './slack-core.mjs';
import { addDays, istDate, isoDow, shortDay, isQuietTask } from './weeks-core.mjs';

export const SLOT_KEYS = ['owner_daily', 'chase', 'review_tomorrow', 'review_pack', 'catchup_prep'];
export const REMINDER_MODES = ['off', 'test', 'live'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const IST_MS = 330 * 60000;

// settings value → { mode, test_employee_ids, slots }. An unknown mode is 'off' (send nothing); never guessed.
export function parseReminderSettings(v) {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  const mode = REMINDER_MODES.includes(o.mode) ? o.mode : 'off';
  const test_employee_ids = Array.isArray(o.test_employee_ids)
    ? [...new Set(o.test_employee_ids.filter(x => typeof x === 'string' && UUID.test(x)).map(x => x.toLowerCase()))] : [];
  const slots = o.slots && typeof o.slots === 'object' && !Array.isArray(o.slots) ? o.slots : {};
  return { mode, test_employee_ids, slots };
}
// One slot's value → { min (IST minute of day), dow (ISO 1–7) | null } or null = disabled. Exactly one of
// `days: 'working'` / `dow: 1–7`; a missing or malformed time or day disables the slot.
export function slotSpec(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const m = TIME.exec(typeof v.time === 'string' ? v.time : '');
  if (!m) return null;
  const hasDays = Object.prototype.hasOwnProperty.call(v, 'days'), hasDow = Object.prototype.hasOwnProperty.call(v, 'dow');
  if (hasDays === hasDow) return null;
  if (hasDays && v.days !== 'working') return null;
  if (hasDow && !(Number.isInteger(v.dow) && v.dow >= 1 && v.dow <= 7)) return null;
  return { min: Number(m[1]) * 60 + Number(m[2]), dow: hasDow ? v.dow : null };
}
// The slots due in the half-hour holding `nowUtc` (the cron's scheduled time), in IST — India has no DST, so
// +05:30 always. Every slot fires on a working day only (working_days minus holidays — isWorkingDay is
// weeks-core's, the app's own); `dow` narrows it to that weekday. → [{ slot, run_date (IST date) }]
export function dueSlots(nowUtc, settings, isWorkingDay) {
  const ms = typeof nowUtc === 'number' ? nowUtc : nowUtc instanceof Date ? nowUtc.getTime() : Date.parse(nowUtc);
  if (!Number.isFinite(ms)) return [];
  const ist = new Date(ms + IST_MS);
  const date = ist.toISOString().slice(0, 10);
  const minute = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const half = minute - (minute % 30);
  if (!isWorkingDay(date)) return [];
  const slots = (settings && settings.slots) || {};
  return SLOT_KEYS.filter((k) => {
    const s = slotSpec(slots[k]);
    return s && s.min >= half && s.min < half + 30 && (s.dow === null || s.dow === isoDow(date));
  }).map(slot => ({ slot, run_date: date }));
}
// Mode gating: off → nobody; test → only the test people (each still gets exactly their live message);
// live → everyone. people: [{ id, … }]
export function gateRecipients(mode, testIds, people) {
  if (mode === 'live') return people.slice();
  if (mode !== 'test') return [];
  const t = new Set((testIds || []).map(x => String(x).toLowerCase()));
  return people.filter(p => t.has(String(p.id).toLowerCase()));
}
// The n-th working day after `today` (IST date).
export function workingDayAfter(today, n, isWorkingDay) {
  let d = today;
  for (let seen = 0, i = 0; seen < n && i < 400; i++) { d = addDays(d, 1); if (isWorkingDay(d)) seen++; }
  return d;
}

// ── rendering ──
const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const effMs = (t) => Date.parse(t.revised_deadline || t.deadline || t.effective_deadline || '');
const due = (t) => { const d = istDate(effMs(t)); return d ? shortDay(d) : 'no date'; };
const isOpen = (t) => !!t && t.status !== 'done' && t.status !== 'abandoned';
const mrk = (text) => ({ type: 'section', text: { type: 'mrkdwn', text: String(text).slice(0, 2900) } });
const ctxBlock = (text) => ({ type: 'context', elements: [{ type: 'mrkdwn', text: String(text).slice(0, 2900) }] });
const taskLine = (t) => `<${taskLink(t.id)}|${esc(t.task_no || 'Task')}> ${esc(t.title)} · due ${due(t)}`;
const showing = (n, shown, label) => `${n} ${label}${n > shown ? ` (showing ${shown})` : ''}`;
// Long text → ≤ 2,900-char sections cut at line breaks, at most `max`; a cut says so.
export function textSections(text, max = 6) {
  const CAP = 2900;
  const out = [];
  let cur = '';
  for (const whole of String(text || '').split('\n')) {
    // a single line longer than a section is hard-split; a section is never empty (Slack: invalid_blocks)
    for (let i = 0, line; i < Math.max(whole.length, 1); i += CAP) {
      line = whole.slice(i, i + CAP);
      if (cur && (cur + '\n' + line).length > CAP) { out.push(cur); cur = line; } else cur = cur ? cur + '\n' + line : line;
    }
  }
  if (cur) out.push(cur);
  if (out.length > max) return [...out.slice(0, max), '… more in Docket.'].map(mrk);
  return out.map(mrk);
}
// The identity cache's re-check age for one employee: 6, 7 or 8 days by a hash of the id, so a cohort cached on
// one day doesn't all expire (and all hit users.lookupByEmail) on the same morning.
export function identityTtlMs(employeeId) {
  let h = 0;
  for (const c of String(employeeId || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (6 + (h % 3)) * 86400000;
}
// users.lookupByEmail's reply → { sid } | { status: 'unmapped' | 'failed', code }. Only "no such user" or a refused
// identity (a stranger, another workspace, a mismatched email) is unmapped; anything else (rate limit, network,
// auth) is a failure — logged as such, never mistaken for "not on Slack".
export function lookupOutcome(info, ownEmail, emailOf) {
  if (info && info.ok) return emailOf(info) === ownEmail ? { sid: info.user.id } : { status: 'unmapped', code: 'slack_identity_refused' };
  const e = info && info.error;
  if (e === 'users_not_found') return { status: 'unmapped', code: 'no_slack_user' };
  return { status: 'failed', code: safeCode(e) };
}
// 09:00 — the owner's own open tasks: overdue · due today · quiet (no qualifying update in 3 working days).
// Each task shows once (its first list). Caps keep it ≤ 48 blocks.
export const OWNER_CAPS = { overdue: 8, today: 8, quiet: 5 };
export function ownerDailySections(tasks, { nowMs, fresh = new Set(), staleFrom }) {
  const today = istDate(nowMs);
  const open = tasks.filter(isOpen).sort((a, b) => (effMs(a) || Infinity) - (effMs(b) || Infinity));
  const overdue = open.filter(t => effMs(t) < nowMs);
  const todayL = open.filter(t => effMs(t) >= nowMs && istDate(effMs(t)) === today);
  const listed = new Set([...overdue, ...todayL].map(t => t.id));
  const quiet = open.filter(t => !listed.has(t.id) && isQuietTask(t, fresh, staleFrom));
  return { overdue, today: todayL, quiet };
}
export function ownerDailyMessage(s, { hidden = 0 } = {}) {
  const n = s.overdue.length + s.today.length + s.quiet.length;
  if (!n) return null;
  const parts = [['overdue', 'Overdue', 'overdue'], ['today', 'Due today', 'due today'], ['quiet', 'No update in 3 working days', 'quiet']];
  const blocks = [mrk('*Good morning — your Docket tasks*')];
  for (const [k, label] of parts) {
    const rows = s[k].slice(0, OWNER_CAPS[k]);
    if (!rows.length) continue;
    blocks.push(mrk(`*${label}*`));
    for (const t of rows) { blocks.push(mrk(taskLine(t))); blocks.push(taskButtons(t)); }
  }
  const tail = [hidden ? `${hidden} more in the Founders' space — open Docket for those.` : '', `<${DOCKET_URL}/tasks|All your tasks in Docket>`].filter(Boolean).join(' ');
  blocks.push(ctxBlock(tail));
  const text = parts.filter(([k]) => s[k].length).map(([k, , w]) => showing(s[k].length, Math.min(s[k].length, OWNER_CAPS[k]), w)).join(', ');
  return { text: `Docket: ${text}.`, blocks };
}

// 09:30 — the chase list (Associates): open tasks due from now through the 2nd working day after today, with no
// qualifying update in 3 working days — the plan-weeks Stale warnings the reader sees — plus the teams raised
// under §8.3 (no update on any open task on the last working day).
export const CHASE_CAP = 20;
export function chaseTasks(staleCards, { nowMs, until }) {
  return staleCards.filter(t => { const e = effMs(t); return Number.isFinite(e) && e >= nowMs && istDate(e) <= until; })
    .sort((a, b) => effMs(a) - effMs(b));
}
export function chaseMessage(tasks, raised, { lwd } = {}) {
  if (!tasks.length && !raised.length) return null;
  const blocks = [mrk('*Chase list*')];
  if (tasks.length) {
    const rows = tasks.slice(0, CHASE_CAP).map(t => `• ${taskLine(t)} — ${esc(t.owner_name || 'no owner')}`);
    blocks.push(mrk(`*Due in the next 2 working days, no update in 3* — ${showing(tasks.length, rows.length, tasks.length === 1 ? 'task' : 'tasks')}`));
    blocks.push(...textSections(rows.join('\n'), 3));
  }
  if (raised.length) blocks.push(mrk(`*Raised — no update on any open task${lwd ? ` on ${shortDay(lwd)}` : ''}*\n${raised.map(t => `• ${esc(t)}`).join('\n')}`));
  blocks.push(ctxBlock(`<${DOCKET_URL}/plan/weeks|Plan weeks in Docket> · <${DOCKET_URL}/review|Review pack>`));
  return { text: `Chase: ${tasks.length} task${tasks.length === 1 ? '' : 's'} due soon with no update; ${raised.length} team${raised.length === 1 ? '' : 's'} raised.`, blocks };
}
// The founders' one line (counts + a link).
export function founderChaseLine(nTasks, raised) {
  if (!nTasks && !raised.length) return null;
  const text = `Chase: ${nTasks} task${nTasks === 1 ? '' : 's'} due in the next 2 working days with no update in 3`
    + ` · ${raised.length} team${raised.length === 1 ? '' : 's'} raised for no update — <${DOCKET_URL}/plan/weeks|open Docket>`;
  return { text, blocks: [mrk(text)] };
}

// Thursday 17:00 — review tomorrow: the owner's committed-this-week (the frozen week_score cohort) not done.
export const REVIEW_CAP = 15;
export function reviewTomorrowMessage(rows, { hidden = 0, weekEnd } = {}) {
  const open = rows.filter(r => r.status !== 'done' && r.status !== 'abandoned')
    .sort((a, b) => String(a.effective_deadline || '').localeCompare(String(b.effective_deadline || '')));
  if (!open.length) return null;
  const shown = open.slice(0, REVIEW_CAP).map(r => `• ${taskLine({ ...r, id: r.task_id })}`);
  const blocks = [mrk(`*Review tomorrow* — you committed to these this week and they aren't done yet (${showing(open.length, shown.length, open.length === 1 ? 'task' : 'tasks')}).`),
    ...textSections(shown.join('\n'), 3)];
  blocks.push(ctxBlock([hidden ? `${hidden} more in the Founders' space.` : '', `<${DOCKET_URL}/review${weekEnd ? `?week=${weekEnd}` : ''}|Review pack>`].filter(Boolean).join(' ')));
  return { text: `Review tomorrow: ${open.length} committed task${open.length === 1 ? '' : 's'} not done yet.`, blocks };
}
// Thursday 18:00 — the ready review pack: packToSlack's summary (Slack-safe) + the link, not the whole pack.
export function reviewPackMessage(summary, weekEnd) {
  if (!summary) return null;
  return { text: 'The review pack is ready.', blocks: [...textSections(summary, 4),
    ctxBlock(`<${DOCKET_URL}/review${weekEnd ? `?week=${weekEnd}` : ''}|Open the full review pack in Docket>`)] };
}
// Friday 18:00 — the Saturday catch-up prep: foundersToSlack's message + the link.
export function catchupMessage(slackText, weekEnd) {
  if (!slackText) return null;
  return { text: "Tomorrow's founders' catch-up.", blocks: [...textSections(slackText, 5),
    ctxBlock(`<${DOCKET_URL}/review/founders${weekEnd ? `?week=${weekEnd}` : ''}|Open the catch-up in Docket>`)] };
}
export const isPreviewable = (slot) => SLOT_KEYS.includes(slot);
// A Slack error code we may store (its own enum words only); anything else is a generic code.
export const safeCode = (c) => (typeof c === 'string' && /^[a-z_]{1,60}$/.test(c) ? c : 'send_failed');
