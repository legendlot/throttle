// F7 task dependencies — pure logic for the Dependencies strip (components/task/Dependencies.js),
// the row / card badge and the "mark done anyway" guard. Contract: spec
// docs/superpowers/specs/2026-11-11-docket-dependencies.md §7. The worker owns every rule
// (cycles, access, the can't-see count); this file only labels and decides what to ask.

// Add flow: the three ways to link, in the order the "+ Add" menu offers them. `kind` is the
// addTaskLink body value.
export const LINK_KINDS = [
  { kind: 'waiting_on', label: 'Waiting on…', hint: 'This task is waiting on' },
  { kind: 'blocks', label: 'Blocks…', hint: 'This task blocks' },
  { kind: 'relates', label: 'Related to…', hint: 'Related to' },
];
export const LINK_GROUPS = [
  { key: 'waiting_on', label: 'Waiting on' },
  { key: 'blocking', label: 'Blocking' },
  { key: 'related', label: 'Related' },
];

// addTaskLink / removeTaskLink refusals → what to tell the person. Unknown codes fall back
// to the worker's own message.
export const LINK_ERROR_TEXT = {
  cycle: 'That would make a loop of tasks waiting on each other.',
  already_linked: 'These two tasks are already linked.',
  self_link: 'A task can’t depend on itself.',
  recurring_task: 'Recurring tasks can’t have dependencies.',
  archived_task: 'One of these tasks is archived.',
  abandoned_read_only: 'This task is abandoned, so it’s read-only.',
  other_abandoned: 'That task is abandoned. Pick an open one.',
  forbidden_other: 'You can’t open that task, so you can’t link it.',
  forbidden: 'You can’t edit this task.',
  not_found: 'That task or link no longer exists.',
};
export function linkErrorMessage(e) {
  const code = e?.detail?.error || e?.message || '';
  return LINK_ERROR_TEXT[code] || code || 'Could not update the dependency';
}

// "1 task you can't see" / "3 tasks you can't see" — never a title, number or owner.
export function hiddenText(n) {
  const c = Number(n) || 0;
  if (c <= 0) return '';
  return `${c} task${c === 1 ? '' : 's'} you can’t see`;
}

/* ---------------- dates (IST calendar days; deadlines are timestamptz) ---------------- */
const IST = 'Asia/Kolkata';
function dayKey(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: IST, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
// "30 Nov" — the spec's hint wording.
export function fmtDay(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: IST, day: 'numeric', month: 'short' }).format(d);
}

// Date clash hint (spec §3.4): a blocker this task is waiting on, not yet cleared, due on a
// later IST day than this task's effective deadline. → the amber sentence, or null.
export function dateClash(task, item) {
  if (!task || !item || item.cleared) return null;
  const mine = task.revised_deadline || task.deadline || null;
  const a = dayKey(item.due), b = dayKey(mine);
  if (!a || !b || a <= b) return null;
  return `${item.task_no} is due ${fmtDay(item.due)}, after this task (${fmtDay(mine)})`;
}

// Totals for the strip header and its visibility. The strip shows when anything is linked,
// hidden links included (they are still links the person should know about).
export function linkCount(links) {
  if (!links) return 0;
  const h = links.hidden || {};
  return (links.waiting_on?.length || 0) + (links.blocking?.length || 0) + (links.related?.length || 0)
    + (Number(h.waiting_on) || 0) + (Number(h.blocking) || 0) + (Number(h.related) || 0);
}

// The list row / board card icon. Ints come from hydrateTasks (hidden links included).
// → { waiting: n, blocking: n, cleared: bool, tip: string } or null when there's nothing to show.
export function rowBadge(t) {
  const waiting = Number(t?.waiting_open) || 0;
  const blocking = Number(t?.blocking_open) || 0;
  const total = Number(t?.waiting_total) || 0;
  const cleared = total > 0 && waiting === 0;
  if (!waiting && !blocking && !cleared) return null;
  const parts = [];
  if (waiting) parts.push(`Waiting on ${waiting} open task${waiting === 1 ? '' : 's'}`);
  else if (cleared) parts.push(`All ${total} blocker${total === 1 ? '' : 's'} cleared`);
  if (blocking) parts.push(`Blocking ${blocking} open task${blocking === 1 ? '' : 's'}`);
  return { waiting, blocking, cleared, tip: parts.join(' · ') };
}

/* ---------------- mark done while waiting (409 waiting_on) ---------------- */
export function isWaitingOn(e) {
  return !!e && Number(e.status) === 409 && (e.detail?.error || e.message) === 'waiting_on';
}
// changeStatus 409: { blockers: [{ task_no, title, status }], hidden_open }.
export function doneConfirmText(detail, taskNo) {
  const list = (detail?.blockers || []).map(b => `${b.task_no} ${b.title || ''}`.trim());
  const hidden = Number(detail?.hidden_open) || 0;
  const who = taskNo || 'This task';
  let what = list.join(', ');
  if (hidden) what = what ? `${what} (+${hidden} you can’t see)` : hiddenText(hidden);
  return `${who} is still waiting on: ${what || 'open tasks'}. Mark done anyway?`;
}
// bulkUpdateTasks 409: { waiting_count, waiting_ids }.
export function bulkDoneConfirmText(detail) {
  const n = Number(detail?.waiting_count) || (detail?.waiting_ids || []).length || 0;
  if (n === 1) return '1 of these is waiting on open tasks. Mark all done anyway?';
  return `${n || 'Some'} of these are waiting on open tasks. Mark all done anyway?`;
}

// One "mark done" write with the warn-and-confirm step (decision G3). `send(force)` does the
// POST (force=false first); `ask(text)` is the confirm (window.confirm in the app). Any other
// error is rethrown for the caller's existing toast. → the send result, or `DECLINED` when
// the person chose not to close it.
export const DECLINED = Symbol('declined');
export async function sendDone(send, ask, message) {
  try { return await send(false); }
  catch (e) {
    if (!isWaitingOn(e)) throw e;
    if (!ask(message(e.detail || {}))) return DECLINED;
    return send(true);
  }
}

/* ---------------- history (task_history link events) ---------------- */
// The worker renders the other task into old_value / new_value ("DKT-12 · Title" or "a task
// you can't see") and puts the phrase ("waiting on" | "blocks" | "related to") in `note`.
// → the one readable line, or null for any other event.
export function historyLine(h) {
  const v = h?.new_value || h?.old_value || '';
  const phrase = h?.note ? `${h.note} ` : '';
  switch (h?.event_type) {
    case 'link_added': return `Added dependency: ${phrase}${v}`.trim();
    case 'link_removed': return `Removed dependency: ${phrase}${v}`.trim();
    case 'unblocked': return `Unblocked: ${v} ${/abandon/i.test(h?.note || '') ? 'abandoned' : 'done'}`.replace(/\s+/g, ' ').trim();
    default: return null;
  }
}
