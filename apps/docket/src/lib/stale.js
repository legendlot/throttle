// F4 "Clean up" — pure logic for the stale-work sweep (components/tasks/StaleSweep.js).
// The worker (getStaleTasks) decides WHAT is stale and stamps stale_reasons ⊆
// ['overdue30','untouched60']; this file only groups and labels. Pull-only (§S309).

export const STALE_GROUP_LABEL = { overdue30: 'Overdue 30+ days', untouched60: 'Untouched 60+ days' };
const DAY = 86400000;

// A task that is both overdue and untouched shows once, under Overdue — the overdue date
// is the more specific fact and the one a revise fixes.
export function primaryReason(t) {
  const r = t?.stale_reasons || [];
  if (r.includes('overdue30')) return 'overdue30';
  if (r.includes('untouched60')) return 'untouched60';
  return null;
}

export const effective = (t) => t?.revised_deadline || t?.deadline || null;
// Last touched: updated_at is NULL on a task never edited since creation — fall back to
// created_at (those are the longest-sitting rows; the worker does the same).
export const lastTouched = (t) => t?.updated_at || t?.created_at || null;

// Whole days from `iso` to `now` (floored; 0 for the future).
export function daysSince(iso, now = new Date()) {
  const t = iso ? new Date(iso).getTime() : NaN;
  if (isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / DAY));
}

// The row's age column: "42d over" off the effective deadline for an overdue task,
// "untouched 75d" off the last touch (updated_at, else created_at) otherwise. → { kind: 'over'|'untouched', days, text, iso }
export function staleAge(t, now = new Date()) {
  if (primaryReason(t) === 'overdue30') {
    const iso = effective(t), days = daysSince(iso, now);
    return { kind: 'over', days, iso, text: `${days}d over` };
  }
  const iso = lastTouched(t), days = daysSince(iso, now);
  return { kind: 'untouched', days, iso, text: `untouched ${days}d` };
}

// Mine → [Overdue 30+, Untouched 60+] (empty groups dropped, server order kept inside).
// Everyone → one group per owner, biggest first, "No owner" last.
// → [{ key, label, rows }]
export function groupStale(rows, scope = 'mine') {
  if (scope === 'all') {
    const by = new Map();
    for (const t of rows) {
      const key = t.owner_employee_id || '';
      if (!by.has(key)) by.set(key, { key: key || 'none', label: key ? (t.owner_name || 'Unknown owner') : 'No owner', rows: [] });
      by.get(key).rows.push(t);
    }
    return [...by.values()].sort((a, b) =>
      (a.key === 'none') - (b.key === 'none') || b.rows.length - a.rows.length || a.label.localeCompare(b.label));
  }
  const out = [];
  for (const key of ['overdue30', 'untouched60']) {
    const g = rows.filter(t => primaryReason(t) === key);
    if (g.length) out.push({ key, label: STALE_GROUP_LABEL[key], rows: g });
  }
  return out;
}

// Revise / first-deadline guard. A task with a deadline gets reviseDeadline (reason
// REQUIRED, logged); one without gets its FIRST deadline via updateTask, which becomes the
// immutable original — no reason field exists for that write. A past date is refused either way.
// → error string | null
export function reviseError(task, iso, reason, now = new Date()) {
  if (!iso) return 'Pick a new date.';
  const t = new Date(iso);
  if (isNaN(t)) return 'That isn’t a valid date.';
  if (t <= now) return 'That date is in the past — pick a future one.';
  if (effective(task) && !String(reason || '').trim()) return 'A reason is required — it’s logged on the task.';
  return null;
}
