'use client';
/* KanbanBoard — board view for the Docket tasks page.
   Columns come from the active group-by axis (default: status). Dragging a card
   between columns sets that axis's field on the task via ctx.saveField (status →
   changeStatus, owner/team/program → updateTask) — audited, optimistic.
   Frontend-only: reuses the already-loaded task rows + the existing save paths.
   Abandoned tasks are never shown (terminal). Top-level tasks only (sub-tasks
   surface as a count badge). */
import { useState } from 'react';
import { Link2, MessageSquare, Plus } from 'lucide-react';
import { StatusBadge } from './StatusBadge.js';
import { PriorityBadge } from './PriorityBadge.js';
import { Avatar, AvatarRow, personColor, deadlineState, relDeadline } from './primitives.js';
import { SETTABLE_STATUSES, effectiveDeadline } from '../lib/tasks.js';

const NONE = '__none__';

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

export function KanbanBoard({ rows, axis, ctx }) {
  const ax = AXIS[axis] || AXIS.status;
  const columns = buildColumns(axis, rows);
  const [dragId, setDragId] = useState(null);
  const [overKey, setOverKey] = useState(null);

  const byCol = {};
  for (const c of columns) byCol[c.key] = [];
  for (const t of rows) {
    const k = ax.keyOf(t);
    (byCol[k] = byCol[k] || []).push(t);
  }

  function onDragStart(e, task) {
    setDragId(task.id);
    try { e.dataTransfer.setData('text/plain', task.id); e.dataTransfer.effectAllowed = 'move'; } catch { /* ignore */ }
  }
  function onDragEnd() { setDragId(null); setOverKey(null); }
  function onDrop(col) {
    const task = rows.find(t => t.id === dragId);
    setOverKey(null); setDragId(null);
    if (!task || !task._can_edit) return;
    if (ax.curr(task) === col.value) return; // already here
    ctx.saveField(task, ax.field, col.value);
  }

  return (
    <div className="kanban-scroll">
      <div className="kanban">
        {columns.map(col => {
          const cards = byCol[col.key] || [];
          const isOver = overKey === col.key;
          return (
            <div key={col.key} className={'kan-col' + (isOver ? ' over' : '')}
              onDragOver={(e) => { if (dragId) { e.preventDefault(); setOverKey(col.key); } }}
              onDragLeave={(e) => { if (e.currentTarget === e.target) setOverKey(k => (k === col.key ? null : k)); }}
              onDrop={(e) => { e.preventDefault(); onDrop(col); }}>
              <div className="kan-col-head">
                <span className="kan-dot" style={{ background: col.color }} />
                <span className="kan-col-label">{col.label}</span>
                <span className="kan-col-count">{cards.length}</span>
              </div>
              <div className="kan-col-body">
                {cards.map(task => (
                  <KanbanCard key={task.id} task={task} axis={axis} ctx={ctx}
                    dragging={dragId === task.id} onDragStart={onDragStart} onDragEnd={onDragEnd} />
                ))}
                {cards.length === 0 && <div className="kan-empty">{isOver ? 'Drop here' : '—'}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function KanbanCard({ task, axis, ctx, dragging, onDragStart, onDragEnd }) {
  const { openDrawer, showSpace } = ctx;
  const ed = !!task._can_edit;
  const eff = effectiveDeadline(task);
  const dl = deadlineState(task);
  const collabs = (task.collaborators || []).map(c => c.full_name).filter(Boolean);
  const kids = task.child_count || 0;
  const showTeam = axis !== 'department' && task.department_name;
  const showProg = axis !== 'program' && task.program?.name;
  return (
    <div className={'kan-card' + (dragging ? ' dragging' : '') + (ed ? '' : ' locked')}
      draggable={ed} onDragStart={ed ? (e) => onDragStart(e, task) : undefined} onDragEnd={onDragEnd}
      onClick={() => openDrawer(task.id)} title={ed ? 'Drag to move · click to open' : 'Click to open'}>
      <div className="kan-card-top">
        <span className="kan-id">{task.task_no}</span>
        {axis !== 'status' && <StatusBadge status={task.status} />}
        <span style={{ marginLeft: 'auto' }}><PriorityBadge priority={task.priority} /></span>
      </div>
      <div className="kan-card-title">{task.title}</div>
      {(showTeam || showProg || (showSpace && task.space_name)) && (
        <div className="kan-card-tags">
          {showSpace && task.space_name && (
            <span className="chip soft" title={task.space_name}><span className="dot" style={{ background: personColor(task.space_id) }} /><span className="lbl">{task.space_name}</span></span>
          )}
          {showTeam && (
            <span className="chip" title={task.department_name}><span className="dot" style={{ background: personColor(task.department_id) }} /><span className="lbl">{task.department_name}</span></span>
          )}
          {showProg && (
            <span className="chip soft" title={task.program.name}><span className="lbl">{task.program.name}</span></span>
          )}
        </div>
      )}
      <div className="kan-card-foot">
        {task.owner_name ? <Avatar name={task.owner_name} size={20} title={task.owner_name} /> : <span className="kan-noowner">Unassigned</span>}
        {collabs.length > 0 && <AvatarRow names={collabs} size={18} />}
        <span className="kan-foot-right">
          {eff && <span className={'deadline ' + dl} style={{ cursor: 'default' }}>{relDeadline(eff)}</span>}
          {task.revised_deadline && <span className="rev-flag">rev</span>}
          {kids > 0 && <span className="kan-m" title="sub-tasks">{task.child_done ?? 0}/{kids}</span>}
          {task.doc_count > 0 && <span className="kan-m" title="documents"><Link2 size={11} />{task.doc_count}</span>}
          {task.comment_count > 0 && <span className="kan-m" title="comments"><MessageSquare size={11} />{task.comment_count}</span>}
        </span>
      </div>
    </div>
  );
}
