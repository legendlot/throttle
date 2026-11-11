// Docket F9 plan layer (R1) — pure logic shared by the worker and its tests.
// Spec: docs/superpowers/specs/2026-11-11-docket-plan-layer.md §4.1, §4.3 (minus split), §5.2–5.3.
//
// The SQL in migrations/0017_plan_items.sql (docket.plan_can / docket.plan_state_ok) is the
// ENFORCER. This file is the same matrix in JS so the worker and the app can show only the
// actions that will succeed; test/plan-core.test.mjs pins it and apps/docket/src/lib/plan.test.mjs
// checks the app's copy against this one. Change all three together.

export const PLAN_KINDS = ['theme', 'milestone', 'result'];
export const PLAN_STATES = ['proposed', 'agreed', 'done', 'split', 'dropped'];
// edit       = title / done_when / measure
// edit_admin = sort / target_text / code / restricted / department_id / a proposal's due_date
// owner      = change owner
export const PLAN_ACTIONS = ['create', 'edit', 'edit_admin', 'owner', 'agree', 'redate', 'drop', 'done', 'reopen'];
// The actions plan_act runs (create → plan_create, edit* / owner → plan_update).
export const PLAN_ACT_ACTIONS = ['agree', 'redate', 'drop', 'done', 'reopen'];

// WHO may do it. flags: { isSuper, isOwner, isParentOwner } — isParentOwner = the caller owns the
// result's milestone (for `create`, the milestone the result is being created under).
// Themes and milestones: super admin only. Results: see §4.3.
export function canPlanAct(kind, action, { isSuper = false, isOwner = false, isParentOwner = false } = {}) {
  if (!PLAN_KINDS.includes(kind) || !PLAN_ACTIONS.includes(action)) return false;
  if (isSuper) return true;
  if (kind !== 'result') return false;
  if (action === 'edit' || action === 'done') return !!(isOwner || isParentOwner);
  if (action === 'create' || action === 'owner' || action === 'redate') return !!isParentOwner;
  return false;   // edit_admin, drop, reopen (and agree, which results never need)
}

// WHEN it is allowed: the lifecycle half of §4.3. `split` is terminal and read-only (R3).
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

// Which plan_act actions to offer on an item.
export function planActionsFor(item, flags) {
  if (!item) return [];
  return PLAN_ACT_ACTIONS.filter(a => canPlanAct(item.kind, a, flags) && planStateAllows(item.kind, a, item.state));
}

// plan_update field → the matrix action that gates it.
export const FIELD_ACTION = {
  title: 'edit', done_when: 'edit', measure: 'edit',
  owner_employee_id: 'owner',
  sort: 'edit_admin', target_text: 'edit_admin', code: 'edit_admin', restricted: 'edit_admin',
  department_id: 'edit_admin', due_date: 'edit_admin',
};
// Never through a generic edit (§4.3) — only through their actions.
export const LOCKED_FIELDS = ['kind', 'parent_id', 'revised_due_date', 'state', 'split_from_id'];

// The fields a caller may edit on an item right now. due_date only while proposed (it locks at
// agree); restricted only on themes; themes carry no date or done-when.
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

// Role flags for one item. `byId` = the items the caller can see (a result's milestone may be absent).
export function planFlags(item, { isSuper = false, employeeId = null, byId = {} } = {}) {
  const parent = item?.parent_id ? byId[item.parent_id] : null;
  return {
    isSuper: !!isSuper,
    isOwner: !!(employeeId && item?.owner_employee_id === employeeId),
    isParentOwner: !!(employeeId && item?.kind === 'result' && parent?.owner_employee_id === employeeId),
  };
}

// ── codes (mirrors docket.plan_next_code) ────────────────────────────────────
export const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,23}$/;
const two = (n) => (n < 10 ? '0' + n : String(n));
export function nextPlanCode(kind, codes = [], parentCode = '') {
  const max = (re, from) => codes.reduce((m, c) => {
    const s = String(c || '');
    if (!re.test(s)) return m;
    const n = Number(s.slice(from));
    return n > m ? n : m;
  }, 0);
  if (kind === 'theme') return 'T' + two(max(/^T[0-9]{1,6}$/, 1) + 1);
  if (kind === 'milestone') return 'M' + two(max(/^M[0-9]{1,6}$/, 1) + 1);
  const prefix = `${parentCode}.R`;
  const n = codes.reduce((m, c) => {
    const s = String(c || '');
    if (!s.startsWith(prefix)) return m;
    const rest = s.slice(prefix.length);
    return /^[0-9]{1,6}$/.test(rest) && Number(rest) > m ? Number(rest) : m;
  }, 0);
  return prefix + (n + 1);
}

// ── input validation (the worker's pre-check; the SQL re-checks everything) ──
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isPlanDate(s) {
  if (!DATE_RE.test(s || '')) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(s) { return typeof s === 'string' && UUID_RE.test(s); }

export const MAX_TEXT = { title: 300, done_when: 2000, target_text: 2000, reason: 2000 };

// Shape checks only — no permission logic here. Returns an error code or null.
export function validatePlanFields(obj = {}) {
  if (obj.kind !== undefined && !PLAN_KINDS.includes(obj.kind)) return 'bad_kind';
  if (obj.title !== undefined && (typeof obj.title !== 'string' || !obj.title.trim())) return 'title_required';
  for (const [k, max] of Object.entries(MAX_TEXT)) {
    if (obj[k] != null && (typeof obj[k] !== 'string' || obj[k].length > max)) return 'text_too_long';
  }
  for (const k of ['due_date']) if (obj[k] != null && obj[k] !== '' && !isPlanDate(obj[k])) return 'bad_date';
  for (const k of ['parent_id', 'owner_employee_id', 'department_id']) {
    if (obj[k] != null && obj[k] !== '' && !isUuid(obj[k])) return 'bad_' + k.replace('_employee_id', '').replace('_id', '');
  }
  if (obj.code != null && obj.code !== '' && !CODE_RE.test(String(obj.code).trim())) return 'bad_code';
  if (obj.sort != null && obj.sort !== '' && !Number.isInteger(Number(obj.sort))) return 'bad_sort';
  if (obj.measure != null && (typeof obj.measure !== 'object' || Array.isArray(obj.measure))) return 'bad_measure';
  if (obj.restricted != null && typeof obj.restricted !== 'boolean') return 'bad_restricted';
  return null;
}

export function validateActPayload(action, p = {}) {
  if (!PLAN_ACT_ACTIONS.includes(action)) return 'bad_action';
  const text = (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= MAX_TEXT.reason;
  if (action === 'redate') {
    if (!isPlanDate(p.due_date)) return 'bad_date';
    if (!text(p.reason)) return 'reason_required';
  }
  if ((action === 'drop' || action === 'reopen') && !text(p.reason)) return 'reason_required';
  if (action === 'done' && !text(p.evidence)) return 'evidence_required';
  if (action === 'agree') return validatePlanFields({ owner_employee_id: p.owner_employee_id, due_date: p.due_date, done_when: p.done_when });
  return null;
}

// RPC/validation code → HTTP status.
const STATUS = {
  forbidden: 403, forbidden_field: 403,
  not_found: 404, parent_not_found: 404,
  duplicate_code: 409, bad_state: 409, live_children: 409, parent_not_agreed: 409, same_date: 409,
};
export function planErrStatus(code) { return STATUS[code] || 400; }

// Effective due date (§4.1).
export function effectiveDue(item) { return item?.revised_due_date || item?.due_date || null; }
