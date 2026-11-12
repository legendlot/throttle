// F9 R8 — hand-offs (spec docs/superpowers/specs/2026-11-11-docket-plan-layer.md §4.6, §8.1 #5, §8.6).
// A hand-off is a task on the GIVER: owner = giver, effective deadline = hand-off date, status = hand-off
// status. `handoff_to_department_id` marks it; `handoff_to_employee_id` names the receiver (optional);
// `handoff_accepted_at/_by` record the accept. Every rule is the worker's; this file only words it.
import { planErrorText } from './plan.js';
import { istDate, shortDay } from './weeks.js';

export function isHandoff(t) { return !!t?.handoff_to_department_id; }
export function handoffAccepted(t) { return !!t?.handoff_accepted_at; }

// "Design" or "Design/Asha" — who is meant to take it.
export function handoffTarget(t) {
  const team = t?.handoff_to_department_name || 'another team';
  return t?.handoff_to_employee_name ? `${team}/${t.handoff_to_employee_name}` : team;
}

// The status line under the drawer's "Hand-off to": null when the task isn't a hand-off.
export function handoffStatus(t, now = Date.now()) {
  if (!isHandoff(t)) return null;
  if (handoffAccepted(t)) {
    const d = istDate(t.handoff_accepted_at);
    const who = t.handoff_accepted_by_name || t.handoff_to_employee_name || 'the receiver';
    return { tone: 'accepted', text: `Accepted by ${who}${d ? ' · ' + shortDay(d, now) : ''}` };
  }
  return { tone: 'pending', text: `Waiting for ${handoffTarget(t)} to accept` };
}

// The row / card chip: "→ Design", amber until accepted.
export function handoffChip(t) {
  if (!isHandoff(t)) return null;
  const pending = !handoffAccepted(t);
  return {
    label: `→ ${t.handoff_to_department_name || 'Hand-off'}`,
    pending,
    title: `Hand-off to ${handoffTarget(t)} — ${pending ? 'not accepted yet' : 'accepted'}`,
  };
}

const ERR = {
  handoff_same_team: 'That’s this task’s own team.',
  handoff_receiver_team: 'That person isn’t in that team.',
  handoff_receiver_inactive: 'That person has left.',
  handoff_top_level: 'Only a top-level task can be a hand-off.',
  not_receiver: 'Only the named receiver or someone in the receiving team can accept it.',
  handoff_closed: 'This task is closed — there’s nothing to accept.',
  not_a_handoff: 'This task isn’t a hand-off any more.',
  bad_handoff: 'Pick a team (and person) from the list.',
};
export function handoffErrorText(e) {
  const code = e?.message || String(e || '');
  return ERR[code] || planErrorText(e);
}

// The person picker for a receiving team: active employees in that department (getEmployees rows).
export function receiverOptions(employees = [], departmentId, teamName = 'the team') {
  const people = (employees || []).filter(e => e && departmentId && e.department_id === departmentId);
  return [{ value: '', label: `Anyone in ${teamName}` }, ...people.map(e => ({ value: e.id, label: e.full_name }))];
}
// The receiving-team picker: every department but the task's own (the worker refuses that: handoff_same_team).
export function teamOptions(departments = [], ownDepartmentId) {
  return [{ value: '', label: 'Not a hand-off' },
    ...(departments || []).filter(d => d && d.id !== ownDepartmentId).map(d => ({ value: d.id, label: d.name }))];
}

// Incoming's inline Accept: open, not yet accepted, and never the giver's own task (the worker refuses a
// giver accepting their own hand-off). A row that carries the worker's can_accept_handoff is held to it.
export function canAcceptIncoming(t, myEmployeeId) {
  if (!isHandoff(t) || handoffAccepted(t)) return false;
  if (t.can_accept_handoff === false) return false;
  return !(myEmployeeId && t.owner_employee_id === myEmployeeId);
}

// My Tasks → Incoming: "To you" (named receiver is me) vs "To your team" (the rest). Order is the worker's.
export function groupIncoming(tasks = [], myEmployeeId) {
  const me = [], team = [];
  for (const t of tasks || []) {
    if (!t) continue;
    (myEmployeeId && t.handoff_to_employee_id === myEmployeeId ? me : team).push(t);
  }
  return { me, team };
}

// Review pack / founders' rows ({ direction?, from_team_name, to_team_name, receiver_name, accepted, … }).
export function handoffDirection(row) {
  if (row?.direction === 'out') return `→ To ${row.to_team_name || 'another team'}`;
  if (row?.direction === 'in') return `← From ${row.from_team_name || 'another team'}`;
  return `${row?.from_team_name || 'No team'} → ${row?.to_team_name || 'another team'}`;
}
export function receiverText(row) { return row?.receiver_name || 'no one named'; }
