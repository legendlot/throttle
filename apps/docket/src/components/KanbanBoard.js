'use client';
/* KanbanBoard — board view for the Docket tasks page (ClickUp redesign P4).
   Columns come from the active group-by axis (default: status). Dragging a card
   between columns sets that axis's field on the task via ctx.saveField (status →
   changeStatus, owner/team/program → updateTask) — audited, optimistic. Shift+←/→ on a
   focused card makes the same call with the neighbouring column.
   Frontend-only: reuses the already-loaded task rows + the existing save paths.
   Abandoned tasks are never shown and Abandoned is never a column (terminal,
   reason-gated). Top-level tasks only (sub-tasks surface as a count).
   Columns: 272px, tinted with the status colour when the axis is status (neutral
   otherwise), collapsible to a strip (localStorage `docket.board.collapsed`), each with
   a foot "+ Add task" that creates through the page's createInGroup with the column's
   value prefilled. Cards: S / M / L (ctx.cardSize, set in Customize). */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MoreHorizontal, Plus, ListTree, UserRound, ChevronsRightLeft, Link2, MessageSquare } from 'lucide-react';
import { Avatar, personColor } from './primitives.js';
import { SETTABLE_STATUSES, STATUS_MAP } from '../lib/tasks.js';
import { Pill, Menu, MenuItem, AvatarStack, Button } from './ui/index.js';
import { PriorityFlag, DeadlineCell } from './tasks/TaskCells.js';
import { useQuickCapture, CaptureChips, withHint, keepFocus, isSubmitKey } from './tasks/QuickCapture.js';

const NONE = '__none__';
const COLLAPSED_KEY = 'docket.board.collapsed';

// Per-axis: which task field a drop writes, and how to read a card's current bucket.
const AXIS = {
  status:     { field: 'status',            keyOf: (t) => t.status,                     curr: (t) => t.status },
  person:     { field: 'owner_employee_id', keyOf: (t) => t.owner_employee_id || NONE,  curr: (t) => t.owner_employee_id || '' },
  department: { field: 'department_id',     keyOf: (t) => t.department_id || NONE,       curr: (t) => t.department_id || '' },
  program:    { field: 'program_id',        keyOf: (t) => t.program?.id || NONE,         curr: (t) => t.program?.id || '' },
};
const NONE_LABEL = { person: 'Unassigned', department: 'No team', program: 'No program' };

function buildColumns(axis, rows) {
  if (axis === 'status') {
    // Fixed columns, always present (so an empty column is still a drop target).
    return SETTABLE_STATUSES.map(s => ({ key: s.key, value: s.key, label: s.label, color: s.color }));
  }
  const seen = new Map();
  let hasNone = false;
  for (const t of rows) {
    if (axis === 'person') {
      if (t.owner_employee_id) seen.set(t.owner_employee_id, { value: t.owner_employee_id, label: t.owner_name || 'Unknown', color: personColor(t.owner_employee_id) });
      else hasNone = true;
    } else if (axis === 'department') {
      if (t.department_id) seen.set(t.department_id, { value: t.department_id, label: t.department_name || 'Unknown', color: personColor(t.department_id) });
      else hasNone = true;
    } else { // program
      if (t.program?.id) seen.set(t.program.id, { value: t.program.id, label: t.program.name || 'Program', color: 'var(--text-4)' });
      else hasNone = true;
    }
  }
  const cols = [...seen.values()].sort((a, b) => a.label.localeCompare(b.label)).map(c => ({ key: c.value, ...c }));
  if (hasNone) cols.push({ key: NONE, value: '', label: NONE_LABEL[axis], color: 'var(--text-4)' });
  return cols;
}

function readCollapsed() {
  try { const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
  catch { return {}; }
}

export function KanbanBoard({ rows, axis, ctx }) {
  const ax = AXIS[axis] || AXIS.status;
  const columns = buildColumns(axis, rows);
  const [dragId, setDragId] = useState(null);
  const [overKey, setOverKey] = useState(null);
  const [collapsed, setCollapsed] = useState({});
  useEffect(() => { setCollapsed(readCollapsed()); }, []);
  const ckey = (col) => `${axis}:${col.key}`;
  function setColCollapsed(col, on) {
    setCollapsed(prev => {
      const next = { ...prev };
      if (on) next[ckey(col)] = true; else delete next[ckey(col)];
      try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }

  // The board owns its height: columns scroll vertically under sticky heads, the board
  // scrolls sideways inside .kb-scroll — the page scroller (.dk-scroll) does neither.
  // --kb-h = what is left of .dk-scroll below the board's top, minus the canvas's
  // bottom padding (trimmed on desktop in board mode; on mobile it clears the tab bar).
  // Re-measured when the scroller or anything above the board (toolbar wrap, the New
  // task capture opening) changes size.
  const scrollRef = useRef(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const sc = el?.closest('.dk-scroll');
    if (!el || !sc) return;
    const canvas = el.closest('.dk-canvas');
    const fit = () => {
      const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
      const pad = canvas ? parseFloat(getComputedStyle(canvas).paddingBottom) || 0 : 0;
      el.style.setProperty('--kb-h', Math.max(280, Math.floor(sc.clientHeight - top - pad)) + 'px');
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(sc);
    // Everything that sits above the board in the page (views bar, toolbar, capture).
    let n = el.closest('[data-density]') ? el : null;
    while (n && n.parentElement && !n.parentElement.matches('[data-density]')) n = n.parentElement;
    for (let sib = n?.previousElementSibling; sib; sib = sib.previousElementSibling) ro.observe(sib);
    return () => ro.disconnect();
  }, []);

  const byCol = {};
  for (const c of columns) byCol[c.key] = [];
  for (const t of rows) {
    const k = ax.keyOf(t);
    (byCol[k] = byCol[k] || []).push(t);
  }
  const rowIndex = new Map(rows.map((t, i) => [t.id, i]));
  const dragTask = dragId ? rows.find(t => t.id === dragId) : null;

  function onDragStart(e, task) {
    setDragId(task.id);
    try { e.dataTransfer.setData('text/plain', task.id); e.dataTransfer.effectAllowed = 'move'; } catch { /* ignore */ }
  }
  function onDragEnd() { setDragId(null); setOverKey(null); }
  // The one write path for a move (drag or Shift+←/→) — unchanged from the pre-P4 board.
  // saveField isn't optimistic: an id stays in `moving` until its write settles, so a
  // repeat press can't re-read the stale value and send the change twice.
  const moving = useRef(new Set());
  function moveTo(task, col) {
    if (!task || !task._can_edit) return null;
    if (ax.curr(task) === col.value) return null; // already here
    if (moving.current.has(task.id)) return null;
    moving.current.add(task.id);
    return Promise.resolve(ctx.saveField(task, ax.field, col.value)).finally(() => moving.current.delete(task.id));
  }
  function onDrop(col) {
    const task = rows.find(t => t.id === dragId);
    setOverKey(null); setDragId(null);
    moveTo(task, col);
  }
  // Keep the keyboard on a moved card: its node remounts in the new column once the
  // write lands, so focus it from an effect after `rows` change (and once settled).
  const [pendingFocus, setPendingFocus] = useState(null); // { id, key, settled }
  useEffect(() => {
    if (!pendingFocus) return;
    const t = rows.find(r => r.id === pendingFocus.id);
    const node = document.querySelector(`.kb-card[data-card-id="${CSS.escape(pendingFocus.id)}"]`);
    if (node && document.activeElement !== node) node.focus();
    if (!t || ax.keyOf(t) === pendingFocus.key || pendingFocus.settled) setPendingFocus(null);
  }, [rows, pendingFocus, ax]);
  function moveBy(task, dir) {
    if (moving.current.has(task.id)) return;
    const i = columns.findIndex(c => c.key === ax.keyOf(task));
    if (i < 0) return;
    // Skip collapsed columns, as the arrow walk does.
    let col = null;
    for (let j = i + dir; j >= 0 && j < columns.length; j += dir) { if (!collapsed[ckey(columns[j])]) { col = columns[j]; break; } }
    if (!col) return;
    const p = moveTo(task, col);
    if (!p) return;
    setPendingFocus({ id: task.id, key: col.key, settled: false });
    p.then(() => setPendingFocus(f => (f && f.id === task.id ? { ...f, settled: true } : f)));
  }
  // Arrow keys walk the cards: ↑/↓ within a column, ←/→ to the neighbouring column.
  function focusNeighbour(task, dx, dy) {
    const ci = columns.findIndex(c => c.key === ax.keyOf(task));
    if (dy) {
      const list = byCol[columns[ci]?.key] || [];
      const next = list[list.findIndex(t => t.id === task.id) + dy];
      if (next) document.querySelector(`.kb-card[data-card-id="${next.id}"]`)?.focus();
      return;
    }
    for (let j = ci + dx; j >= 0 && j < columns.length; j += dx) {
      const c = columns[j];
      if (collapsed[ckey(c)] || !(byCol[c.key] || []).length) continue;
      document.querySelector(`.kb-card[data-card-id="${byCol[c.key][0].id}"]`)?.focus();
      return;
    }
  }

  const statusAxis = axis === 'status';
  const sortedByAxis = (axis === 'status' && ctx.sortKey === 'status') || (axis === 'person' && ctx.sortKey === 'owner_name');
  return (
    <div ref={scrollRef} className={'kb-scroll' + (ctx.showIds ? ' show-ids' : '')} data-card-size={ctx.cardSize || 'm'}>
      <div className="kb">
        {columns.map(col => {
          const cards = byCol[col.key] || [];
          const isOver = overKey === col.key && !!dragTask && ax.curr(dragTask) !== col.value;
          const tint = statusAxis ? { '--kb-tint': col.color } : undefined;
          const dragProps = {
            onDragOver: (e) => { if (dragId) { e.preventDefault(); setOverKey(col.key); } },
            onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOverKey(k => (k === col.key ? null : k)); },
            onDrop: (e) => { e.preventDefault(); onDrop(col); },
          };
          if (collapsed[ckey(col)]) {
            return (
              <button key={col.key} type="button" className={'kb-strip' + (statusAxis ? ' tinted' : '') + (isOver ? ' over' : '')} style={tint}
                onClick={() => setColCollapsed(col, false)} title={`Expand ${col.label}`} aria-label={`Expand column ${col.label} (${cards.length})`} {...dragProps}>
                <span className="kb-strip-count">{cards.length}</span>
                <span className="kb-strip-label">{col.label}</span>
              </button>
            );
          }
          // Where the dragged card will land: rows are already in board order and a move
          // keeps that order, so its slot is the count of target cards ahead of it.
          // Sorted by this axis's own field, the slot can't be known — highlight only.
          let landAt = -1;
          if (isOver && !sortedByAxis) { const di = rowIndex.get(dragTask.id); landAt = cards.filter(t => rowIndex.get(t.id) < di).length; }
          return (
            <section key={col.key} className={'kb-col' + (statusAxis ? ' tinted' : '') + (isOver ? ' over' : '')} style={tint}
              data-col={col.key} aria-label={col.label} {...dragProps}>
              <ColumnHead col={col} count={cards.length} statusAxis={statusAxis}
                onCollapse={() => setColCollapsed(col, true)}
                onAdd={ctx.createIn ? () => setTimeout(() => document.querySelector(`.kb-col[data-col="${CSS.escape(col.key)}"] .kb-add-open, .kb-col[data-col="${CSS.escape(col.key)}"] .kb-capture textarea`)?.click(), 0) : null} />
              <div className="kb-body">
                {cards.map((task, i) => (
                  <div key={task.id} className="kb-slot">
                    {landAt === i && <div className="kb-insert" aria-hidden />}
                    <KanbanCard task={task} axis={axis} ctx={ctx}
                      dragging={dragId === task.id} onDragStart={onDragStart} onDragEnd={onDragEnd}
                      onMove={moveBy} onWalk={focusNeighbour} />
                  </div>
                ))}
                {landAt === cards.length && <div className="kb-insert" aria-hidden />}
                {cards.length === 0 && !isOver && <div className="kb-empty">No tasks</div>}
                {ctx.createIn && <ColumnAdd col={col} create={(title, extras) => ctx.createIn(title, col.value, extras)} />}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function ColumnHead({ col, count, statusAxis, onCollapse, onAdd }) {
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  return (
    <div className="kb-head">
      {statusAxis
        ? <Pill tone="status" color={col.color} dot>{col.label}</Pill>
        : <Pill dot color={col.color}>{col.label}</Pill>}
      <span className="kb-count">{count}</span>
      <button ref={ref} type="button" className="tl-act kb-more" aria-label={`${col.label} column actions`} aria-haspopup="menu"
        onClick={() => setOpen(o => !o)}><MoreHorizontal size={14} /></button>
      <Menu anchorRef={ref} open={open} onClose={() => setOpen(false)} width={180} label="Column actions">
        <MenuItem icon={ChevronsRightLeft} onClick={onCollapse}>Collapse column</MenuItem>
        {onAdd && <MenuItem icon={Plus} onClick={onAdd}>Add task</MenuItem>}
      </Menu>
    </div>
  );
}

// "+ Add task" at a column's foot: a button that opens an inline capture. Enter adds and
// stays open for the next one; Esc / blur-when-empty closes. The page prefills the
// column's value (status included in the create since F1 — same path as the list's group foot).
function ColumnAdd({ col, create }) {
  const [open, setOpen] = useState(false);
  const qc = useQuickCapture();      // F2: same quick-add tokens + Owner/Deadline/Priority chips as the list
  const [saving, setSaving] = useState(false);
  const ref = useRef(null);
  useEffect(() => { if (open) ref.current?.focus(); }, [open]);
  const has = !!qc.title.trim();
  async function add() {
    if (!has || saving) return;
    const { title, extras } = qc.result();
    setSaving(true);
    try { const ok = await create(title, extras); if (ok !== false) qc.reset(); }
    finally { setSaving(false); setTimeout(() => ref.current?.focus(), 0); }
  }
  if (!open) {
    return (
      <button type="button" className="kb-add kb-add-open" onClick={() => setOpen(true)}>
        <Plus size={13} strokeWidth={2} aria-hidden />Add task
      </button>
    );
  }
  return (
    <div className="kb-capture qc-host qc-on">
      <textarea ref={ref} rows={2} value={qc.title} disabled={saving} placeholder={withHint('Task name')} aria-label={`New task in ${col.label}`}
        onChange={e => qc.setTitle(e.target.value)}
        onKeyDown={e => {
          if (isSubmitKey(e) && !e.shiftKey) { e.preventDefault(); add(); }
          if (e.key === 'Escape') { e.preventDefault(); qc.reset(); setOpen(false); }
        }}
        onBlur={(e) => { if (!qc.active && !e.currentTarget.parentElement.contains(e.relatedTarget)) setOpen(false); }} />
      <CaptureChips qc={qc} disabled={saving} />
      <div className="kb-capture-acts">
        <Button variant="ghost" size="sm" onMouseDown={keepFocus} onClick={() => { qc.reset(); setOpen(false); }}>Cancel</Button>
        <Button variant={has ? 'primary' : 'neutral'} size="sm" onMouseDown={keepFocus} onClick={add} disabled={!has} loading={saving}>Add</Button>
      </div>
    </div>
  );
}

function KanbanCard({ task, axis, ctx, dragging, onDragStart, onDragEnd, onMove, onWalk }) {
  const { openDrawer, showSpace } = ctx;
  const size = ctx.cardSize || 'm';
  const ed = !!task._can_edit;
  const collabs = (task.collaborators || []).map(c => c.full_name).filter(Boolean);
  const kids = task.child_count || 0;
  const st = STATUS_MAP[task.status];
  const showTeam = axis !== 'department' && task.department_name;
  const showProg = axis !== 'program' && task.program?.name;
  const spaceTag = <span className="kb-tag" title={`Space: ${task.space_name}`}><span className="kb-dot" style={{ background: personColor(task.space_id) }} />{task.space_name}</span>;
  const owner = task.owner_name
    ? <Avatar name={task.owner_name} size={20} title={`Owner: ${task.owner_name}`} />
    : <span className="kb-noowner" title="No owner"><UserRound size={13} strokeWidth={1.75} aria-hidden /></span>;
  function onKeyDown(e) {
    if (e.target !== e.currentTarget) return;
    // An open drawer / shell modal owns the keyboard; a move now would hit stale data.
    if (ctx.drawerOpen || ctx.shellModalOpen) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrawer(task.id); }
    else if (e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault(); if (ed) onMove(task, e.key === 'ArrowLeft' ? -1 : 1);
    }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); onWalk(task, e.key === 'ArrowLeft' ? -1 : 1, 0); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); onWalk(task, 0, e.key === 'ArrowUp' ? -1 : 1); }
  }
  return (
    <div className={'kb-card' + (dragging ? ' dragging' : '') + (ed ? '' : ' locked') + (ctx.activeId === task.id ? ' active' : '')}
      data-card-id={task.id} tabIndex={0} role="button"
      aria-label={`${task.task_no ? task.task_no + ' ' : ''}${task.title}${ed ? ' — Shift+Left/Right to move' : ''}`}
      draggable={ed} onDragStart={ed ? (e) => onDragStart(e, task) : undefined} onDragEnd={onDragEnd}
      onClick={() => openDrawer(task.id)} onKeyDown={onKeyDown}>
      <div className="kb-title">{task.title}</div>
      {size === 's' ? (
        <div className="kb-meta">{owner}<span className="kb-id">{task.task_no}</span></div>
      ) : <>
        <div className="kb-meta">
          {owner}
          {axis !== 'status' && st && <span className="kb-st" style={{ background: st.color }} title={st.label} aria-label={st.label} />}
          <DeadlineCell task={task} editable={false} />
          {task.priority && <PriorityFlag priority={task.priority} />}
          {kids > 0 && <span className="kb-m" title={`${task.child_done ?? 0} of ${kids} sub-tasks done`}><ListTree size={12} aria-hidden />{task.child_done ?? 0}/{kids}</span>}
          {task.comment_count > 0 && <span className="kb-m" title="Comments"><MessageSquare size={11} aria-hidden />{task.comment_count}</span>}
          {task.doc_count > 0 && <span className="kb-m" title="Documents"><Link2 size={11} aria-hidden />{task.doc_count}</span>}
          <span className="kb-id">{task.task_no}</span>
        </div>
        {/* Cross-space boards: which space (M and L, as before P4). */}
        {size === 'm' && showSpace && task.space_name && (
          <div className="kb-tags">{spaceTag}</div>
        )}
        {size === 'l' && (showTeam || showProg || (showSpace && task.space_name) || collabs.length > 0) && (
          <div className="kb-tags">
            {showSpace && task.space_name && spaceTag}
            {showTeam && <span className="kb-tag" title={`Team: ${task.department_name}`}><span className="kb-dot" style={{ background: personColor(task.department_id) }} />{task.department_name}</span>}
            {showProg && <span className="kb-tag" title={`Program: ${task.program.name}`}>{task.program.name}</span>}
            {collabs.length > 0 && <AvatarStack names={collabs} size={18} title={collabs.join(', ')} className="kb-collabs" />}
          </div>
        )}
      </>}
    </div>
  );
}
