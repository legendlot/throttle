// F9 R9a — the plan tree (spec 2026-11-11-docket-plan-layer.md §7.3): theme → milestone → result → task. Pure;
// no I/O. Every input is ALREADY gated by the worker (getPlanTree): `items` are plan_items_for rows (the §5.3
// projection — fields a level may not see are already null there; level L / none never arrive), `tasks` are
// top-level, non-archived task rows linked to those items, and `visibleIds` says which of them the caller may
// see. Below level F an invisible task is in no count and never named; at F it is counted in `hidden` only.
import { noDataSource } from './review-core.mjs';

const CLOSED = ['dropped', 'split', 'done'];
export const TREE_TASK_CAP = 25;
export const TREE_LEVELS = ['F', 'R', 'O', 'T'];   // L / none never appear in the tree
const KIND_RANK = { theme: 0, milestone: 1, result: 2 };
const effMs = (t) => Date.parse(t?.revised_deadline || t?.deadline || '');

// The item row the tree returns: the projection's fields (a level-T row is code + title + kind + level (+ state,
// as getPlan gives it) — nothing else), plus effective date, re-dated flag, ⚠ no data source, counts, on-time.
function itemRow(i, { names, metrics, isF, parentId }) {
  const T = i.level === 'T';
  return {
    id: i.id, parent_id: parentId || null, kind: i.kind, code: i.code || null, title: i.title,
    level: i.level, state: i.state || null,
    owner_employee_id: T ? null : i.owner_employee_id || null,
    owner_name: T || !i.owner_employee_id ? null : names[i.owner_employee_id] || null,
    due_date: T ? null : i.due_date || null, revised_due_date: T ? null : i.revised_due_date || null,
    effective_due: T ? null : i.revised_due_date || i.due_date || null,
    redated: T ? false : !!i.revised_due_date,
    no_data_source: T ? null : noDataSource(i, metrics),
    ...(isF ? { restricted: !!i.restricted } : {}),
  };
}

// The REAL plan structure — { id, parent_id, kind } of every plan item, read by the worker (service role) and
// NEVER emitted — links the caller's items through ones they can't see: each shown item hangs under its nearest
// VISIBLE ancestor, `theme=` matches it by its real theme, and a visible ancestor's rollup takes every
// countable task linked anywhere in its real subtree. Without it (unit tests) the projection's own links serve.
function structureOf(items, structure) {
  const real = new Map((structure || []).map(x => [x.id, x]));
  for (const i of items) if (!real.has(i.id)) real.set(i.id, { id: i.id, parent_id: i.parent_id || null, kind: i.kind });
  return real;
}
// Which items are shown, and the tree around them. The theme filter, then the state filter (a closed item hides
// its subtree unless `closed`), then `mine` (owned items + their shown ancestors).
function selectTree(items, { closed = false, mine = false, employeeId = null, themeId = null, structure = null } = {}) {
  const byId = new Map(items.map(i => [i.id, i]));
  const real = structureOf(items, structure);
  const up = (id) => real.get(id)?.parent_id || null;
  const vparent = new Map();   // item → its nearest visible ancestor (null = a root here)
  for (const i of items) { let p = up(i.id); for (let n = 0; p && !byId.has(p) && n < 8; n++) p = up(p); vparent.set(i.id, p && byId.has(p) ? p : null); }
  const themeOf = (id) => { let x = id; for (let n = 0; up(x) && n < 8; n++) x = up(x); return real.get(x)?.kind === 'theme' ? x : null; };
  const kids = new Map();
  for (const i of items) { const p = vparent.get(i.id); if (p) (kids.get(p) || kids.set(p, []).get(p)).push(i); }
  const order = (a, b) => (KIND_RANK[a.kind] - KIND_RANK[b.kind]) || ((a.sort ?? 0) - (b.sort ?? 0))
    || String(a.code || '').localeCompare(String(b.code || ''), undefined, { numeric: true }) || String(a.id).localeCompare(String(b.id));
  for (const l of kids.values()) l.sort(order);
  const roots = items.filter(i => !vparent.get(i.id)).sort(order);
  const shown = [];
  const walk = (i) => {
    if (!closed && CLOSED.includes(i.state)) return;
    if (themeId && themeOf(i.id) !== themeId) return;   // a whole subtree shares its theme
    shown.push(i);
    for (const c of kids.get(i.id) || []) walk(c);
  };
  for (const r of roots) walk(r);
  let keep = new Set(shown.map(i => i.id));
  if (mine) {
    const m = new Set();
    for (const i of shown) {
      if (!employeeId || i.owner_employee_id !== employeeId) continue;
      for (let x = i.id; x && keep.has(x) && !m.has(x); x = vparent.get(x)) m.add(x);
    }
    keep = m;
  }
  return { byId, kids, roots, keep, vparent, real, up };
}
// The item ids whose tasks the tree needs (one batched read): every shown item and its whole REAL subtree —
// hidden and closed descendants included, their countable tasks roll up into the visible ancestors.
export function treeTaskItemIds(items = [], o = {}) {
  const { keep, real } = selectTree(items, o);
  const realKids = new Map();
  for (const x of real.values()) if (x.parent_id) (realKids.get(x.parent_id) || realKids.set(x.parent_id, []).get(x.parent_id)).push(x.id);
  const out = new Set();
  const down = (id) => { if (out.has(id)) return; out.add(id); for (const c of realKids.get(id) || []) down(c); };
  for (const id of keep) down(id);
  return [...out];
}

// buildTree(items, tasks, { now, visibleIds, level, closed, mine, employeeId, themeId, structure, names, metrics })
//   level      — the caller's level: 'F' (plan admin) counts invisible tasks as `hidden`; anything else never does
//   closed     — include dropped / split / done items (default: hidden, and so is everything under them)
//   mine       — only items the caller (employeeId) owns, plus their ancestors so the path renders
//   themeId    — one theme's subtree (the caller resolves "can't see it" → 404 before calling)
//   structure  — the real plan links (see structureOf); never emitted
// → { items: [row + counts + on_time], tasks: { [item id]: { rows, more } }, hidden_total }
export function buildTree(items = [], tasks = [], o = {}) {
  const { now = Date.now(), visibleIds = new Set(), level = null, names = {}, metrics = [] } = o;
  const isF = level === 'F';
  const { byId, kids, roots, keep, vparent, up } = selectTree(items, o);
  const isOpen = (t) => t.status !== 'done' && t.status !== 'abandoned';

  // Rollups: each countable task once into every visible item on its REAL chain (its own item, then up). Below F
  // only tasks the caller can see count; at F an invisible one counts as `hidden` only. Abandoned: no count.
  const zero = () => ({ open: 0, done: 0, overdue: 0, hidden: 0, on_time: 0, scored: 0 });
  const acc = new Map();
  const tasksOf = new Map();
  for (const t of tasks) {
    if (!t.plan_item_id || t.parent_task_id) continue;
    (tasksOf.get(t.plan_item_id) || tasksOf.set(t.plan_item_id, []).get(t.plan_item_id)).push(t);
    if (t.status === 'abandoned') continue;
    const vis = visibleIds.has(t.id);
    if (!vis && !isF) continue;
    const c = zero();
    if (!vis) c.hidden = 1;
    else {
      const open = isOpen(t), dl = Date.parse(t.deadline || '');
      if (open) { c.open = 1; if (effMs(t) < now) c.overdue = 1; } else c.done = 1;
      // the score's rule: the FIRST commitment (deadline) is the promise
      if (Number.isFinite(dl) && (t.status === 'done' || (open && dl < now))) {
        c.scored = 1;
        if (t.status === 'done' && t.completed_at && Date.parse(t.completed_at) <= dl) c.on_time = 1;
      }
    }
    for (let id = t.plan_item_id, n = 0; id && n < 8; id = up(id), n++) {
      if (!byId.has(id)) continue;
      const a = acc.get(id) || acc.set(id, zero()).get(id);
      for (const f of Object.keys(c)) a[f] += c[f];
    }
  }

  const out = [], leaves = {};
  const emit = (i) => {
    if (!keep.has(i.id)) return;
    const c = acc.get(i.id) || zero();
    const vp = vparent.get(i.id);
    out.push({ ...itemRow(i, { names, metrics, isF, parentId: keep.has(vp) ? vp : null }),
      counts: { open: c.open, done: c.done, overdue: c.overdue, hidden: isF ? c.hidden : 0 },
      on_time: { on_time: c.on_time, scored: c.scored, pct: c.scored ? Math.round((100 * c.on_time) / c.scored) : null } });
    // Leaves: the visible tasks linked DIRECTLY here — open by effective deadline (no date last), then done
    // by completion (latest first); abandoned never; TREE_TASK_CAP rows, the rest counted in `more`.
    const direct = (tasksOf.get(i.id) || []).filter(t => visibleIds.has(t.id) && t.status !== 'abandoned');
    const open = direct.filter(isOpen).sort((a, b) => {
      const ea = effMs(a), eb = effMs(b);
      return (Number.isFinite(ea) ? ea : Infinity) - (Number.isFinite(eb) ? eb : Infinity) || String(a.task_no).localeCompare(String(b.task_no), undefined, { numeric: true });
    });
    const done = direct.filter(t => t.status === 'done').sort((a, b) => String(b.completed_at || '').localeCompare(String(a.completed_at || '')));
    const all = [...open, ...done];
    if (all.length) leaves[i.id] = { rows: all.slice(0, TREE_TASK_CAP).map(t => ({ id: t.id, task_no: t.task_no || null, title: t.title, status: t.status,
      owner_name: t.owner_employee_id ? names[t.owner_employee_id] || null : null,
      effective_deadline: t.revised_deadline || t.deadline || null, overdue: isOpen(t) && effMs(t) < now })), more: Math.max(0, all.length - TREE_TASK_CAP) };
    for (const k of kids.get(i.id) || []) emit(k);
  };
  for (const r of roots) emit(r);
  // F only: distinct invisible, non-abandoned tasks linked anywhere under a shown item.
  const under = (id) => { for (let x = id, n = 0; x && n < 8; x = up(x), n++) if (keep.has(x)) return true; return false; };
  const hidden = isF ? new Set(tasks.filter(t => t.plan_item_id && !t.parent_task_id && t.status !== 'abandoned' && !visibleIds.has(t.id) && under(t.plan_item_id)).map(t => t.id)).size : null;
  return { items: out, tasks: leaves, hidden_total: hidden };
}
