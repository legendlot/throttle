// Docket task vocabulary — statuses, priorities, and small derived helpers.
// Mirrors the worker enums exactly (keep in lockstep with docket.tasks CHECKs).

export const STATUSES = [
  { key: 'not_started', label: 'Not started', color: 'var(--st-todo)',     bg: 'var(--st-todo-bg)' },
  { key: 'in_progress', label: 'In progress', color: 'var(--st-progress)', bg: 'var(--st-progress-bg)' },
  { key: 'done',        label: 'Done',        color: 'var(--st-done)',     bg: 'var(--st-done-bg)' },
  { key: 'blocked',     label: 'Blocked',     color: 'var(--st-blocked)',  bg: 'var(--st-blocked-bg)' },
  { key: 'abandoned',   label: 'Abandoned',   color: 'var(--st-abandon)',  bg: 'var(--st-abandon-bg)' },
];
export const STATUS_MAP = Object.fromEntries(STATUSES.map(s => [s.key, s]));
// Statuses an editor can set directly (abandon is its own reason-gated action).
export const SETTABLE_STATUSES = STATUSES.filter(s => s.key !== 'abandoned');

// `bars` drives the 3-bar PriorityTag glyph (filled count by severity).
export const PRIORITIES = [
  { key: 'P0', label: 'P0 · Immediate', short: 'P0', color: 'var(--p0)', bars: 3 },
  { key: 'P1', label: 'P1 · Urgent',    short: 'P1', color: 'var(--p1)', bars: 3 },
  { key: 'P2', label: 'P2 · Normal',    short: 'P2', color: 'var(--p2)', bars: 2 },
  { key: 'P3', label: 'P3 · Low',       short: 'P3', color: 'var(--p3)', bars: 1 },
];
export const PRIORITY_MAP = Object.fromEntries(PRIORITIES.map(p => [p.key, p]));

export function effectiveDeadline(t) {
  return t?.revised_deadline || t?.deadline || null;
}

export function isOverdue(t) {
  if (!t || t.status === 'done' || t.status === 'abandoned') return false;
  const eff = effectiveDeadline(t);
  if (!eff) return false;
  return new Date(eff) < new Date();
}

// Human label for a task_history event_type.
export const EVENT_LABEL = {
  created: 'Created',
  status_changed: 'Status changed',
  deadline_set: 'Deadline set',
  deadline_revised: 'Deadline revised',
  owner_employee_id_changed: 'Owner changed',
  assignee_employee_id_changed: 'Assignee changed',
  department_id_changed: 'Department changed',
  priority_changed: 'Priority changed',
  title_changed: 'Title changed',
  description_changed: 'Description changed',
  parent_changed: 'Parent changed',
  collaborator_added: 'Collaborator added',
  collaborator_removed: 'Collaborator removed',
  document_added: 'Document added',
  document_removed: 'Document removed',
  abandoned: 'Abandoned',
};
export function eventLabel(ev) { return EVENT_LABEL[ev] || ev; }
