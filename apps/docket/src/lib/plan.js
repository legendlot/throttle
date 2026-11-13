// Docket F9 plan layer (R1–R3) — pure helpers for /plan.
// The permission matrix below is a COPY of docketops-worker/src/plan-core.mjs (itself the mirror of
// docket.plan_can / docket.plan_state_ok in migration 0017, which is the enforcer). plan.test.mjs
// compares the two cell by cell, so a drift fails the app's test suite. It only decides which
// buttons to show — the database refuses anything else.

export const PLAN_KINDS = ['theme', 'milestone', 'result'];
export const PLAN_ACTIONS = ['create', 'edit', 'edit_admin', 'owner', 'agree', 'redate', 'split', 'drop', 'done', 'reopen'];
export const PLAN_ACT_ACTIONS = ['agree', 'redate', 'drop', 'done', 'reopen'];

export function canPlanAct(kind, action, { isSuper = false, isOwner = false, isParentOwner = false } = {}) {
  if (!PLAN_KINDS.includes(kind) || !PLAN_ACTIONS.includes(action)) return false;
  if (isSuper) return true;
  if (kind !== 'result') return false;
  if (action === 'edit' || action === 'done') return !!(isOwner || isParentOwner);
  if (action === 'create' || action === 'owner' || action === 'redate') return !!isParentOwner;
  return false;
}

export function planStateAllows(kind, action, state) {
  switch (action) {
    case 'edit': case 'edit_admin': case 'owner':
      return state === 'proposed' || state === 'agreed';
    case 'agree':  return kind === 'milestone' && state === 'proposed';
    case 'redate': return kind !== 'theme' && state === 'agreed';
    case 'split':  return (kind === 'milestone' || kind === 'result') && state === 'agreed';
    case 'drop':   return kind === 'milestone' ? (state === 'proposed' || state === 'agreed') : state === 'agreed';
    case 'done':   return kind !== 'theme' && state === 'agreed';
    case 'reopen': return kind === 'theme' ? state === 'dropped' : (state === 'done' || state === 'dropped');
    default:       return false;
  }
}

export function planActionsFor(item, flags) {
  if (!item) return [];
  return PLAN_ACT_ACTIONS.filter(a => canPlanAct(item.kind, a, flags) && planStateAllows(item.kind, a, item.state));
}

// R3: the Split button (super admin, an agreed milestone or result).
export function canSplit(item, flags) {
  return !!item && canPlanAct(item.kind, 'split', flags) && planStateAllows(item.kind, 'split', item.state);
}

export const FIELD_ACTION = {
  title: 'edit', done_when: 'edit', measure: 'edit',
  owner_employee_id: 'owner',
  sort: 'edit_admin', target_text: 'edit_admin', code: 'edit_admin', restricted: 'edit_admin',
  department_id: 'edit_admin', due_date: 'edit_admin',
};

export function editableFields(item, flags) {
  if (!item) return [];
  return Object.keys(FIELD_ACTION).filter(f => {
    if (f === 'restricted' && item.kind !== 'theme') return false;
    if (f === 'due_date' && (item.kind === 'theme' || item.state !== 'proposed')) return false;
    if (f === 'done_when' && item.kind === 'theme') return false;
    const a = FIELD_ACTION[f];
    return canPlanAct(item.kind, a, flags) && planStateAllows(item.kind, a, item.state);
  });
}

export function planFlags(item, { isSuper = false, employeeId = null, byId = {} } = {}) {
  const parent = item?.parent_id ? byId[item.parent_id] : null;
  return {
    isSuper: !!isSuper,
    isOwner: !!(employeeId && item?.owner_employee_id === employeeId),
    isParentOwner: !!(employeeId && item?.kind === 'result' && parent?.owner_employee_id === employeeId),
  };
}

// Can the caller add a result under this milestone right now?
export function canAddResult(milestone, { isSuper = false, employeeId = null } = {}) {
  if (!milestone || milestone.kind !== 'milestone' || milestone.state !== 'agreed') return false;
  return canPlanAct('result', 'create', { isSuper, isParentOwner: !!(employeeId && milestone.owner_employee_id === employeeId) });
}

// ── view helpers ─────────────────────────────────────────────────────────────
export function effectiveDue(item) { return item?.revised_due_date || item?.due_date || null; }
export function isRedated(item) { return !!(item?.revised_due_date && item.revised_due_date !== item.due_date); }

// State chip: label + the status token it borrows. Themes read Active / Retired.
export function chipState(item) {
  const s = item?.state;
  if (item?.kind === 'theme') return s === 'dropped' ? { label: 'Retired', color: 'var(--st-abandon)' } : { label: 'Active', color: 'var(--st-done)' };
  switch (s) {
    case 'proposed': return { label: 'Proposed', color: 'var(--st-blocked)' };
    case 'agreed':   return { label: 'Agreed',   color: 'var(--st-progress)' };
    case 'done':     return { label: 'Done',     color: 'var(--st-done)' };
    case 'dropped':  return { label: 'Dropped',  color: 'var(--st-abandon)' };
    case 'split':    return { label: 'Split',    color: 'var(--st-todo)' };
    default:         return { label: s || '—',   color: 'var(--st-todo)' };
  }
}

// "11 Nov 2026" from a date-only 'YYYY-MM-DD' — never shifted by the browser's zone.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtPlanDate(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || '');
  if (!m) return '';
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}
// A timestamp as an IST date + time, e.g. "11 Nov 2026, 14:05".
export function fmtPlanStamp(ts) {
  const d = new Date(ts || '');
  if (isNaN(d)) return '';
  const ist = new Date(d.getTime() + 330 * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return `${ist.getUTCDate()} ${MONTHS[ist.getUTCMonth()]} ${ist.getUTCFullYear()}, ${p(ist.getUTCHours())}:${p(ist.getUTCMinutes())}`;
}

export function oneLine(text, max = 120) {
  const s = String(text || '').split('\n')[0].trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

const bySort = (a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0) || String(a.code || '').localeCompare(String(b.code || ''));

// The tree the register renders: themes → milestones → results, each in sort order. Items whose
// parent the caller can't see (a result owned under someone else's milestone) land in `orphans`.
export function buildPlanTree(items = []) {
  const byId = {};
  for (const it of items) byId[it.id] = { ...it, children: [] };
  const themes = [];
  const orphans = [];
  for (const it of Object.values(byId)) {
    if (it.kind === 'theme') themes.push(it);
    else if (it.parent_id && byId[it.parent_id]) byId[it.parent_id].children.push(it);
    else orphans.push(it);
  }
  for (const it of Object.values(byId)) it.children.sort(bySort);
  themes.sort(bySort);
  orphans.sort(bySort);
  return { themes, orphans, byId };
}

// "My milestones": only themes that hold a milestone the caller owns; results nested.
export function myMilestoneGroups(items = [], employeeId) {
  const { themes, orphans, byId } = buildPlanTree(items);
  const groups = themes
    .map(t => ({ theme: t, milestones: t.children.filter(m => m.kind === 'milestone' && employeeId && m.owner_employee_id === employeeId) }))
    .filter(g => g.milestones.length > 0);
  // A milestone whose theme is invisible can't happen below F (T covers every unrestricted theme),
  // but a result owned under another owner's milestone can.
  const loose = orphans.filter(o => o.kind === 'milestone' && o.owner_employee_id === employeeId);
  return { groups, loose, otherResults: orphans.filter(o => o.kind === 'result'), byId };
}

// Up/down within siblings: the new order, renumbered 10, 20, …; returns only the rows whose sort moved.
export function moveSort(siblings = [], id, dir) {
  const list = siblings.slice().sort(bySort);
  const i = list.findIndex(x => x.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return [];
  [list[i], list[j]] = [list[j], list[i]];
  return list.map((x, k) => ({ id: x.id, sort: (k + 1) * 10, was: Number(x.sort) || 0 }))
    .filter(x => x.sort !== x.was).map(({ id: xid, sort }) => ({ id: xid, sort }));
}

export const KIND_LABEL = { theme: 'Theme', milestone: 'Milestone', result: 'Result' };
export const ACTION_LABEL = { agree: 'Agree', redate: 'Re-date', split: 'Split', drop: 'Drop', done: 'Mark done', reopen: 'Reopen' };

const ERR = {
  forbidden: 'You can’t do that on this item.',
  forbidden_field: 'Only a super admin can set that field.',
  forbidden_super_admin: 'Only a super admin can do that.',
  not_found: 'This item is no longer visible to you.',
  parent_not_found: 'The parent item is no longer visible to you.',
  parent_not_agreed: 'The parent must be agreed first.',
  duplicate_code: 'That code is already used.',
  bad_code: 'Codes are letters, digits, dots and dashes (max 24).',
  bad_state: 'That isn’t allowed in this item’s current state.',
  live_children: 'Drop or finish everything under it first.',
  missing_fields: 'Owner, due date and done-when are required.',
  owner_required: 'Pick an owner.',
  owner_inactive: 'That person is no longer active.',
  owner_not_found: 'That person wasn’t found.',
  reason_required: 'A reason is required.',
  evidence_required: 'Add the evidence that it’s done.',
  same_date: 'That is already the due date.',
  bad_date: 'Pick a valid date.',
  title_required: 'A title is required.',
  locked_field: 'That field is locked — use its action instead.',
  // R2 — task links + the Founders' space
  plan_item_not_found: 'That plan item isn’t one you can link to.',
  plan_item_closed: 'That plan item is done or dropped — pick a live one.',
  subtask_follows_parent: 'A sub-task follows its parent’s plan link — set it on the parent.',
  restricted_needs_founders_space: 'That item is founders-only — the task has to live in the Founders’ space.',
  restricted_tasks_outside: 'Linked tasks sit outside the Founders’ space — move them there first.',
  founders_move_out: 'Only a super admin can move a task out of the Founders’ space.',
  founders_space: 'Only a super admin can do that in the Founders’ space.',
  founders_space_fixed: 'The Founders’ space can’t be archived or recovered.',
  personal_space: 'A personal space is only yours — it can’t be shared, handed over or archived.',
  personal_space_not_yours: 'Only your own work goes in your personal space: owned by you, no other team, hand-off, plan, program or collaborators.',
  team_space_closed: 'You can’t add to that team’s space — hand the task off to them instead.',
  bad_plan_item_id: 'Pick a plan item from the list.',
  // R3 — split, measure, proposals
  bad_children: 'A split needs 2 to 10 parts, each with a title, owner, due date and done-when.',
  bad_results: 'Map each result to one of the new parts, or drop it.',
  unmapped_results: 'Every result under it has to go somewhere — map or drop each one.',
  cannot_drop: 'Only a live result can be dropped in a split.',
  bad_tasks: 'A linked task points at something it can’t move to.',
  bad_tasks_default: 'Pick where the other linked tasks go.',
  unmapped_tasks: 'Some linked tasks have nowhere to go — pick a default part.',
  bad_measure: 'Pick a system and a metric for “measured from”.',
  unknown_metric: 'That metric isn’t in the registry.',
  why_required: 'Say why it should be on the plan.',
  text_too_long: 'That text is too long.',
  note_required: 'A note is required.',
  theme_required: 'Pick the theme it goes under.',
  already_decided: 'That proposal has already been decided.',
  too_many_open: 'You have 20 proposals waiting — wait for some to be decided.',
  bad_decision: 'Accept or decline.',
};
export function planErrorText(e) {
  const code = e?.message || String(e || '');
  if (code === 'missing_fields' && Array.isArray(e?.detail?.fields)) {
    const names = { owner_employee_id: 'owner', due_date: 'due date', done_when: 'done-when' };
    return `Required: ${e.detail.fields.map(f => names[f] || f).join(', ')}.`;
  }
  if (code === 'restricted_tasks_outside' && e?.detail?.detail) return `${ERR[code]} (${e.detail.detail})`;
  if (code === 'unmapped_tasks' && e?.detail?.count) return `${e.detail.count} linked task${e.detail.count === 1 ? '' : 's'} have nowhere to go — pick a default part.`;
  return ERR[code] || code || 'Something went wrong.';
}

// ── R2: tasks link up ────────────────────────────────────────────────────────
// A task's `plan` comes from the worker's projection (docket.plan_links_for): { id, level F|O|R|T|L, kind,
// code, title, state, theme_id, theme_code, theme_title, inherited }; L has no code / title / state, and a
// restricted item below F never arrives at all. The picker reads getPlan (the caller's own F / O / T rows).
export const LINK_STATES = ['proposed', 'agreed'];
const SEP = ' › ';

// "Growth › M01 › M01.R2" — the theme by title, then codes. A parent the caller can't see is skipped.
export function planChain(item, byId = {}) {
  if (!item) return '';
  if (item.kind === 'theme') return item.title || item.code || '';
  const parent = item.parent_id ? byId[item.parent_id] : null;
  if (item.kind === 'milestone') return [parent?.title || parent?.code, item.code].filter(Boolean).join(SEP);
  const theme = parent?.parent_id ? byId[parent.parent_id] : null;
  return [theme?.title || theme?.code, parent?.code, item.code].filter(Boolean).join(SEP);
}

// Tree order: each theme, then its milestones, each followed by its results; items whose parent is out
// of sight (a result you own under another owner's milestone) last.
function treeOrder(items) {
  const { themes, orphans } = buildPlanTree(items);
  const out = [];
  const walk = (n) => { out.push(n); (n.children || []).forEach(walk); };
  themes.forEach(walk);
  orphans.forEach(walk);
  return out;
}
const optLabel = (it, byId) => (it.kind === 'theme' ? (it.title || it.code) : `${planChain(it, byId)} · ${it.title}`);

// The Plan picker: "Unplanned" (= clear) + every LIVE item the caller can see (getPlan: super → all;
// others → their own milestones/results + unrestricted themes). The label carries chain + title, so the
// search box finds a code, a theme or a word of the title.
export function planPickerOptions(items = []) {
  const { byId } = buildPlanTree(items);
  const live = treeOrder(items).filter(it => LINK_STATES.includes(it.state) && it.level !== 'L' && !(it.level === 'R' && it.kind !== 'theme'));   // linking = plan-core linkError: F / O / T, and R themes only — an Associate reads the register, doesn't attach work to other owners' items
  return [{ value: '', label: 'Unplanned' }, ...live.map(it => ({ value: it.id, label: optLabel(it, byId), kind: it.kind, depth: it.kind === 'theme' ? 0 : it.kind === 'milestone' ? 1 : 2 }))];
}

// The Plan filter: every item the caller can see (done ones too — a task may still point at one), plus
// "Unplanned".
export const UNPLANNED = 'unplanned';
export function planFilterOptions(items = []) {
  const { byId } = buildPlanTree(items);
  return [{ value: UNPLANNED, label: 'Unplanned' }, ...treeOrder(items).map(it => ({ value: it.id, label: optLabel(it, byId) }))];
}

// Does a task pass the Plan filter? A theme matches every task under it (theme_id from the projection,
// so an L-level link under that theme counts too); a milestone matches its results' tasks as well
// (byId = the caller's getPlan rows); a result only its own. Unplanned = no (effective) link.
export function matchesPlanFilter(task, filter, byId = {}) {
  if (!filter) return true;
  const p = task?.plan || null;
  if (filter === UNPLANNED) return !p;
  if (!p) return false;
  const it = byId[filter];
  if (!it) return p.id === filter;
  if (it.kind === 'theme') return p.theme_id === filter || p.id === filter;
  if (it.kind === 'milestone') return p.id === filter || (p.kind === 'result' && byId[p.id]?.parent_id === filter);
  return p.id === filter;
}

// The chip a task row / card shows. F/O/R/T: the code (a theme: its code, else title), the title on hover;
// L: "Another owner's milestone" + the theme on hover; an inherited link is muted. No plan → null.
const OTHER = { milestone: 'Another owner’s milestone', result: 'Another owner’s result', theme: 'Another owner’s theme' };
// Level R (R6c, Founders' Associates) shows like O — code, title, details; the worker already nulls target_text.
export const FULL_LEVELS = ['F', 'O', 'R', 'T'];
// The read-only register a Founders' Associate sees: getPlan rows at level R (owner rows stay O).
export function isReviewRegister(items = [], isSuper = false) { return !isSuper && (items || []).some(it => it?.level === 'R'); }
export function planChip(plan) {
  if (!plan || !plan.level || plan.level === 'none') return null;
  const from = plan.inherited ? ' — from the parent task' : '';
  if (plan.level === 'L') {
    return { label: OTHER[plan.kind] || 'Another owner’s item', title: (plan.theme_title ? `Theme: ${plan.theme_title}` : 'Plan item') + from,
      muted: !!plan.inherited, redacted: true };
  }
  const label = plan.code || plan.title || 'Plan';
  const title = (plan.kind === 'theme' ? (plan.title || plan.code) : [plan.code, plan.title].filter(Boolean).join(' · ')) + from;
  return { label, title, muted: !!plan.inherited, redacted: false };
}

// One history row → a readable line.
const FIELD_LABEL = { title: 'title', done_when: 'done-when', measure: 'measure', target_text: 'target', code: 'code',
  sort: 'order', restricted: 'restricted', department_id: 'team', due_date: 'due date', owner_employee_id: 'owner' };
export function historyText(h, names = {}) {
  const n = h?.new || {};
  switch (h?.event) {
    case 'created':  return 'Created';
    case 'agreed':   return 'Agreed' + (n.due_date ? ` · due ${fmtPlanDate(n.due_date)}` : '');
    case 'redated':  return `Re-dated to ${fmtPlanDate(n.revised_due_date)}`;
    case 'dropped':  return 'Dropped';
    case 'done':     return 'Marked done';
    case 'reopened': return 'Reopened';
    case 'split':    return 'Split' + (Array.isArray(n.split_into) && n.split_into.length ? ` into ${n.split_into.join(', ')}` : '');
    case 'moved':    return 'Moved to another parent';
    case 'owner_changed': return `Owner → ${names[n.owner_employee_id] || 'someone else'}`;
    case 'field_changed': {
      const keys = Object.keys(n).map(k => FIELD_LABEL[k] || k);
      return keys.length ? `Changed ${keys.join(', ')}` : 'Edited';
    }
    default: return h?.event || '';
  }
}

// ── R3: "measured from" (§4.4) ───────────────────────────────────────────────
// The registry comes from getPlan (`metrics`: { key, system, label, unit, source_ok }) — the worker's
// src/plan-metrics.mjs, never a copy here. A stored measure is { system, metric, target, source_ok }.
export const LIVE_STATES = ['proposed', 'agreed'];
// ⚠ No data source: a live milestone/result with no measure, a manual one, or one whose metric the
// registry says isn't recorded today (the registry's CURRENT flag wins over the stored one).
export function noDataSource(item, metrics = []) {
  if (!item || (item.kind !== 'milestone' && item.kind !== 'result') || !LIVE_STATES.includes(item.state)) return false;
  const m = item.measure;
  // No measure: flagged once committed (agreed) — a proposal is a draft and isn't flagged until it has one.
  if (!m || typeof m !== 'object') return item.state === 'agreed';
  if (m.system === 'manual' || m.metric === 'manual') return true;
  const reg = (metrics || []).find(x => x.key === m.metric);
  return reg ? !reg.source_ok : m.source_ok !== true;
}
export function metricSystems(metrics = []) { return [...new Set((metrics || []).map(m => m.system))]; }
export function metricsFor(metrics = [], system) { return (metrics || []).filter(m => m.system === system); }
export function measureText(measure, metrics = []) {
  if (!measure || typeof measure !== 'object') return '';
  const reg = (metrics || []).find(x => x.key === measure.metric);
  const label = measure.metric === 'manual' ? 'Manual' : (reg?.label || measure.metric || '');
  return [label, measure.target].filter(Boolean).join(' · ');
}
// Editor draft ⇄ stored measure. '' system = no measure. An incomplete draft (a system, no metric) → undefined.
export function measureDraft(m) {
  return { system: m?.system || '', metric: m?.metric || '', target: m?.target || '' };
}
export function measureFromDraft(d) {
  if (!d || !d.system) return null;
  if (d.system === 'manual') return { system: 'manual', metric: 'manual', target: d.target.trim() || null };
  if (!d.metric) return undefined;
  return { system: d.system, metric: d.metric, target: d.target.trim() || null };
}
export function sameMeasure(a, b) {
  const k = (m) => (m ? JSON.stringify([m.system, m.metric, m.target || null]) : 'null');
  return k(a) === k(b);
}

// ── R3: split (§4.3.1) ───────────────────────────────────────────────────────
export const SPLIT_MIN = 2, SPLIT_MAX = 10;
export const emptySplitChild = () => ({ title: '', owner_employee_id: '', due_date: '', done_when: '', measure: measureDraft(null) });
// The form: { reason, children: [child…], results: { id: '<index>' | 'drop' | '' }, result_drop_reason,
//   tasks: { taskId: '' | 'c:<index>' | 'r:<result id>' }, tasks_default: '<index>' }.
export function newSplitForm(item, results = []) {
  const kid = () => ({ ...emptySplitChild(), owner_employee_id: item?.owner_employee_id || '', done_when: '' });
  return { reason: '', children: [kid(), kid()], results: Object.fromEntries(results.map(r => [r.id, ''])),
    result_drop_reason: '', tasks: {}, tasks_default: '0' };
}
const live = (r) => LIVE_STATES.includes(r?.state);
const droppedIds = (form) => Object.entries(form?.results || {}).filter(([, v]) => v === 'drop').map(([k]) => k);
// The OPEN linked tasks a split re-links (the visible ones): on the original, or on a result being dropped.
export function splitTasks(item, tasks = [], form) {
  const on = new Set([item?.id, ...droppedIds(form)]);
  return (tasks || []).filter(t => t.plan?.id && on.has(t.plan.id) && t.status !== 'done' && t.status !== 'abandoned');
}
// How many open linked tasks the caller can't open go to the default part (getPlanItem.hidden_open, level F).
export function splitHiddenCount(item, hiddenOpen = {}, form) {
  return [item?.id, ...droppedIds(form)].reduce((n, id) => n + (Number(hiddenOpen?.[id]) || 0), 0);
}
// A per-task override can point at a part, or at a LIVE result that is moving under a part.
export function splitTaskTargets(form, results = []) {
  const parts = (form?.children || []).map((c, i) => ({ value: `c:${i}`, label: c.title.trim() || `Part ${i + 1}` }));
  const moved = results.filter(r => live(r) && /^[0-9]+$/.test(form?.results?.[r.id] || ''))
    .map(r => ({ value: `r:${r.id}`, label: `${r.code} · ${r.title}` }));
  return [...parts, ...moved];
}
// Returns a message, or null when the form can be sent.
export function splitFormError(item, form, results = [], tasks = []) {
  if (!form) return 'Nothing to split.';
  if (!form.reason.trim()) return 'Give a reason for the split.';
  const n = form.children.length;
  if (n < SPLIT_MIN || n > SPLIT_MAX) return `A split makes ${SPLIT_MIN} to ${SPLIT_MAX} parts.`;
  for (let i = 0; i < n; i++) {
    const c = form.children[i];
    if (!c.title.trim() || !c.owner_employee_id || !c.due_date || !c.done_when.trim()) return `Part ${i + 1} needs a title, owner, due date and done-when.`;
    if (c.measure?.system && measureFromDraft(c.measure) === undefined) return `Part ${i + 1}: pick the metric it’s measured from.`;
  }
  if (item?.kind === 'milestone') {
    for (const r of results) {
      const v = form.results?.[r.id] || '';
      if (v === '' && live(r)) return `Map result ${r.code} to a part, or drop it.`;
      if (v === 'drop' && !live(r)) return `${r.code} is closed — move it to a part instead.`;
      if (/^[0-9]+$/.test(v) && Number(v) >= n) return `Map result ${r.code} to a part.`;
    }
    if (droppedIds(form).length && !form.result_drop_reason.trim()) return 'Say why the dropped results are dropped.';
  }
  if (!/^[0-9]+$/.test(form.tasks_default || '') || Number(form.tasks_default) >= n) return 'Pick the part the other linked tasks go to.';
  const targets = new Set(splitTaskTargets(form, results).map(t => t.value));
  for (const t of splitTasks(item, tasks, form)) {
    const v = form.tasks?.[t.id];
    if (v && !targets.has(v)) return `${t.task_no} points at a part or result that no longer takes tasks — pick again.`;
  }
  return null;
}
// The form → plan_split's payload (worker: planItemAction op 'split').
export function splitPayload(item, form, tasks = []) {
  const children = form.children.map(c => {
    const out = { title: c.title.trim(), owner_employee_id: c.owner_employee_id, due_date: c.due_date, done_when: c.done_when.trim() };
    const m = measureFromDraft(c.measure);
    if (m) out.measure = m;
    return out;
  });
  const p = { reason: form.reason.trim(), children, tasks_default: Number(form.tasks_default) };
  if (item?.kind === 'milestone') {
    p.results = {};
    for (const [id, v] of Object.entries(form.results || {})) if (v === 'drop') p.results[id] = 'drop'; else if (/^[0-9]+$/.test(v)) p.results[id] = Number(v);
    if (form.result_drop_reason.trim()) p.result_drop_reason = form.result_drop_reason.trim();
  }
  const open = new Set(splitTasks(item, tasks, form).map(t => t.id));
  const t = {};
  for (const [id, v] of Object.entries(form.tasks || {})) {
    if (!v || !open.has(id)) continue;
    t[id] = v.startsWith('c:') ? Number(v.slice(2)) : v.slice(2);
  }
  if (Object.keys(t).length) p.tasks = t;
  return p;
}
// "Split → M47, M48" for the register: the codes of the items split from this one, in sort order.
export function splitIntoCodes(item, items = []) {
  if (!item || item.state !== 'split') return [];
  return (items || []).filter(x => x.split_from_id === item.id).sort(bySort).map(x => x.code);
}

// ── R3: proposals (§4.5) ─────────────────────────────────────────────────────
export const PROPOSAL_MAX = { title: 200, why: 2000 };
export function proposalFormError(f) {
  if (!f?.title?.trim()) return 'Give it a title.';
  if (f.title.trim().length > PROPOSAL_MAX.title) return `Keep the title under ${PROPOSAL_MAX.title} characters.`;
  if (!f.why?.trim()) return 'Say why it should be on the plan.';
  if (f.why.trim().length > PROPOSAL_MAX.why) return `Keep the why under ${PROPOSAL_MAX.why} characters.`;
  return null;
}
// What the proposer reads: "Waiting", "Accepted — M47 · Title" (only when they can see it), "Declined: reason".
export function proposalOutcome(p) {
  if (!p) return '';
  if (p.status === 'submitted') return 'Waiting for the founders';
  if (p.status === 'declined') return 'Declined' + (p.decision_note ? `: ${p.decision_note}` : '');
  if (p.status === 'accepted') return 'Accepted' + (p.accepted_item_code ? ` — ${[p.accepted_item_code, p.accepted_item_title].filter(Boolean).join(' · ')}` : '');
  return p.status || '';
}
export const PROPOSAL_KIND_LABEL = { milestone: 'Milestone', risk: 'Risk' };
