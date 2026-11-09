'use client';
// /tasks List view (ClickUp redesign P3): The Grid (triage) as a dashed-yellow group
// on top → the column header (sort · drag to reorder · drag the edge to resize) →
// the groups (header · rows · foot capture) → the Archived section.
// Pure rendering: the page owns data, writes and view state.
import { Fragment, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Check, Plus, Archive, Inbox, ArrowUp, ArrowDown } from 'lucide-react';
import { Avatar, OptionList, AnchoredPopover, firstName, fmtShortDate } from '../primitives.js';
import { Popover, Button } from '../ui/index.js';
import { DatePicker } from '../DatePicker.js';
import { PriorityFlag, contain } from './TaskCells.js';
import { TaskRow } from './TaskRow.js';
import { GroupHeader, FootCapture } from './GroupHeader.js';
import { COLUMNS, gridTemplate, gridMinWidth } from './useTaskViewState.js';

export function TaskListView({
  gridRows = [], groups = [], archivedRows = [], childrenByParent, expanded, sortFn, selected, selectMode,
  showIds, separate, flat = false, parentById, visibleCols, cols, moveColumn, resizeColumn, sortKey, sortDir, onSort,
  collapsed, toggleGroupCollapsed, setGroupsCollapsed, actions, opts, subRequest, gridCtx, loading, children,
}) {
  // Live column width while dragging a resize handle (persisted on mouse-up).
  const [live, setLive] = useState(null);
  const [template, minW] = useMemo(() => {
    const c = live ? { ...cols, widths: { ...cols.widths, [live.k]: live.w } } : cols;
    return [gridTemplate(visibleCols, c), gridMinWidth(visibleCols, c)];
  }, [visibleCols, cols, live]);

  const groupKeys = groups.map(g => g.key);
  const many = groups.length > 1;

  return (
    <div className="tl" style={{ opacity: loading ? 0.5 : 1, pointerEvents: loading ? 'none' : 'auto' }}>
      {gridRows.length > 0 && (
        <GridGroup rows={gridRows} ctx={gridCtx} collapsed={!!collapsed.grid} onToggle={() => toggleGroupCollapsed('grid')} />
      )}

      <div className="tl-scroll">
        <div className="tl-list" style={{ '--tl-cols': template, '--tl-minw': `${minW}px` }}>
          <ColumnHeader keys={visibleCols} cols={cols} sortKey={sortKey} sortDir={sortDir} onSort={onSort}
            moveColumn={moveColumn} onLive={setLive} onResize={(k, w) => { setLive(null); resizeColumn(k, w); }} />
          {groups.map(g => {
            const isCollapsed = !!collapsed[g.key];
            return (
              <section key={g.key} className="tl-group" data-group={g.key}>
                {g.label != null && (
                  <GroupHeader group={g} collapsed={isCollapsed} variant={g.variant}
                    onToggle={() => toggleGroupCollapsed(g.key)}
                    onAdd={g.capture ? () => {
                      toggleGroupCollapsed(g.key, false);
                      setTimeout(() => document.querySelector(`[data-group-foot="${CSS.escape(g.key)}"] input`)?.focus(), 0);
                    } : undefined}
                    onCollapseAll={many ? () => setGroupsCollapsed(groupKeys, true) : undefined}
                    onExpandAll={many ? () => setGroupsCollapsed(groupKeys, false) : undefined} />
                )}
                {!isCollapsed && <>
                  <div className="tl-rows" role="list">
                    {g.rows.map(task => {
                      // `flat` (My tasks): every row is its own task — no nesting, no expand.
                      const nest = !separate && !flat;
                      const kids = nest ? (childrenByParent[task.id] || []) : [];
                      const hasKids = nest && ((task.child_count || 0) > 0 || kids.length > 0);
                      const isOpen = hasKids && !!expanded[task.id];
                      const isChild = !flat && !!task.parent_task_id;
                      return (
                        <Fragment key={task.id}>
                          <TaskRow task={task} cols={visibleCols} isChild={isChild} separate={separate}
                            parent={isChild ? parentById[task.parent_task_id] || null : null}
                            hasKids={hasKids} expanded={isOpen} isSel={selected.has(task.id)} selectMode={selectMode}
                            showIds={showIds} subRequested={subRequest === task.id} actions={actions} opts={opts} />
                          {isOpen && kids.slice().sort(sortFn).map(c => (
                            <TaskRow key={c.id} task={c} cols={visibleCols} isChild isSel={selected.has(c.id)} selectMode={selectMode}
                              showIds={showIds} actions={actions} opts={opts} />
                          ))}
                        </Fragment>
                      );
                    })}
                    {g.rows.length === 0 && g.empty && <div className="tl-gempty">{g.empty}</div>}
                  </div>
                  {g.capture && (
                    <FootCapture groupKey={g.key} create={g.capture} placeholder={g.capturePlaceholder || 'Add task'}>
                      {g.captureExtra}
                    </FootCapture>
                  )}
                </>}
              </section>
            );
          })}
        </div>
      </div>

      {children}
      <ArchivedZone rows={archivedRows} ctx={gridCtx} collapsed={!collapsed.archivedOpen}
        onToggle={() => toggleGroupCollapsed('archivedOpen')} />
    </div>
  );
}

/* ---------------- Column header: sort · reorder (drag) · resize (edge) ---------------- */
function ColumnHeader({ keys, cols, sortKey, sortDir, onSort, moveColumn, onLive, onResize }) {
  const [dragKey, setDragKey] = useState(null);
  const [overKey, setOverKey] = useState(null);
  const arrow = (k) => (sortKey === k ? (sortDir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />) : null);

  function startResize(e, k) {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX;
    const startW = cols.widths[k] || COLUMNS[k].width;
    const min = COLUMNS[k].min || 48;
    let w = startW;
    function move(ev) { w = Math.max(min, Math.min(400, startW + ev.clientX - startX)); onLive({ k, w }); }
    function up() { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); document.body.classList.remove('tl-resizing'); onResize(k, w); }
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    document.body.classList.add('tl-resizing');
  }

  return (
    <div className="tl-head" role="row">
      <span className="tl-hcell tl-h-title">
        <button type="button" className={'tl-hbtn' + (sortKey === 'title' ? ' sorted' : '')} onClick={() => onSort('title')}>Name{arrow('title')}</button>
      </span>
      {keys.map(k => {
        const def = COLUMNS[k];
        return (
          <span key={k} className={'tl-hcell' + (overKey === k && dragKey !== k ? ' drop' : '') + (dragKey === k ? ' dragging' : '')}
            draggable onDragStart={(e) => { setDragKey(k); try { e.dataTransfer.setData('text/plain', k); e.dataTransfer.effectAllowed = 'move'; } catch { /* ignore */ } }}
            onDragOver={(e) => { if (dragKey) { e.preventDefault(); setOverKey(k); } }}
            onDragLeave={() => setOverKey(o => (o === k ? null : o))}
            onDrop={(e) => { e.preventDefault(); if (dragKey) moveColumn(dragKey, k); setDragKey(null); setOverKey(null); }}
            onDragEnd={() => { setDragKey(null); setOverKey(null); }}
            title="Drag to reorder">
            {def.sort
              ? <button type="button" className={'tl-hbtn' + (sortKey === def.sort ? ' sorted' : '')} onClick={() => onSort(def.sort)}>{def.label}{arrow(def.sort)}</button>
              : <span className="tl-hlbl">{def.label}</span>}
            <span className="tl-resize" role="separator" aria-orientation="vertical" aria-label={`Resize ${def.label}`}
              onMouseDown={(e) => startResize(e, k)} draggable={false} onDragStart={(e) => e.preventDefault()} />
          </span>
        );
      })}
    </div>
  );
}

/* ---------------- The Grid (triage) — a collapsible group with a dashed-yellow header ---------------- */
function GridGroup({ rows, ctx, collapsed, onToggle }) {
  return (
    <section className={'tl-grid' + (collapsed ? ' collapsed' : '')} data-group="grid">
      <button type="button" className="tl-grid-head" aria-expanded={!collapsed} onClick={onToggle}>
        <ChevronDown className="tl-caret" size={14} strokeWidth={2} aria-hidden />
        <Inbox size={14} aria-hidden className="tl-grid-ic" />
        <span className="tl-grid-ttl">The Grid</span>
        <span className="tl-gcount">{rows.length}</span>
        <span className="tl-ghint">needs an owner and a deadline to hit the board</span>
      </button>
      {!collapsed && (
        <div className="tl-grid-body">
          {rows.map(task => <GridCard key={task.id} task={task} ctx={ctx} />)}
        </div>
      )}
    </section>
  );
}

function GridCard({ task, ctx }) {
  const { saveField, openDrawer, ownerCellOpts, selectMode, selected, toggleSelect, enterSelect } = ctx;
  const ed = !!task._can_edit && task.status !== 'abandoned';
  const done = task.status === 'done';
  const isSel = !!selected?.has(task.id);
  return (
    <div className={'gcard' + (isSel ? ' selected' : '') + (selectMode ? ' selecting' : '')} data-nav-id={task.id}>
      {ed
        ? <button type="button" className={'tl-sel' + (isSel ? ' on' : '')} aria-label={isSel ? 'Deselect task' : 'Select task'} aria-pressed={isSel}
            onClick={() => { if (!selectMode) enterSelect(); toggleSelect(task.id); }}>{isSel && <Check size={11} strokeWidth={3} />}</button>
        : (selectMode && <span className="tl-sel disabled" title="You can only bulk-edit tasks you can edit" />)}
      <button type="button" className={'tl-circle' + (done ? ' done' : '')} disabled={!ed} aria-label={done ? 'Mark not done' : 'Mark done'}
        style={{ '--st': 'var(--st-todo)' }} onClick={() => saveField(task, 'status', done ? 'not_started' : 'done')}>{done && <Check size={10} strokeWidth={3} />}</button>
      <button type="button" className="gtitle" onClick={() => openDrawer(task.id)}>
        <span className="t">{task.title}</span>
        <span className="id">{task.task_no}</span>
      </button>
      <PriorityFlag priority={task.priority} />
      <span className="gsetup">
        <NeedChip task={task} kind="owner" ed={ed} ownerOpts={ownerCellOpts} saveField={saveField} />
        <NeedChip task={task} kind="deadline" ed={ed} saveField={saveField} />
      </span>
    </div>
  );
}

function NeedChip({ task, kind, ed, ownerOpts, saveField }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(null);
  const ref = useRef(null);
  const set = kind === 'owner' ? !!task.owner_employee_id : !!task.deadline;
  const label = kind === 'owner'
    ? (set ? firstName(task.owner_name) : 'Owner')
    : (set ? fmtShortDate(task.deadline) : 'Deadline');
  return (
    <span ref={ref} style={{ display: 'inline-flex' }}>
      <button type="button" className={'need-chip' + (set ? ' set' : '')} disabled={!ed} onClick={() => ed && setOpen(o => !o)}>
        {set ? <Check size={13} /> : <Plus size={13} />}{label}
      </button>
      {kind === 'owner' && (
        <Popover anchorRef={ref} open={open} onClose={() => setOpen(false)} width={210} {...contain}>
          <OptionList options={ownerOpts} value={task.owner_employee_id || ''} searchable onPick={(v) => { saveField(task, 'owner_employee_id', v); setOpen(false); }} />
        </Popover>
      )}
      {kind === 'deadline' && (
        <AnchoredPopover anchorRef={ref} open={open} onClose={() => setOpen(false)}>
          <div {...contain}>
            <DatePicker value={draft} onChange={setDraft} autoFocus />
            <div className="tl-pop-actions">
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
              <Button variant="primary" size="sm" icon={Check} disabled={!draft} onClick={() => { saveField(task, 'deadline', draft); setOpen(false); }}>Set</Button>
            </div>
          </div>
        </AnchoredPopover>
      )}
    </span>
  );
}

/* ---------------- Archived (collapsed bottom section; done tasks when "Archive done" is on) ---------------- */
function ArchivedZone({ rows, ctx, collapsed, onToggle }) {
  if (!rows.length) return null;
  return (
    <div className={'archived-zone' + (collapsed ? '' : ' open')}>
      <button type="button" className="archived-head" aria-expanded={!collapsed} onClick={onToggle}>
        <span className="chev"><ChevronRight size={15} /></span>
        <Archive size={14} />
        <span className="ttl">Archived</span>
        <span className="cnt">{rows.length}</span>
      </button>
      {!collapsed && (
        <div className="archived-body">
          {rows.map(t => <ArchivedRow key={t.id} task={t} ctx={ctx} />)}
        </div>
      )}
    </div>
  );
}

function ArchivedRow({ task, ctx }) {
  const { openDrawer, saveField } = ctx;
  const ed = !!task._can_edit;
  return (
    <div className="archived-row" data-nav-id={task.id}>
      <button type="button" className="ar-check" disabled={!ed} title={ed ? 'Mark not done (return to the board)' : undefined}
        onClick={() => ed && saveField(task, 'status', 'not_started')}><Check size={11} /></button>
      <button type="button" className="ar-id" onClick={() => openDrawer(task.id)}>{task.task_no}</button>
      <button type="button" className="ar-ttl" onClick={() => openDrawer(task.id)}>{task.title}</button>
      {task.owner_name && <Avatar name={task.owner_name} size={18} title={task.owner_name} />}
    </div>
  );
}

export default TaskListView;
