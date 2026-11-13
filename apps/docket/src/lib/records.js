// F8 P2 record checklists — pure helpers for the Records tab, the Record page and the task's Checklists strip
// (spec docs/superpowers/specs/2026-11-11-docket-checklists-v2.md §3.2–3.3). The worker owns every rule
// (visibility, who may edit, the link rule, completion); this file only counts, groups and words refusals.
// recordProgress mirrors docketops-worker/src/records-core.mjs (the worker sends `progress` too; this is for
// optimistic updates).

export function recordProgress(items) {
  let done = 0, na = 0, open = 0;
  for (const i of items || []) { if (i.state === 'done') done++; else if (i.state === 'na') na++; else open++; }
  const total = done + na + open;
  return { done, na, open, total, complete: total > 0 && open === 0 };
}
// "6/11 (1 N/A)"
export function progressLabel(p) {
  if (!p) return '';
  const base = `${p.done + p.na}/${p.total}`;
  return p.na ? `${base} (${p.na} N/A)` : base;
}
export const progressPct = (p) => (p && p.total ? Math.round(((p.done + p.na) / p.total) * 100) : 0);

// Items (already in sort order) → [{ title, items }] by section_title, in order of first appearance.
export function groupSections(items) {
  const out = []; const at = new Map();
  for (const i of items || []) {
    const k = i.section_title || '';
    if (!at.has(k)) { at.set(k, out.length); out.push({ title: i.section_title || null, items: [] }); }
    out[at.get(k)].items.push(i);
  }
  return out;
}

export const RECORD_STATUS = {
  open: { label: 'Open', color: 'var(--st-in-progress, var(--accent))' },
  complete: { label: 'Complete', color: 'var(--st-done)' },
  archived: { label: 'Archived', color: 'var(--text-4)' },
};

// "1 checklist you can't see" (the F7 wording for a hidden link).
export function hiddenChecklistsText(n) {
  const k = Number(n) || 0;
  return k ? `${k} checklist${k === 1 ? '' : 's'} you can’t see` : '';
}

// Worker refusal codes → plain words. Unknown codes fall back to the worker's message.
const RECORD_ERRORS = {
  link_cross_space: 'A checklist can be linked only to a task in its own space, or from General.',
  item_has_task: 'This item already has a task.',
  item_not_open: 'Only an open item can become a task.',
  record_archived: 'This record is archived. Un-archive it to change it.',
  na_reason_required: 'Say briefly why it doesn’t apply.',
  na_reason_too_long: 'Keep the N/A reason under 300 characters.',
  forbidden: 'Only the record’s owner, its creator or an admin can change that.',
  not_found: 'That record isn’t there, or you can’t see it.',
  record_not_found: 'That record isn’t there, or you can’t see it.',
  task_not_found: 'That task isn’t there, or you can’t see it.',
  unknown_product: 'That product isn’t in the catalog.',
  not_a_record_template: 'Pick a record template.',
  template_inactive: 'That template is archived.',
  kind_locked: 'A template’s kind can’t change after it is created.',
  record_template_not_assignable: 'Record templates are copied per product, not assigned to people.',
  abandoned_read_only: 'That task is abandoned. Reactivate it first.',
  space_archived: 'That space is archived.',
  record_complete: 'This record is complete — re-open an item first.',
  record_link_space: 'This task is tied to a record checklist in another space. Unlink it (or move the checklist’s work) first.',
  section_not_in_template: 'That section belongs to another template. Reload and try again.',
  item_not_in_template: 'That item belongs to another template. Reload and try again.',
  recurring_task: 'A recurring (checklist) task can’t take a record checklist.',
  unlink_conflict: 'Someone else is unlinking this right now. Reload.',
};
export function recordErrorText(e) {
  const msg = String(e?.message || e || '');
  const code = msg.split(/[:\s]/)[0];
  return RECORD_ERRORS[code] || msg || 'Something went wrong';
}

// createTaskFromRecordItem refusals that come AFTER the task exists name it: a lost race ("the item already
// had DKT-m") or a failed claim / link.
export function createTaskErrorText(e) {
  const d = e?.detail || {};
  if (d.error === 'item_has_task' && d.task_no) return `Created ${d.task_no} but the item already had ${d.other_task_no || 'a task'}`;
  if (d.task_no && /^(claim|link)_failed/.test(String(d.error || ''))) return `Created ${d.task_no}, but couldn’t attach it to this item — try again or link it from the task`;
  return recordErrorText(e);
}

// C4: the item's spun-out task is done and the item still open.
export const tickSuggestion = (item) => (item?.suggest_tick && item.task?.task_no ? `${item.task.task_no} is done — tick this?` : null);
