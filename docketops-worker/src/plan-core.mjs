// Docket F9 plan layer (R1–R3) — pure logic shared by the worker and its tests.
// Spec: docs/superpowers/specs/2026-11-11-docket-plan-layer.md §4.1, §4.3 (+ split, R3), §4.5, §5.2–5.3.
//
// The SQL in migrations/0017_plan_items.sql + 0019_plan_r3.sql (docket.plan_can / docket.plan_state_ok) is the
// ENFORCER. This file is the same matrix in JS so the worker and the app can show only the
// actions that will succeed; test/plan-core.test.mjs pins it and apps/docket/src/lib/plan.test.mjs
// checks the app's copy against this one. Change all three together.

export const PLAN_KINDS = ['theme', 'milestone', 'result'];
export const PLAN_STATES = ['proposed', 'agreed', 'done', 'split', 'dropped'];
// edit       = title / done_when / measure
// edit_admin = sort / target_text / code / restricted / department_id / a proposal's due_date
// owner      = change owner
// split       = R3: an agreed milestone/result → N agreed siblings (docket.plan_split), super only
export const PLAN_ACTIONS = ['create', 'edit', 'edit_admin', 'owner', 'agree', 'redate', 'split', 'drop', 'done', 'reopen'];
// The actions plan_act runs (create → plan_create, edit* / owner → plan_update, split → plan_split).
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
  return false;   // edit_admin, split, drop, reopen (and agree, which results never need)
}

// WHEN it is allowed: the lifecycle half of §4.3. The `split` STATE is terminal and read-only (no action
// lists it); the `split` ACTION takes an agreed milestone or result.
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

// Which plan_act actions to offer on an item.
export function planActionsFor(item, flags) {
  if (!item) return [];
  return PLAN_ACT_ACTIONS.filter(a => canPlanAct(item.kind, a, flags) && planStateAllows(item.kind, a, item.state));
}

// May the caller split this item now (the Split button)?
export function canSplit(item, flags) {
  return !!item && canPlanAct(item.kind, 'split', flags) && planStateAllows(item.kind, 'split', item.state);
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

// ── R3: split (§4.3.1) — the worker's shape pre-check; docket.plan_split re-checks everything ──
export const SPLIT_MIN = 2, SPLIT_MAX = 10;
const isIndex = (v, n) => Number.isInteger(v) && v >= 0 && v < n;
export function validateSplitPayload(p = {}) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'bad_payload';
  const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
  if (!text(p.reason, MAX_TEXT.reason)) return 'reason_required';
  const kids = p.children;
  if (!Array.isArray(kids) || kids.length < SPLIT_MIN || kids.length > SPLIT_MAX) return 'bad_children';
  for (const c of kids) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return 'bad_children';
    const bad = validatePlanFields({ title: c.title ?? '', owner_employee_id: c.owner_employee_id, due_date: c.due_date,
      done_when: c.done_when, code: c.code, measure: c.measure });
    if (bad) return bad;
    if (!isUuid(c.owner_employee_id)) return 'owner_required';
    if (!isPlanDate(c.due_date) || !text(c.done_when, MAX_TEXT.done_when)) return 'missing_fields';
  }
  const n = kids.length;
  const obj = (v) => v == null || (typeof v === 'object' && !Array.isArray(v));
  if (!obj(p.results)) return 'bad_results';
  for (const [k, v] of Object.entries(p.results || {})) if (!isUuid(k) || !(v === 'drop' || isIndex(v, n))) return 'bad_results';
  if (p.result_drop_reason != null && (typeof p.result_drop_reason !== 'string' || p.result_drop_reason.length > MAX_TEXT.reason)) return 'text_too_long';
  if (!obj(p.tasks)) return 'bad_tasks';
  for (const [k, v] of Object.entries(p.tasks || {})) if (!isUuid(k) || !(isIndex(v, n) || isUuid(v))) return 'bad_tasks';
  if (p.tasks_default != null && !isIndex(p.tasks_default, n)) return 'bad_tasks_default';
  return null;
}

// ── R3: proposals (§4.5) ─────────────────────────────────────────────────────
export const PROPOSAL_MAX = { title: 200, why: 2000, note: 2000 };
export const PROPOSAL_KINDS = ['milestone', 'risk'];
export function validateProposal(p = {}) {
  if (typeof p.title !== 'string' || !p.title.trim()) return 'title_required';
  if (p.title.trim().length > PROPOSAL_MAX.title) return 'text_too_long';
  if (typeof p.why !== 'string' || !p.why.trim()) return 'why_required';
  if (p.why.trim().length > PROPOSAL_MAX.why) return 'text_too_long';
  if (p.kind_hint != null && !PROPOSAL_KINDS.includes(p.kind_hint)) return 'bad_kind';
  if (p.suggested_date != null && p.suggested_date !== '' && !isPlanDate(p.suggested_date)) return 'bad_date';
  for (const k of ['suggested_theme_id', 'suggested_owner_employee_id']) if (p[k] != null && p[k] !== '' && !isUuid(p[k])) return 'bad_' + k.replace('suggested_', '').replace('_employee_id', '').replace('_id', '');
  return null;
}
export function validateDecision(p = {}) {
  if (p.decision !== 'accept' && p.decision !== 'decline') return 'bad_decision';
  if (p.note != null && (typeof p.note !== 'string' || p.note.length > PROPOSAL_MAX.note)) return 'text_too_long';
  if (p.decision === 'decline' && !(typeof p.note === 'string' && p.note.trim())) return 'note_required';
  if (p.state != null && p.state !== 'proposed' && p.state !== 'agreed') return 'bad_state';
  const bad = validatePlanFields({ title: p.title, owner_employee_id: p.owner_employee_id, due_date: p.due_date, done_when: p.done_when });
  if (bad) return bad;
  if (p.theme_id != null && p.theme_id !== '' && !isUuid(p.theme_id)) return 'bad_theme';
  return null;
}

// RPC/validation code → HTTP status.
const STATUS = {
  forbidden: 403, forbidden_field: 403,
  not_found: 404, parent_not_found: 404,
  duplicate_code: 409, bad_state: 409, live_children: 409, parent_not_agreed: 409, same_date: 409,
  // R3 — split + proposals
  unmapped_results: 422, unmapped_tasks: 422, cannot_drop: 422, already_decided: 409, too_many_open: 429,
  // R2 — task links
  plan_item_not_found: 404, restricted_tasks_outside: 409,
  plan_item_closed: 422, subtask_follows_parent: 422, restricted_needs_founders_space: 422,
};
export function planErrStatus(code) { return STATUS[code] || 400; }

// ── R2: tasks link up (§4.1 "Tasks point up", §5.3) ──────────────────────────
// The SQL twin is migrations/0018_task_plan_link.sql: tasks_plan_guard (live target, restricted ⇒
// Founders' space), plan_items_confidential, plan_links_for (the levels). This is the worker's pre-check
// and the label every surface renders; the database refuses anything else.
export const LINK_STATES = ['proposed', 'agreed'];
export const LINKABLE_LEVELS = ['F', 'O', 'T'];

// May the caller point a task at this item? `link` = its plan_links_for row for the caller (or null).
// L / none / unknown all read as "not found" — an L item is only known through someone else's task, and
// none must not even exist. Returns an error code or null.
export function linkError(link) {
  if (!link || !LINKABLE_LEVELS.includes(link.level)) return 'plan_item_not_found';
  if (!LINK_STATES.includes(link.state)) return 'plan_item_closed';
  return null;
}

// The effective link of a task: its own, or (a sub-task) its parent's. `ownById` maps task id → its own
// plan_item_id; a sub-task's own value is never read (the CHECK keeps it null).
export function effectiveLink(task, ownById = {}) {
  if (!task) return { id: null, inherited: false };
  if (task.parent_task_id) return { id: ownById[task.parent_task_id] || null, inherited: true };
  const own = Object.prototype.hasOwnProperty.call(ownById, task.id) ? ownById[task.id] : task.plan_item_id;
  return { id: own || null, inherited: false };
}

// The `plan` object a task carries, built from its plan_links_for row. `none` (and no link) → null: a
// restricted subtree below F leaves no trace, not even that the task is linked.
export function taskPlan(link, inherited = false) {
  if (!link || !link.level || link.level === 'none') return null;
  const base = { id: link.id, level: link.level, kind: link.kind, theme_id: link.theme_id || null,
    theme_code: link.theme_code || null, theme_title: link.theme_title || null, inherited: !!inherited };
  // L: no id either — a shared hidden id would let an L viewer group tasks by sibling (review R2 #9).
  if (link.level === 'L') return { ...base, id: null, code: null, title: null, state: null };
  return { ...base, code: link.code || null, title: link.title || null, state: link.state || null };
}

const OTHER = { milestone: 'Another owner’s milestone', result: 'Another owner’s result', theme: 'Another owner’s theme' };
// One line for a link (history rows, the connector): F/O/T "M01 · Title" (a theme: its title); L the
// redacted label + its theme; nothing for none.
export function planLinkLabel(plan) {
  if (!plan || !plan.level || plan.level === 'none') return null;
  if (plan.level === 'L') return (OTHER[plan.kind] || 'Another owner’s item') + (plan.theme_title ? ` (${plan.theme_title})` : '');
  if (plan.kind === 'theme') return plan.title || plan.code || null;
  return [plan.code, plan.title].filter(Boolean).join(' · ') || null;
}

// A PostgREST error body from the R2 triggers / CHECK → { code, detail } (or null when it isn't one).
export function planDbError(body) {
  const msg = String((body && (body.message || body.error)) || body || '');
  if (/restricted_needs_founders_space/.test(msg)) return { code: 'restricted_needs_founders_space' };
  if (/plan_item_closed/.test(msg)) return { code: 'plan_item_closed' };
  if (/parent_not_agreed/.test(msg)) return { code: 'parent_not_agreed' };
  if (/tasks_plan_link_top_level/.test(msg)) return { code: 'subtask_follows_parent' };
  const m = /restricted_tasks_outside:\s*(.*)$/.exec(msg);
  if (m) return { code: 'restricted_tasks_outside', detail: m[1].trim() };
  return null;
}

// Effective due date (§4.1).
export function effectiveDue(item) { return item?.revised_due_date || item?.due_date || null; }
