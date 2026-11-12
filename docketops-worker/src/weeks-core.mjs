// F9 R4 — weeks (spec 2026-11-11-docket-plan-layer.md §6, §7.2, §8.3). Pure; no I/O.
// apps/docket/src/lib/weeks.js is a COPY of the week math below (its test checks parity) — change both.
//
// Week = the half-open IST interval [S 00:00, E+1 00:00) where E is the week-ENDING date and S = E − 6.
// A task's week = the week holding the IST date of its effective deadline (revised_deadline ?? deadline).
// E's weekday is docket.settings.week_end_dow (ISO 1 = Mon … 7 = Sun, default Sunday). Working days
// (staleness) = settings.working_days (ISO dows, default Mon–Sat) minus settings.holidays (YYYY-MM-DD).
// Overdue keeps the app's existing meaning (lib/tasks.js isOverdue, list_tasks p_overdue): open (not done /
// abandoned) and the effective deadline is before NOW.

export const WEEK_DEFAULTS = Object.freeze({ week_end_dow: 7, working_days: Object.freeze([1, 2, 3, 4, 5, 6]), holidays: Object.freeze([]) });
export const WEEK_KEYS = ['week_end_dow', 'working_days', 'holidays'];
export const STALE_WORKING_DAYS = 3;
export const WEEK_FILTERS = ['this', 'next', 'overdue', 'none'];   // + a 'YYYY-MM-DD' (snapped to its week end)

const IST_MS = 5.5 * 3600000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isDateStr(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
const toMs = (v) => (typeof v === 'number' ? v : v instanceof Date ? v.getTime() : Date.parse(v));

// The IST calendar date of a timestamp (ms, Date or ISO string) → 'YYYY-MM-DD' | null.
export function istDate(v) {
  const t = toMs(v);
  if (!Number.isFinite(t)) return null;
  return new Date(t + IST_MS).toISOString().slice(0, 10);
}
export function addDays(d, n) { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
export function isoDow(d) { const w = new Date(`${d}T00:00:00Z`).getUTCDay(); return w === 0 ? 7 : w; }
// 00:00 IST of a date, as epoch ms.
export function istMidnight(d) { return Date.parse(`${d}T00:00:00+05:30`); }

// The week-ending date of the week holding date d (d itself when d falls on the week-end day).
export function weekEndOf(d, dow = 7) { return addDays(d, (dow - isoDow(d) + 7) % 7); }
export function weekStartOf(end) { return addDays(end, -6); }
export function weekBounds(end) { return { start: istMidnight(weekStartOf(end)), end: istMidnight(addDays(end, 1)) }; }

// settings rows ({ key: value } or [{ key, value }]) → { week_end_dow, working_days, holidays }; anything
// malformed falls back to the default for that key.
export function normalizeWeekSettings(raw) {
  const m = Array.isArray(raw) ? Object.fromEntries(raw.map(r => [r?.key, r?.value])) : (raw || {});
  const dow = Number(m.week_end_dow);
  const wd = Array.isArray(m.working_days)
    ? [...new Set(m.working_days.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 7))].sort((a, b) => a - b) : [];
  const hol = Array.isArray(m.holidays) ? [...new Set(m.holidays.filter(isDateStr))].sort() : [];
  return {
    week_end_dow: Number.isInteger(dow) && dow >= 1 && dow <= 7 ? dow : WEEK_DEFAULTS.week_end_dow,
    working_days: wd.length ? wd : [...WEEK_DEFAULTS.working_days],
    holidays: hol,
  };
}

export function effectiveDeadline(t) { return t?.revised_deadline || t?.deadline || null; }
const isOpen = (t) => !!t && t.status !== 'done' && t.status !== 'abandoned';
export function isOverdue(t, now = Date.now()) {
  if (!isOpen(t)) return false;
  const eff = effectiveDeadline(t);
  return !!eff && Date.parse(eff) < toMs(now);
}
// The week-ending date of a task's effective deadline, or null (no date).
export function taskWeekEnd(t, dow = 7) {
  const d = istDate(effectiveDeadline(t));
  return d ? weekEndOf(d, dow) : null;
}
// The Group-by bucket: 'overdue' (open + past due) | 'none' (no date) | the week-ending date.
export function weekBucket(t, dow = 7, now = Date.now()) {
  if (isOverdue(t, now)) return 'overdue';
  return taskWeekEnd(t, dow) || 'none';
}
export function thisWeekEnd(now = Date.now(), dow = 7) { return weekEndOf(istDate(now), dow); }

// A Week filter value → { kind: 'overdue' | 'none' } | { kind: 'week', end } | null (not a filter value).
export function resolveWeekFilter(f, dow = 7, now = Date.now()) {
  if (f === 'overdue' || f === 'none') return { kind: f };
  if (f === 'this') return { kind: 'week', end: thisWeekEnd(now, dow) };
  if (f === 'next') return { kind: 'week', end: addDays(thisWeekEnd(now, dow), 7) };
  if (isDateStr(f)) return { kind: 'week', end: weekEndOf(f, dow) };
  return null;
}
// `This week` / a week holds every task due in it, overdue ones included (the filter is the week; the
// Group-by is what pulls overdue out into its own group).
export function matchesWeek(t, resolved, dow = 7, now = Date.now()) {
  if (!resolved) return true;
  if (resolved.kind === 'overdue') return isOverdue(t, now);
  if (resolved.kind === 'none') return !effectiveDeadline(t);
  return taskWeekEnd(t, dow) === resolved.end;
}

const DOW3 = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// 'Sun 16 Nov' (+ the year when it isn't the current IST year).
export function shortDay(d, now = Date.now()) {
  if (!isDateStr(d)) return '';
  const y = d.slice(0, 4), cur = (istDate(now) || '').slice(0, 4);
  return `${DOW3[isoDow(d)]} ${Number(d.slice(8, 10))} ${MON3[Number(d.slice(5, 7)) - 1]}${y !== cur ? ' ' + y : ''}`;
}
export function weekLabel(end, now = Date.now()) { return `Week ending ${shortDay(end, now)}`; }

// ── working days (staleness, §8.3) ───────────────────────────────────────────
export function isWorkingDay(d, s = WEEK_DEFAULTS) {
  return (s.working_days || WEEK_DEFAULTS.working_days).includes(isoDow(d)) && !(s.holidays || []).includes(d);
}
// Whole working days with no update: working days strictly AFTER the last update's IST date and strictly
// BEFORE today (today is still running, so it never counts against anyone).
export function workingDaysSince(lastAt, now = Date.now(), s = WEEK_DEFAULTS) {
  const from = istDate(lastAt), today = istDate(now);
  if (!from || !today || from >= today) return 0;
  let n = 0;
  for (let d = addDays(from, 1), i = 0; d < today && i < 800; d = addDays(d, 1), i++) if (isWorkingDay(d, s)) n++;
  return n;
}
// The earliest IST date an update may carry and still keep a task fresh: the n-th working day counting
// back from yesterday. Stale ⇔ last update date < this (⇔ workingDaysSince ≥ n). The worker reads history
// and comments from 00:00 IST of this date only.
export function staleCutoff(now = Date.now(), s = WEEK_DEFAULTS, n = STALE_WORKING_DAYS) {
  let d = istDate(now), seen = 0;
  for (let i = 0; i < 800; i++) {
    d = addDays(d, -1);
    if (isWorkingDay(d, s) && ++seen >= n) return d;
  }
  return d;
}
export function isStale(lastAt, now = Date.now(), s = WEEK_DEFAULTS, n = STALE_WORKING_DAYS) {
  return workingDaysSince(lastAt, now, s) >= n;
}

// ── the three-week window (§7.2) ─────────────────────────────────────────────
// Rolling: Overdue · this week · next week · the week after.
export function planWindow(now = Date.now(), dow = 7) {
  const e0 = thisWeekEnd(now, dow);
  const weeks = [e0, addDays(e0, 7), addDays(e0, 14)];
  return { today: istDate(now), weeks, start: weekBounds(e0).start, end: weekBounds(weeks[2]).end };
}

// ════════════════════════════════════════════════════════════════════════════
// getPlanWeeks model (worker only). Every input is ALREADY gated by the caller:
//   items      — docket.plan_items_for rows (levels F / O / T; nothing else ever reaches here), with
//                owner_name + team_id (item.department_id ?? the owner's department) attached;
//   tasks      — the window's top-level tasks the viewer can open (visibleTaskRows), hydrated with
//                plan (plan_links_for projection), owner_name, department_name;
//   linked     — open top-level tasks linked to the window's F / O milestones + results:
//                [{ id, plan_item_id, owner_employee_id, deadline, revised_deadline, visible }]
//                (`visible` = the viewer can open it). Level F counts every one (§5.3 rollups); level O
//                only the visible ones — a warning never leans on a task the viewer can't see;
//   themeTasks — open top-level tasks the viewer can open, linked straight to a theme;
//   fresh      — Set of task ids with a qualifying update (task_history / a live comment) since staleCutoff.
// ════════════════════════════════════════════════════════════════════════════
const LIVE = ['proposed', 'agreed'];
export const ROWS_BY = ['team', 'person', 'theme'];
export const effectiveDue = (i) => i?.revised_due_date || i?.due_date || null;

function itemCard(i) {
  return { id: i.id, kind: i.kind, code: i.code || null, title: i.title, state: i.state, level: i.level,
    due: effectiveDue(i), owner_employee_id: i.owner_employee_id || null, owner_name: i.owner_name || null, warnings: [] };
}
function taskCard(t) {
  return { id: t.id, task_no: t.task_no || null, title: t.title, status: t.status, priority: t.priority || null,
    owner_employee_id: t.owner_employee_id || null, owner_name: t.owner_name || null,
    deadline: t.deadline || null, revised_deadline: t.revised_deadline || null, plan: t.plan || null,
    can_edit: !!t._can_edit, warnings: [] };   // can_edit = the worker's canEditTask (the theme-only fix is an updateTask)
}
const actionable = (t) => isOpen(t) && !!t.owner_employee_id && !!effectiveDeadline(t);

export function buildPlanWeeks({ items = [], tasks = [], linked = [], themeTasks = [], fresh = new Set(),
  settings = WEEK_DEFAULTS, now = Date.now(), rowsBy = 'team', teamId = null, deptNames = {}, isSuper = false } = {}) {
  const s = normalizeWeekSettings(settings);
  const dow = s.week_end_dow;
  const win = planWindow(now, dow);
  const nowMs = toMs(now);
  const colOf = new Set(win.weeks);
  const byId = Object.fromEntries(items.map(i => [i.id, i]));
  const themeOf = (i) => (i.kind === 'theme' ? i : i.kind === 'milestone' ? byId[i.parent_id] : byId[byId[i.parent_id]?.parent_id]);
  const inTeam = (team) => !teamId || team === teamId;

  // Plan items in the window: live milestones / results the viewer sees at F or O (T is themes only), with a
  // due date; past due (and not done) → Overdue.
  const itemCol = (i) => {
    const due = effectiveDue(i);
    if (!due) return null;
    if (due < win.today) return 'overdue';
    const e = weekEndOf(due, dow);
    return colOf.has(e) ? e : null;
  };
  const winItems = items.filter(i => i.kind !== 'theme' && (i.level === 'F' || i.level === 'O' || i.level === 'R') && LIVE.includes(i.state)
    && inTeam(i.team_id || null) && itemCol(i));

  // Tasks in the window: open + overdue → Overdue; otherwise (open or done) in its week if it's one of three.
  const taskCol = (t) => {
    if (isOverdue(t, nowMs)) return 'overdue';
    if (t.status === 'abandoned') return null;
    const e = taskWeekEnd(t, dow);
    return e && colOf.has(e) ? e : null;
  };
  const winTasks = tasks.filter(t => !t.parent_task_id && inTeam(t.department_id || null) && taskCol(t));

  const warnings = [];
  const cards = new Map();   // item / task id → its card (warnings land on the card too)
  const warn = (w, card) => { warnings.push(w); if (card) card.warnings.push(w.kind); };

  // ── items: No actionable tasks · Not agreed yet ──
  const resultsOf = {};
  for (const i of items) if (i.kind === 'result' && (i.level === 'F' || i.level === 'O' || i.level === 'R') && LIVE.includes(i.state)) (resultsOf[i.parent_id] = resultsOf[i.parent_id] || []).push(i.id);
  const linkedBy = {};
  for (const t of linked) if (!t.parent_task_id) (linkedBy[t.plan_item_id] = linkedBy[t.plan_item_id] || []).push(t);
  for (const i of winItems) {
    const card = itemCard(i);
    cards.set(i.id, card);
    const who = { employee_id: i.owner_employee_id || null, name: i.owner_name || null };
    if (i.state === 'proposed') {
      if (i.kind === 'milestone') warn({ kind: 'not_agreed', resolver: { kind: 'founders', name: 'The founders' }, item: { ...card, warnings: undefined } }, card);
      continue;
    }
    const ids = [i.id, ...(i.kind === 'milestone' ? resultsOf[i.id] || [] : [])];
    const all = ids.flatMap(id => linkedBy[id] || []).filter(actionable);
    const seen = all.filter(t => t.visible);
    // Level F counts every linked task (§5.3) and says how many sit in spaces the viewer isn't in; below F
    // only the ones the viewer can open count, and nothing about the rest is said.
    if (i.level === 'F') { const hid = all.length - seen.length; if (hid) card.hidden_actionable = hid; }
    const pool = i.level === 'F' ? all : seen;
    if (!pool.length) warn({ kind: 'no_actionable', resolver: { kind: 'owner', ...who }, item: { ...card, warnings: undefined } }, card);
  }

  // ── tasks: Stale ──
  const staleFrom = staleCutoff(nowMs, s);
  for (const t of winTasks) {
    const card = taskCard(t);
    cards.set(t.id, card);
    if (!isOpen(t) || fresh.has(t.id)) continue;
    if (t.created_at && istDate(t.created_at) >= staleFrom) continue;   // created inside the window of grace
    warn({ kind: 'stale', resolver: { kind: 'task_owner', employee_id: t.owner_employee_id || null, name: t.owner_name || null },
      task: { ...card, warnings: undefined } }, card);
  }

  // ── Theme-only links: open tasks linked straight to a theme that has an AGREED milestone the viewer sees
  //    (F / O). A theme whose agreed milestones are all invisible gives no warning — it would say they exist.
  const agreedMs = {};
  for (const i of items) if (i.kind === 'milestone' && i.state === 'agreed' && (i.level === 'F' || i.level === 'O' || i.level === 'R')) {
    (agreedMs[i.parent_id] = agreedMs[i.parent_id] || []).push({ id: i.id, code: i.code || null, title: i.title, due: effectiveDue(i) });
  }
  for (const t of themeTasks) {
    if (t.parent_task_id || !isOpen(t) || !inTeam(t.department_id || null)) continue;
    const theme = byId[t.plan_item_id];
    if (!theme || theme.kind !== 'theme' || !agreedMs[theme.id]) continue;
    const card = cards.get(t.id) || taskCard(t);
    warn({ kind: 'theme_only', resolver: { kind: 'task_owner', employee_id: t.owner_employee_id || null, name: t.owner_name || null },
      task: { ...card, warnings: undefined }, theme: { id: theme.id, code: theme.code || null, title: theme.title },
      milestones: agreedMs[theme.id].slice().sort((a, b) => String(a.code || '').localeCompare(String(b.code || ''))) }, card);
  }

  // ── rows ──
  const rows = new Map();
  const rowFor = (key, label, sortKey) => {
    if (!rows.has(key)) rows.set(key, { key, label, sort: sortKey, cells: Object.fromEntries(['overdue', ...win.weeks].map(c => [c, { items: [], tasks: [] }])) });
    return rows.get(key);
  };
  // An empty key is keyed by its label: "No team" is one row for items and tasks alike, but "No theme" (an
  // item) and "Unplanned" (a task) — or "Unknown owner" and "Unassigned" — stay separate rows.
  const place = (kind, key, label, col, card) => {
    const r = rowFor(key || `∅:${label}`, label, key ? label : '\uffff' + label);
    r.cells[col][kind].push(card);
  };
  for (const i of winItems) {
    const col = itemCol(i), card = cards.get(i.id);
    if (rowsBy === 'person') place('items', i.owner_employee_id, i.owner_name || 'Unknown owner', col, card);
    else if (rowsBy === 'theme') { const th = themeOf(i); place('items', th?.id, th ? th.title : 'No theme', col, card); }
    else place('items', i.team_id, i.team_id ? (deptNames[i.team_id] || 'Unknown team') : 'No team', col, card);
  }
  for (const t of winTasks) {
    const col = taskCol(t), card = cards.get(t.id);
    if (rowsBy === 'person') place('tasks', t.owner_employee_id, t.owner_name || 'Unassigned', col, card);
    else if (rowsBy === 'theme') place('tasks', t.plan?.theme_id, t.plan?.theme_title || 'Unplanned', col, card);
    else place('tasks', t.department_id, t.department_id ? (t.department_name || deptNames[t.department_id] || 'Unknown team') : 'No team', col, card);
  }
  const byDue = (a, b) => String(a.due || '').localeCompare(String(b.due || '')) || String(a.code || '').localeCompare(String(b.code || ''));
  const byDeadline = (a, b) => String(effectiveDeadline(a) || '').localeCompare(String(effectiveDeadline(b) || ''));
  const outRows = [...rows.values()].sort((a, b) => a.sort.localeCompare(b.sort)).map(({ sort, ...r }) => {
    for (const c of Object.values(r.cells)) { c.items.sort(byDue); c.tasks.sort(byDeadline); }
    return r;
  });

  const counts = { no_actionable: 0, not_agreed: 0, theme_only: 0, stale: 0 };
  for (const w of warnings) counts[w.kind]++;
  return {
    week: s, today: win.today, rows_by: rowsBy, team_id: teamId || null, all_teams: !teamId, can_admin: !!isSuper,
    columns: [{ key: 'overdue', label: 'Overdue' }, ...win.weeks.map((e, n) => ({
      key: e, label: weekLabel(e, nowMs), start: weekStartOf(e), end: e, which: ['this', 'next', 'after'][n] }))],
    rows: outRows, warnings, counts,
  };
}
