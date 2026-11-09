// Grid triage (Docket F3) — the pure parts: queue stepping, progress counts, and the
// save patch + guards. The modal is components/tasks/GridTriage.js.
//
// State: { ids, i, results, saved } — `ids` is the queue snapshotted at open (display order),
// `i` the current card (i === ids.length → the summary), `saved` id → the patch that was
// written (shown on a locked card when you step back to it), `results` id → outcome:
//   'set'       owner AND deadline now set — it leaves the Grid
//   'partial'   saved, but one of them is still missing — it stays in the Grid
//   'abandoned' abandoned with a reason
//   'skipped'   passed over (S / → / a save with nothing changed)
//   'gone'      a 4xx on save: changed by someone else / no longer editable → skipped with a note
// A card that was saved or abandoned is read-only when you step back to it; a skipped or
// gone one can still be worked.

export function startTriage(ids) {
  return { ids: [...ids], i: 0, results: {}, saved: {} };
}

export function triageReducer(state, action) {
  const { ids, i, results } = state;
  const id = ids[i];
  switch (action.type) {
    case 'record': {                                 // a save / abandon / gone
      // Keyed on the id of the task that was WRITTEN (action.id), not whatever card is current
      // when the write resolves; it advances only if that task is still the current card.
      const rid = action.id ?? id;
      if (rid == null || !ids.includes(rid)) return state;
      const saved = action.patch ? { ...state.saved, [rid]: action.patch } : state.saved;
      return { ...state, results: { ...results, [rid]: action.result }, saved, i: rid === id ? Math.min(i + 1, ids.length) : i };
    }
    case 'skip':                                     // S / → — never overwrites a saved outcome
      if (id == null) return state;
      return { ...state, results: results[id] ? results : { ...results, [id]: 'skipped' }, i: Math.min(i + 1, ids.length) };
    case 'back':
      return { ...state, i: Math.max(0, i - 1) };
    default:
      return state;
  }
}

export const isLocked = (result) => result === 'set' || result === 'partial' || result === 'abandoned';

export function triageCounts(state) {
  const c = { set: 0, partial: 0, abandoned: 0, skipped: 0, gone: 0 };
  for (const r of Object.values(state.results)) if (c[r] != null) c[r] += 1;
  return c;
}

// "4 of 22 · 2 set · 1 still in the Grid · 1 abandoned · 1 skipped" (zero parts omitted).
export function progressLine(state) {
  const c = triageCounts(state);
  const total = state.ids.length;
  const pos = Math.min(state.i + 1, total);
  const parts = [`${pos} of ${total}`];
  if (c.set) parts.push(`${c.set} set`);
  if (c.partial) parts.push(`${c.partial} still in the Grid`);
  if (c.abandoned) parts.push(`${c.abandoned} abandoned`);
  if (c.skipped + c.gone) parts.push(`${c.skipped + c.gone} skipped`);
  return parts.join(' · ');
}

// The updateTask body for a card: ONLY fields the person changed ON THIS CARD (`dirty`) and
// that differ from the live row — an untouched field is never sent, so a change made
// elsewhere (TaskView via "Open task") can't be reverted by a stale draft. A deadline is sent
// only when the task has none — the first deadline becomes the immutable original
// (updateTask logs deadline_set); after that only reviseDeadline (with a reason) moves it.
// → { patch, error, complete }. `patch` null = nothing to save.
export function buildTriagePatch(task, draft, now = new Date(), dirty = null) {
  const touched = (f) => (dirty ? dirty.has(f) : true);
  const patch = {};
  if (touched('owner_employee_id') && draft.owner_employee_id && draft.owner_employee_id !== (task.owner_employee_id || null)) patch.owner_employee_id = draft.owner_employee_id;
  if (touched('deadline') && !task.deadline && draft.deadline) {
    const t = new Date(draft.deadline);
    if (isNaN(t)) return { patch: null, error: 'That deadline is not a valid date.', complete: false };
    if (t <= now) return { patch: null, error: 'That deadline is in the past. A first deadline can’t be changed later without a reason, so pick a future time.', complete: false };
    patch.deadline = draft.deadline;
  }
  if (touched('priority') && draft.priority && draft.priority !== (task.priority || null)) patch.priority = draft.priority;
  const owner = patch.owner_employee_id || task.owner_employee_id;
  const deadline = patch.deadline || task.deadline;
  return { patch: Object.keys(patch).length ? patch : null, error: null, complete: !!owner && !!deadline };
}

// The outcome of a successful updateTask. The worker silently ignores a deadline if the
// task already had one (someone set it first), and says so by leaving 'deadline' out of
// `updated` — that is NOT "set": the deadline on the task isn't the one picked here.
// → { result, patch, note }
export function saveOutcome(patch, res, complete) {
  const updated = Array.isArray(res?.updated) ? res.updated : (res?.unchanged ? [] : null);
  if (patch.deadline && updated && !updated.includes('deadline')) {
    const { deadline, ...rest } = patch;
    const others = Object.keys(rest).filter(f => updated.includes(f));
    return { result: others.length ? 'partial' : 'gone', patch: others.length ? rest : null, note: 'deadline was already set elsewhere' };
  }
  if (res?.unchanged) return { result: 'skipped', patch: null, note: 'nothing changed — it already had these values' };
  return { result: complete ? 'set' : 'partial', patch, note: null };
}

// "3d ago", "2mo ago" — created date on the card.
export function relAgo(iso, now = new Date()) {
  if (!iso) return '';
  const mins = Math.max(0, Math.floor((now - new Date(iso)) / 60000));
  if (mins < 60) return mins < 1 ? 'just now' : `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 31) return `${d}d ago`;
  const mo = Math.floor(d / 30.44);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(d / 365.25)}y ago`;
}

// A 4xx that means "this task changed under us" — 403 forbidden (no longer yours to edit),
// 404 not found, 409 conflict, 422 abandoned_read_only — skips the card with a note. A 400
// (a bad value), a 5xx or a network failure keeps the card so the person can fix / retry.
const GONE = new Set([403, 404, 409, 410, 422]);
export const isGoneError = (e) => !!e && GONE.has(Number(e.status));
