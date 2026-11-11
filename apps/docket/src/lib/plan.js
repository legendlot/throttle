// Docket F9 plan layer (R1) — pure helpers for /plan.
// The permission matrix below is a COPY of docketops-worker/src/plan-core.mjs (itself the mirror of
// docket.plan_can / docket.plan_state_ok in migration 0017, which is the enforcer). plan.test.mjs
// compares the two cell by cell, so a drift fails the app's test suite. It only decides which
// buttons to show — the database refuses anything else.

export const PLAN_KINDS = ['theme', 'milestone', 'result'];
export const PLAN_ACTIONS = ['create', 'edit', 'edit_admin', 'owner', 'agree', 'redate', 'drop', 'done', 'reopen'];
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
export const ACTION_LABEL = { agree: 'Agree', redate: 'Re-date', drop: 'Drop', done: 'Mark done', reopen: 'Reopen' };

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
};
export function planErrorText(e) {
  const code = e?.message || String(e || '');
  if (code === 'missing_fields' && Array.isArray(e?.detail?.fields)) {
    const names = { owner_employee_id: 'owner', due_date: 'due date', done_when: 'done-when' };
    return `Required: ${e.detail.fields.map(f => names[f] || f).join(', ')}.`;
  }
  return ERR[code] || code || 'Something went wrong.';
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
    case 'owner_changed': return `Owner → ${names[n.owner_employee_id] || 'someone else'}`;
    case 'field_changed': {
      const keys = Object.keys(n).map(k => FIELD_LABEL[k] || k);
      return keys.length ? `Changed ${keys.join(', ')}` : 'Edited';
    }
    default: return h?.event || '';
  }
}
