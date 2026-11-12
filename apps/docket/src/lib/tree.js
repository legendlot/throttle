// F9 R9a — the plan tree (/plan/tree, spec docs/superpowers/specs/2026-11-11-docket-plan-layer.md §7.3).
// Pure: expand state and the flattened render list over ONE getPlanTree response
// ({ items, tasks: { [item_id]: { rows, more } }, hidden_total, generated_at }). Every count, rollup and
// visibility cut is the worker's (tree-core.mjs); this file only orders rows for the screen.

import { planErrorText } from './plan.js';

// A failed getPlanTree → words. A code the plan layer doesn't word (db_error, server_error, …) never shows raw.
export const TREE_LOAD_FAILED = 'Couldn’t load the plan tree — try again.';
export function treeErrorText(e) {
  const code = e?.message || String(e || '');
  const t = planErrorText(e);
  return t && t !== code ? t : TREE_LOAD_FAILED;
}

// parent_id is the nearest VISIBLE ancestor (a result whose milestone is hidden sits under its theme), so
// depth comes from the walk, never from the kind.
// Items keep the worker's order (it sends them already sorted); a row whose parent isn't in the response
// (mine=1 trims, or a parent the caller can't see) renders as a root rather than vanishing.
export function treeIndex(items = []) {
  const list = (items || []).filter(Boolean);
  const ids = new Set(list.map(i => i.id));
  const kids = new Map();
  const roots = [];
  for (const it of list) {
    if (it.parent_id && ids.has(it.parent_id)) {
      if (!kids.has(it.parent_id)) kids.set(it.parent_id, []);
      kids.get(it.parent_id).push(it);
    } else roots.push(it);
  }
  return { roots, kids, ids };
}

const taskBlock = (tasks, id) => tasks?.[id] || { rows: [], more: 0 };
export function hasChildren(item, idx, tasks) {
  const b = taskBlock(tasks, item.id);
  return (idx.kids.get(item.id) || []).length > 0 || (b.rows || []).length > 0 || Number(b.more) > 0;
}

// Default (§C): themes open to show their milestones; milestones and results closed.
export function defaultExpanded(items = []) {
  return new Set((items || []).filter(i => i?.kind === 'theme').map(i => i.id));
}
// Expand all = every item that has something under it; collapse all = nothing open.
export function expandAll(items = [], tasks = {}) {
  const idx = treeIndex(items);
  return new Set((items || []).filter(i => i && hasChildren(i, idx, tasks)).map(i => i.id));
}
export function toggle(set, id) { const n = new Set(set); if (n.has(id)) n.delete(id); else n.add(id); return n; }

// The render list: [{ type: 'item', item, depth, open, expandable }
//                  | { type: 'task', task, depth, itemId } | { type: 'more', itemId, more, depth }].
// Under an open item: its child items first, then the tasks linked directly to it, then "+N more".
export function flattenTree(items = [], tasks = {}, expanded = new Set()) {
  const idx = treeIndex(items);
  const out = [];
  const seen = new Set();
  const walk = (it, depth) => {
    if (seen.has(it.id)) return;   // a malformed cycle never loops
    seen.add(it.id);
    const expandable = hasChildren(it, idx, tasks);
    const open = expandable && expanded.has(it.id);
    out.push({ type: 'item', item: it, depth, open, expandable });
    if (!open) return;
    for (const c of idx.kids.get(it.id) || []) walk(c, depth + 1);
    const b = taskBlock(tasks, it.id);
    for (const t of b.rows || []) if (t) out.push({ type: 'task', task: t, depth: depth + 1, itemId: it.id });
    if (Number(b.more) > 0) out.push({ type: 'more', itemId: it.id, more: Number(b.more), depth: depth + 1 });
  };
  for (const r of idx.roots) walk(r, 0);
  return out;
}

// "3 open · 5 done · 1 overdue" pieces (zeros dropped except open, so a row always says something).
export function countParts(c = {}) {
  const n = (k) => Number(c?.[k]) || 0;
  const parts = [{ key: 'open', text: `${n('open')} open` }];
  if (n('done')) parts.push({ key: 'done', text: `${n('done')} done` });
  if (n('overdue')) parts.push({ key: 'overdue', text: `${n('overdue')} overdue` });
  return parts;
}
export function onTimeText(o) {
  if (!o || o.pct == null || !Number(o.scored)) return '—';
  return `${Math.round(Number(o.pct))}% on time`;
}
export function hiddenText(c) { const n = Number(c?.hidden) || 0; return n > 0 ? `+${n} hidden` : ''; }
export const KIND_SHORT = { theme: 'Theme', milestone: 'Milestone', result: 'Result' };
// The theme picker's options from an unfiltered response (themes only).
export function themeOptions(items = []) {
  return [{ value: '', label: 'All themes' },
    ...(items || []).filter(i => i?.kind === 'theme').map(t => ({ value: t.id, label: [t.code, t.title].filter(Boolean).join(' · ') }))];
}
