// F8 P2 — record checklists (spec docs/superpowers/specs/2026-11-11-docket-checklists-v2.md §3.2, C3–C6).
// Pure arithmetic + rules the worker (and test/records-core.test.mjs) share: progress, the template-update diff
// (by source_item_id), the snapshot rows, item-state validation, the record status rule (the DB trigger
// checklist_record_status_sync is the enforcing copy; this one answers the worker and the tests), and the
// template version-bump diff.

export const RECORD_ITEM_STATES = ['open', 'done', 'na'];
export const RECORD_STATUSES = ['open', 'complete', 'archived'];
export const NA_REASON_MAX = 300;
export const RECORD_TITLE_MAX = 200;
export const ITEM_TITLE_MAX = 300;
export const NOTE_MAX = 2000;

// Progress = (done + na) / all. A record with no items is never complete.
export function recordProgress(items) {
  let done = 0, na = 0, open = 0;
  for (const i of items || []) {
    if (i.state === 'done') done++;
    else if (i.state === 'na') na++;
    else open++;
  }
  const total = done + na + open;
  return { done, na, open, total, complete: total > 0 && open === 0 };
}
// "6/11 (1 N/A)" — the N/A count is part of the 6.
export function progressLabel(p) {
  const base = `${p.done + p.na}/${p.total}`;
  return p.na ? `${base} (${p.na} N/A)` : base;
}

// The status a record should have after its items changed. Archived stays archived (only an edit un-archives).
export function nextRecordStatus(status, items) {
  if (status === 'archived') return 'archived';
  return recordProgress(items).complete ? 'complete' : 'open';
}
// Un-archiving: back to whatever the items say.
export function unarchivedStatus(items) { return recordProgress(items).complete ? 'complete' : 'open'; }

// Sort order of a snapshot item: template position, with room for copy-only items within a section.
export const snapshotSort = (sectionIndex, itemIndex) => sectionIndex * 1000 + itemIndex * 10;

// Template → flat item list in template order: [{ id, title, help_text, section_title, sort_order }].
// `sections` = [{ title, sort_order, items: [{ id, title, help_text, sort_order }] }].
export function flattenTemplate(sections) {
  const out = [];
  const secs = (sections || []).slice().sort((a, b) => Number(a.sort_order) - Number(b.sort_order));
  secs.forEach((s, si) => {
    (s.items || []).slice().sort((a, b) => Number(a.sort_order) - Number(b.sort_order)).forEach((it, ii) => {
      out.push({ id: it.id, title: it.title, help_text: it.help_text || null, section_id: s.id || null, section_title: s.title || null, sort_order: snapshotSort(si, ii) });
    });
  });
  return out;
}
// Rows to insert for a record: a fresh copy (origin 'snapshot') or the missing items of a pull ('pull'). The 0032
// insert trigger logs items_copied / template_pulled from `origin`.
export function snapshotRows(recordId, flat, origin = 'snapshot') {
  return flat.map(t => ({ record_id: recordId, source_item_id: t.id, section_title: t.section_title, title: String(t.title || '').trim() || 'Item',
    help_text: t.help_text, sort_order: t.sort_order, state: 'open', origin }));
}

// C3: what pulling template updates would add, matched by source_item_id. Never removes or un-ticks anything:
// `missing` = template items the record lacks; `removed` = record item ids whose template item is gone
// (labelled "no longer in template"). Items added only to the copy (source_item_id null) are neither.
export function templateDiff(flatTemplate, recordItems) {
  const have = new Set((recordItems || []).map(i => i.source_item_id).filter(Boolean));
  const tmplIds = new Set((flatTemplate || []).map(t => t.id));
  return {
    missing: (flatTemplate || []).filter(t => !have.has(t.id)),
    removed: (recordItems || []).filter(i => i.source_item_id && !tmplIds.has(i.source_item_id)).map(i => i.id),
  };
}

// A state write: { state, na_reason?, note? } on item `before` → { patch } | { error }. state may be omitted for
// a note-only edit. done / na stamp who and when; open clears them. na needs a short reason (it counts as
// complete). Re-sending the state an item already has changes nothing (the first tick's who/when stand).
export function itemStatePatch(d, before, actorUserId, now) {
  const patch = {};
  const same = d.state !== undefined && d.state === before.state
    && (d.state !== 'na' || String(d.na_reason ?? '').trim() === String(before.na_reason ?? ''));
  if (d.state !== undefined && !same) {
    if (!RECORD_ITEM_STATES.includes(d.state)) return { error: 'bad_state' };
    patch.state = d.state;
    if (d.state === 'na') {
      const r = String(d.na_reason ?? '').trim();
      if (!r) return { error: 'na_reason_required' };
      if (r.length > NA_REASON_MAX) return { error: 'na_reason_too_long' };
      patch.na_reason = r;
    } else patch.na_reason = null;
    if (d.state === 'open') { patch.done_by_user_id = null; patch.done_at = null; }
    else { patch.done_by_user_id = actorUserId; patch.done_at = now; }
  }
  if (d.note !== undefined) {
    const n = d.note == null ? '' : String(d.note).trim();
    if (n.length > NOTE_MAX) return { error: 'note_too_long' };
    patch.note = n || null;
  }
  if (!Object.keys(patch).length) return same ? { patch: null } : { error: 'nothing_to_change' };
  return { patch };
}
// The history event for an item write.
export function itemEvent(before, patch) {
  const st = patch.state;
  if (st !== undefined && (st !== before.state || (st === 'na' && patch.na_reason !== before.na_reason))) {
    return st === 'done' ? 'item_done' : st === 'na' ? 'item_na' : 'item_reopened';
  }
  return 'item_note';
}

// C4: the spun-out task is done and the item still open → suggest the tick (never auto-tick).
export function suggestTick(item, taskCard) {
  return !!(item && item.state === 'open' && taskCard && taskCard.visible !== false && taskCard.status === 'done');
}

// Link rule (P2 brief): a task ↔ record link only when both are in the SAME space, or the record is in General.
// A Founders' / private record never gets named on a task outside its own space.
export function linkAllowed(recordSpace, taskSpaceId) {
  if (!recordSpace) return false;
  return !!recordSpace.is_default || recordSpace.id === taskSpaceId;
}

// Template version bump: items added, removed, renamed or reordered (incl. moved between sections — matched by
// section id, so renaming a section is not a reorder). before = [{ id, title, section_id }] in template order
// (flattenTemplate); after = the save payload's sections ({ id|null, items: [{ id|null, title }] }) in payload
// order. → { changed, added, removed, renamed, reordered }
export function templateItemsDiff(before, afterSections) {
  const after = [];
  (afterSections || []).forEach(s => (Array.isArray(s.items) ? s.items : []).forEach(it =>
    after.push({ id: it.id || null, title: String(it.title || '').trim() || 'Item', section_id: s.id || null })));
  const bIds = (before || []).map(b => b.id);
  const bById = new Map((before || []).map(b => [b.id, b]));
  const aIds = after.filter(a => a.id).map(a => a.id);
  const aSet = new Set(aIds);
  const added = after.filter(a => !a.id || !bById.has(a.id)).length;
  const removed = bIds.filter(id => !aSet.has(id)).length;
  const renamed = after.filter(a => a.id && bById.has(a.id) && String(bById.get(a.id).title || '').trim() !== a.title).length;
  const keptBefore = bIds.filter(id => aSet.has(id));
  const keptAfter = aIds.filter(id => bById.has(id));
  const moved = after.filter(a => a.id && bById.has(a.id) && (bById.get(a.id).section_id || null) !== a.section_id).length;
  const reordered = keptBefore.join(',') !== keptAfter.join(',') || moved > 0;
  return { changed: !!(added || removed || renamed || reordered), added, removed, renamed, reordered };
}

// ⌘K / list search: a safe ilike term (PostgREST or=(…) syntax characters and wildcards stripped).
export function searchTerm(q) {
  return String(q || '').replace(/[,()*%_\\":.]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
}
