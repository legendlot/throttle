// F9 R6a — the review pack (spec 2026-11-11-docket-plan-layer.md §8.1–§8.5). Pure; no I/O.
// Every input is ALREADY gated by the worker (getReviewPack): cohort rows are the ones the viewer's counts
// may include (a plan admin: all; anyone else: only tasks they can open, never a Founders'-space task), and
// `shown` says which of those may be LISTED (titles). Plan items are plan_items_for rows at level F or O only.
import { istDate, addDays, isWorkingDay, shortDay, istMidnight, effectiveDue } from './weeks-core.mjs';

const OPEN = (s) => s !== 'done' && s !== 'abandoned';
const LIVE = ['proposed', 'agreed'];
const pct1 = (n, d) => (d > 0 ? Math.round((1000 * n) / d) / 10 : null);

// §8.2: final → on time ÷ cohort; provisional → on time ÷ (on time + miss). One decimal, null on 0.
export function scoreBlock(rows = [], final = false) {
  const b = { cohort: rows.length, on_time: 0, miss: 0, due: 0 };
  for (const r of rows) if (r.outcome === 'on_time' || r.outcome === 'miss' || r.outcome === 'due') b[r.outcome]++;
  return { ...b, pct: final ? pct1(b.on_time, b.cohort) : pct1(b.on_time, b.on_time + b.miss) };
}

// §8.3: the last working day strictly before today (working_days minus holidays).
export function lastWorkingDay(todayIst, s) {
  let d = todayIst;
  for (let i = 0; i < 400; i++) { d = addDays(d, -1); if (isWorkingDay(d, s)) return d; }
  return addDays(todayIst, -1);
}

// Tasks → [{ owner_employee_id, owner_name, tasks }] by owner name (no owner last); tasks by deadline.
export function groupByPerson(tasks = [], names = {}) {
  const by = new Map();
  for (const t of tasks) {
    const k = t.owner_employee_id || null;
    if (!by.has(k)) by.set(k, { owner_employee_id: k, owner_name: k ? (names[k] || null) : null, tasks: [] });
    by.get(k).tasks.push({ task_id: t.id, task_no: t.task_no || null, title: t.title,
      effective_deadline: t.revised_deadline || t.deadline || null, status: t.status });
  }
  const out = [...by.values()];
  for (const g of out) g.tasks.sort((a, b) => String(a.effective_deadline).localeCompare(String(b.effective_deadline)));
  return out.sort((a, b) => (a.owner_employee_id ? 0 : 1) - (b.owner_employee_id ? 0 : 1)
    || String(a.owner_name || '').localeCompare(String(b.owner_name || '')));
}

// ⚠ No data source — the same rule as apps/docket/src/lib/plan.js noDataSource (the registry's CURRENT
// source_ok wins over the stored one; no measure flags once agreed; manual always flags).
export function noDataSource(item, metrics = []) {
  if (!item || (item.kind !== 'milestone' && item.kind !== 'result') || !LIVE.includes(item.state)) return false;
  const m = item.measure;
  if (!m || typeof m !== 'object') return item.state === 'agreed';
  if (m.system === 'manual' || m.metric === 'manual') return true;
  const reg = (metrics || []).find(x => x.key === m.metric);
  return reg ? !reg.source_ok : m.source_ok !== true;
}

const itemOut = (i) => ({ id: i.id, kind: i.kind, code: i.code || null, title: i.title, owner_name: i.owner_name || null,
  due: effectiveDue(i), state: i.state });
const inDates = (d, from, to) => !!d && d >= from && d <= to;
const teamKey = (v) => v || null;

// The per-team blocks. Input (all gated, see the header):
//   teamIds        — ordered department ids (null = tasks with no team)
//   deptNames      — { id: name }
//   week           — { week_start, week_end, final, rows }            rows: week_score task rows the counts include
//   last           — { week_end, final, rows }
//   trend          — [{ week_end, final, rows }]                       oldest first; only closed (final) weeks count
//   shown          — Set of task ids whose rows may be listed
//   revisions      — { task_id: [{ created_at, old_value, new_value, note, source }] } (deadline_revised, oldest first)
//   items          — plan_items_for rows, level F / O, with owner_name + team_id
//   itemHistory    — plan_item_history 'redated' rows for those items inside the pack's week
//   linked         — open top-level tasks linked to the horizon's items: [{ plan_item_id, owner_employee_id,
//                    deadline, revised_deadline, status, visible }]
//   metrics        — publicMetrics()
//   openTasks      — the viewer's visible open top-level tasks (current department_id)
//   nextTasks      — the viewer's visible top-level tasks due in the two weeks after the pack's week
//   updates        — qualifying updates [{ task_id, at, source|null (comments) }] since min(week start, lwd)
//   taskPlan       — { task_id: plan_item_id|null } for this week's cohort rows
//   names          — { employee_id: full_name }
//   ownLatest      — { employee_id: ISO }  their own latest history row / comment
//   lastSeen       — { employee_id: ISO }  user_activity.last_seen_at
//   lwd            — the last working day (YYYY-MM-DD); null when the pack's week isn't the current one
//                    (then quiet_last_working_day / last_working_day are null — they only mean "now")
//   lookbackStart  — ISO: how far back ownLatest was read; a person with none carries last_update_before
//   seenOnly       — null: every person's last_seen; an employee id: ONLY that person carries last_seen (a
//                    viewer below plan admin sees their own presence, never a colleague's)
export function buildReviewTeams(x) {
  const { teamIds = [], deptNames = {}, week, last, trend = [], shown = new Set(), revisions = {}, items = [],
    itemHistory = [], linked = [], metrics = [], openTasks = [], nextTasks = [], updates = [], taskPlan = {},
    names = {}, ownLatest = {}, lastSeen = {}, lwd = null, lookbackStart = null, seenOnly = null } = x;
  const weekStartMs = istMidnight(week.week_start);
  const weekEndMs = istMidnight(addDays(week.week_end, 1));
  const nextEnd = addDays(week.week_end, 14);
  const updBy = {};
  for (const u of updates) (updBy[u.task_id] = updBy[u.task_id] || []).push(u);
  const resultsOf = {};
  for (const i of items) if (i.kind === 'result' && LIVE.includes(i.state)) (resultsOf[i.parent_id] = resultsOf[i.parent_id] || []).push(i.id);
  const linkedBy = {};
  for (const t of linked) (linkedBy[t.plan_item_id] = linkedBy[t.plan_item_id] || []).push(t);
  const actionable = (t) => OPEN(t.status) && !!t.owner_employee_id && !!(t.revised_deadline || t.deadline);
  const inTeam = (T) => (r) => teamKey(r.department_id) === T;

  return teamIds.map((T) => {
    const thisRows = week.rows.filter(inTeam(T));
    const lastRows = last.rows.filter(inTeam(T));

    const slipped = [...thisRows.map(r => [r, week.week_end]), ...lastRows.map(r => [r, last.week_end])]
      .filter(([r]) => r.outcome === 'miss' && shown.has(r.task_id))
      .map(([r, we]) => {
        const revs = (revisions[r.task_id] || []).map(h => ({ at: h.created_at, old: h.old_value || null, new: h.new_value || null,
          reason: h.note || null, source: h.source || 'app' }));
        return { task_id: r.task_id, task_no: r.task_no || null, title: r.title, owner_employee_id: r.owner_employee_id || null,
          owner_name: r.owner_employee_id ? (names[r.owner_employee_id] || null) : null, week_end: we,
          committed_deadline: r.committed_deadline || null, effective_deadline: r.effective_deadline || null, status: r.status,
          miss_reason: r.miss_reason || null, times_moved: revs.length, revisions: revs };
      })
      .sort((a, b) => String(a.committed_deadline).localeCompare(String(b.committed_deadline)));

    // ── milestones (milestones + results, F / O) ──
    const mine = items.filter(i => (i.kind === 'milestone' || i.kind === 'result') && teamKey(i.team_id) === T);
    const due = mine.filter(i => i.state !== 'dropped' && inDates(effectiveDue(i), week.week_start, week.week_end))
      .sort((a, b) => String(effectiveDue(a)).localeCompare(String(effectiveDue(b)))).map(itemOut);
    const byId = Object.fromEntries(mine.map(i => [i.id, i]));
    const redated = itemHistory.filter(h => h.event === 'redated' && byId[h.item_id]).map(h => {
      const i = byId[h.item_id];
      return { id: i.id, kind: i.kind, code: i.code || null, title: i.title, at: h.at,
        old: h.old?.revised_due_date || h.old?.due_date || null, new: h.new?.revised_due_date || null, reason: h.note || null };
    }).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const warnings = [];
    const horizon = mine.filter(i => LIVE.includes(i.state) && inDates(effectiveDue(i), week.week_start, nextEnd))
      .sort((a, b) => String(effectiveDue(a)).localeCompare(String(effectiveDue(b))));
    for (const i of horizon) {
      const w = (kind) => warnings.push({ kind, id: i.id, code: i.code || null, title: i.title });
      if (i.kind === 'milestone' && i.state === 'proposed') w('not_agreed');
      if (noDataSource(i, metrics)) w('no_data_source');
      if (i.state === 'agreed') {
        // Level F counts every linked task (§5.3 rollups); level O only the ones the viewer can open.
        const all = [i.id, ...(i.kind === 'milestone' ? resultsOf[i.id] || [] : [])].flatMap(id => linkedBy[id] || []).filter(actionable);
        const pool = i.level === 'F' ? all : all.filter(t => t.visible);
        if (!pool.length) w('no_tasks');
      }
    }

    // ── staleness (§8.3) ──
    const open = openTasks.filter(inTeam(T));
    const cohortOpen = thisRows.filter(r => shown.has(r.task_id) && OPEN(r.status));
    const people = uniqIds([...open.map(t => t.owner_employee_id), ...cohortOpen.map(r => r.owner_employee_id)]);
    const ownedOpen = {};
    for (const t of open) if (t.owner_employee_id) (ownedOpen[t.owner_employee_id] = ownedOpen[t.owner_employee_id] || new Set()).add(t.id);
    for (const r of cohortOpen) if (r.owner_employee_id) (ownedOpen[r.owner_employee_id] = ownedOpen[r.owner_employee_id] || new Set()).add(r.task_id);
    const sinceStart = (u) => { const t = Date.parse(u.at); return t >= weekStartMs && t < weekEndMs; };
    const staleness = {
      quiet_last_working_day: lwd ? open.length > 0 && !open.some(t => (updBy[t.id] || []).some(u => istDate(u.at) === lwd)) : null,
      last_working_day: lwd,
      people: people.map(p => {
        const committed = cohortOpen.filter(r => r.owner_employee_id === p);
        const touched = committed.filter(r => (updBy[r.task_id] || []).some(sinceStart)).length;
        const by_source = { app: 0, connector: 0, slack: 0, system: 0 };
        for (const id of ownedOpen[p] || []) for (const u of updBy[id] || []) {
          if (u.source && sinceStart(u) && Object.prototype.hasOwnProperty.call(by_source, u.source)) by_source[u.source]++;
        }
        return { employee_id: p, name: names[p] || null,
          ...(seenOnly === null || seenOnly === p ? { last_seen: lastSeen[p] || null } : {}),
          last_update: ownLatest[p] || null,
          // no own update inside the lookback: "over N days ago", not "never"
          ...(!ownLatest[p] && lookbackStart ? { last_update_before: lookbackStart } : {}),
          touched, committed_open: committed.length, touched_pct: pct1(touched, committed.length), by_source };
      }).sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))),
    };

    const committed = thisRows.length;
    const unplannedN = thisRows.filter(r => !taskPlan[r.task_id]).length;
    return {
      department_id: T, team_name: T ? (deptNames[T] || null) : 'No team',
      this_week: scoreBlock(thisRows, !!week.final),
      last_week: { week_end: last.week_end, final: !!last.final, ...scoreBlock(lastRows, !!last.final) },
      trend: trend.filter(w => w.final).map(w => ({ week_end: w.week_end, pct: scoreBlock(w.rows.filter(inTeam(T)), true).pct,
        cohort: w.rows.filter(inTeam(T)).length })),
      slipped,
      milestones: { due, redated, warnings },
      staleness,
      next_two_weeks: {
        tasks_by_person: groupByPerson(nextTasks.filter(inTeam(T)), names),
        milestones: mine.filter(i => i.state !== 'dropped' && inDates(effectiveDue(i), addDays(week.week_end, 1), nextEnd))
          .sort((a, b) => String(effectiveDue(a)).localeCompare(String(effectiveDue(b)))).map(itemOut),
      },
      unplanned: { committed, unplanned: unplannedN, pct: pct1(unplannedN, committed) },
    };
  });
}
function uniqIds(a) { return [...new Set(a.filter(Boolean))]; }

// ── Copy for Slack (§8.4): mrkdwn, one message per team + a summary, at the pack's (= viewer's) level.
// Never an id: names, codes, task numbers and titles only.
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pctTxt = (p) => (p == null ? '—' : `${p}%`);
const SLIPPED_MAX = 10;
function scoreLine(b, final) {
  return final
    ? `${b.on_time}/${b.cohort} on time — ${pctTxt(b.pct)}`
    : `${b.on_time} on time · ${b.miss} missed · ${b.due} still due — ${pctTxt(b.pct)}`;
}
// Slack goes to channels (§5.3 "exports render at the destination's level"), so the copy NEVER names a
// Founders'-space task or a restricted-subtree milestone, whoever builds it: `omit` = { tasks: [ids], items: [ids] }
// (a pack carries its own as `slack_omit`, kept in a held snapshot so a re-render honours it too).
export function packToSlack(pack, omit = pack?.slack_omit) {
  const oT = new Set(omit?.tasks || []), oI = new Set(omit?.items || []);
  pack = { ...pack, teams: (pack?.teams || []).map(t => ({ ...t,
    slipped: (t.slipped || []).filter(s => !oT.has(s.task_id)),
    milestones: t.milestones ? { ...t.milestones, due: (t.milestones.due || []).filter(m => !oI.has(m.id)) } : t.milestones })) };
  const wk = pack?.week || {};
  const label = `week ending ${shortDay(wk.week_end) || wk.week_end || ''}`;
  const teams = (pack?.teams || []).map((t) => {
    const lines = [`*${esc(t.team_name || 'No team')}* — ${label}`,
      `This week (${wk.final ? 'final' : 'provisional'}): ${scoreLine(t.this_week, wk.final)}`,
      ...(t.last_week ? [`Last week (${t.last_week.final ? 'final' : 'provisional'}): ${scoreLine(t.last_week, t.last_week.final)}`] : [])];
    const slipped = t.slipped || [];
    if (slipped.length) {
      lines.push('*Slipped*');
      for (const s of slipped.slice(0, SLIPPED_MAX)) {
        lines.push(`• ${s.task_no ? esc(s.task_no) + ' ' : ''}${esc(s.title)} — ${esc(s.owner_name || 'no owner')}${s.times_moved ? ` (moved ${s.times_moved}×)` : ''}`);
      }
      if (slipped.length > SLIPPED_MAX) lines.push(`… +${slipped.length - SLIPPED_MAX} more`);
    }
    const msDue = t.milestones?.due || [];
    if (msDue.length) {
      lines.push('*Milestones due*');
      for (const m of msDue) lines.push(`• ${m.code ? esc(m.code) + ' ' : ''}${esc(m.title)} — ${esc(m.owner_name || 'no owner')} — ${esc(m.state)}`);
    }
    if (t.staleness?.quiet_last_working_day) lines.push(`⚠ No update on any open task on ${shortDay(t.staleness.last_working_day)}`);
    return { department_id: t.department_id, text: lines.join('\n') };
  });
  const summary = [`*Review — ${label}* (${wk.final ? 'final' : 'provisional'})`,
    ...(pack?.teams || []).map(t => `• *${esc(t.team_name || 'No team')}*: ${scoreLine(t.this_week, wk.final)}`
      + ((t.slipped || []).length ? ` · ${t.slipped.length} slipped` : '') + (t.staleness?.quiet_last_working_day ? ' · ⚠ quiet' : ''))];
  if (pack?.proposals) summary.push(`Proposals: ${pack.proposals.submitted_this_week.length} this week · ${pack.proposals.waiting} waiting`);
  return { summary: summary.join('\n'), teams };
}

// A stored pack, re-projected for the reader (§8.5): drop every task row whose id isn't in `keep` (the reader's
// current access), count the drops into hidden_tasks, and re-render the Slack copy from what is left.
export function reprojectPack(payload, keep) {
  if (!payload || !Array.isArray(payload.teams)) return payload;
  const dropped = new Set();
  const k = (id) => { const y = keep.has(id); if (!y) dropped.add(id); return y; };
  const teams = payload.teams.map(t => ({ ...t,
    slipped: (t.slipped || []).filter(s => k(s.task_id)),
    next_two_weeks: { ...t.next_two_weeks,
      tasks_by_person: (t.next_two_weeks?.tasks_by_person || []).map(g => ({ ...g, tasks: g.tasks.filter(x => k(x.task_id)) })).filter(g => g.tasks.length) },
  }));
  const out = { ...payload, teams, hidden_tasks: (payload.hidden_tasks || 0) + dropped.size };
  return { ...out, slack: packToSlack(out) };
}
// A `final` snapshot (week_close stores the raw week_score payload) → the pack shape, so the app renders it
// with the same components (§8.5). Only what the frozen score holds: this_week per frozen department (final),
// slipped = its miss rows the reader may see (`keep`), with their deadline revisions when loaded. Everything
// the score doesn't hold is empty / null. Counts stay whole (plan admins only read snapshots).
export function finalSnapshotPack(p, { keep = new Set(), deptNames = {}, names = {}, revisions = null, teamId = null, departments = [] } = {}) {
  const rows = Array.isArray(p?.tasks) ? p.tasks : [];
  const scoped = teamId ? rows.filter(r => teamKey(r.department_id) === teamId) : rows;
  const teamIds = teamId ? [teamId] : uniqIds(scoped.map(r => r.department_id || 'none')).map(k => (k === 'none' ? null : k))
    .sort((a, b) => (a ? 0 : 1) - (b ? 0 : 1) || String(deptNames[a] || '').localeCompare(String(deptNames[b] || '')));
  const teams = teamIds.map(T => {
    const mine = scoped.filter(r => teamKey(r.department_id) === T);
    return {
      department_id: T, team_name: T ? (deptNames[T] || null) : 'No team',
      this_week: scoreBlock(mine, true), last_week: null, trend: [],
      slipped: mine.filter(r => r.outcome === 'miss' && keep.has(r.task_id)).map(r => {
        const revs = (revisions?.[r.task_id] || []).map(h => ({ at: h.created_at, old: h.old_value || null, new: h.new_value || null,
          reason: h.note || null, source: h.source || 'app' }));
        return { task_id: r.task_id, task_no: r.task_no || null, title: r.title, owner_employee_id: r.owner_employee_id || null,
          owner_name: r.owner_employee_id ? (names[r.owner_employee_id] || null) : null, week_end: p.week_end,
          committed_deadline: r.committed_deadline || null, effective_deadline: r.effective_deadline || null, status: r.status,
          miss_reason: r.miss_reason || null, times_moved: revs.length, revisions: revs };
      }).sort((a, b) => String(a.committed_deadline).localeCompare(String(b.committed_deadline))),
      milestones: { due: [], redated: [], warnings: [] },
      staleness: null,
      next_two_weeks: { tasks_by_person: [], milestones: [] },
      unplanned: null,
    };
  });
  const pack = {
    week: { week_end: p?.week_end || null, week_start: p?.week_start || null, final: true, opened: true,
      opened_late: !!p?.opened_late, as_of: p?.as_of || null },
    team_id: teamId, can_admin: true, departments,
    hidden_tasks: uniqIds(scoped.map(r => r.task_id)).filter(id => !keep.has(id)).length,
    revisions_loaded: !!revisions,
    teams, proposals: null,
  };
  return { ...pack, slack: packToSlack(pack) };
}

// Every task id a stored pack lists (for the re-projection read).
export function packTaskIds(payload) {
  const ids = [];
  for (const t of payload?.teams || []) {
    for (const s of t.slipped || []) ids.push(s.task_id);
    for (const g of t.next_two_weeks?.tasks_by_person || []) for (const x of g.tasks || []) ids.push(x.task_id);
  }
  return uniqIds(ids);
}

// ════════════════════════════════════════════════════════════════════════════
// F9 R6b — the Saturday founders' catch-up (spec §8.6, level F only)
// ════════════════════════════════════════════════════════════════════════════
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const FOCUS_MAX = 5, FOCUS_NOTE_MAX = 500;

// A founder's top 5 as sent → { items: [{ rank, plan_item_id, task_id, note }] (by rank) } | { error }.
// ≤5 items; ranks whole numbers 1–5, unique; at most one of plan_item_id / task_id; each item an id or a
// non-blank note ≤500 (trimmed). The same rules as docket.founder_focus_set (migration 0026) and the table.
export function validateFocusItems(items) {
  if (!Array.isArray(items)) return { error: 'bad_item' };
  if (items.length > FOCUS_MAX) return { error: 'too_many' };
  const out = [], ranks = new Set();
  const id = (v) => (v === undefined || v === null || v === '' ? { v: null } : typeof v === 'string' && UUID_RE.test(v) ? { v } : { bad: true });
  for (const it of items) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) return { error: 'bad_item' };
    const rank = it.rank;
    if (!Number.isInteger(rank) || rank < 1 || rank > FOCUS_MAX || ranks.has(rank)) return { error: 'bad_rank' };
    ranks.add(rank);
    const p = id(it.plan_item_id), t = id(it.task_id);
    if (p.bad || t.bad || (p.v && t.v)) return { error: 'bad_item' };
    if (it.note !== undefined && it.note !== null && typeof it.note !== 'string') return { error: 'bad_item' };
    const note = typeof it.note === 'string' && it.note.trim() ? it.note.trim() : null;
    if (note && note.length > FOCUS_NOTE_MAX) return { error: 'note_too_long' };
    if (!p.v && !t.v && !note) return { error: 'bad_item' };
    out.push({ rank, plan_item_id: p.v, task_id: t.v, note });
  }
  return { items: out.sort((a, b) => a.rank - b.rank) };
}

// Cross-team asks: open `blocks` links where the BLOCKED task (to_task_id — it waits) is top-level, open,
// not archived, due in [start, end) (this week or next), and its blocker (from_task_id) sits in a different
// department (a null department differs from a set one; both null is not cross-team) and isn't done (an
// abandoned blocker stays listed — that is a real problem). A pair with either side outside `keep` (the
// caller's space gate) is counted in hidden_asks and never listed.
//   links    — [{ id, from_task_id, to_task_id }]   blocked / blockers — task rows   keep — Set of task ids
export function buildAsks({ links = [], blocked = [], blockers = [], keep = new Set(), names = {}, deptNames = {}, start, end }) {
  const A = new Map(blocked.map(t => [t.id, t])), B = new Map(blockers.map(t => [t.id, t]));
  const card = (t) => ({ task_id: t.id, task_no: t.task_no || null, title: t.title, team_id: t.department_id || null,
    team_name: t.department_id ? (deptNames[t.department_id] || null) : null, owner_employee_id: t.owner_employee_id || null,
    owner_name: t.owner_employee_id ? (names[t.owner_employee_id] || null) : null,
    effective_deadline: t.revised_deadline || t.deadline || null, status: t.status });
  const asks = []; let hidden = 0;
  for (const l of links) {
    const a = A.get(l.to_task_id), b = B.get(l.from_task_id);
    if (!a || !b || a.parent_task_id || a.archived_at || !OPEN(a.status) || b.status === 'done') continue;
    const due = Date.parse(a.revised_deadline || a.deadline || '');
    if (!Number.isFinite(due) || due < start || due >= end) continue;
    if ((a.department_id || null) === (b.department_id || null)) continue;
    if (!keep.has(a.id) || !keep.has(b.id)) { hidden++; continue; }
    asks.push({ link_id: l.id, blocked: card(a), blocker: card(b) });
  }
  asks.sort((x, y) => String(x.blocked.effective_deadline).localeCompare(String(y.blocked.effective_deadline)));
  return { asks, hidden_asks: hidden };
}

// ONE mrkdwn message (a DM to the founders, level F): the asks, then each founder's top 5. Never an id.
export function foundersToSlack(r) {
  const day = (iso) => shortDay(istDate(iso)) || '';
  const who = (c) => [c.team_name || 'No team', c.owner_name].filter(Boolean).map(esc).join(', ');
  const task = (c) => `${c.task_no ? esc(c.task_no) + ' ' : ''}${esc(c.title)}`;
  const lines = [`*Founders' catch-up — week ending ${shortDay(r?.week?.week_end) || r?.week?.week_end || ''}*`, '*Cross-team asks*'];
  const asks = r?.asks || [];
  if (!asks.length) lines.push('No cross-team asks due this week or next.');
  for (const a of asks) {
    lines.push(`• ${task(a.blocked)} (${who(a.blocked)}) waits on ${task(a.blocker)} (${who(a.blocker)})`
      + (a.blocked.effective_deadline ? ` — due ${day(a.blocked.effective_deadline)}` : '')
      + (a.blocker.status === 'abandoned' ? ' — ⚠ the blocker was abandoned' : ''));
  }
  if (r?.hidden_asks) lines.push(`+${r.hidden_asks} more in spaces you can't open`);
  for (const f of r?.focus || []) {
    lines.push(`*${esc(f.founder_name || 'A founder')}'s top 5*`);
    if (!(f.items || []).length) { lines.push('Not set yet.'); continue; }
    for (const it of f.items) {
      const ref = it.ref;
      const head = !ref ? (it.note ? '' : 'something you can’t see')
        : ref.kind === 'item' ? `${ref.code ? esc(ref.code) + ' ' : ''}${esc(ref.title)}` : `${ref.task_no ? esc(ref.task_no) + ' ' : ''}${esc(ref.title)}`;
      lines.push(`${it.rank}. ${[head, it.note ? `“${esc(it.note)}”` : ''].filter(Boolean).join(' — ')}`);
    }
  }
  return lines.join('\n');
}
