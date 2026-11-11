'use client';
// One /tasks list row (ClickUp redesign P3). Memoised: every prop is either the
// task, a primitive flag, or a stable object from the page (`actions`, `opts`,
// `cols`), so a 300-row list only re-renders the rows whose task or flags changed.
//
// Layout: the row is a grid on the list's `--tl-cols` (title + visible columns).
// Left gutter (outside the grid): the select checkbox — on hover, always in Select
// mode. Title cell: [expand] status circle · title (ellipsis) · DKT id (never wraps)
// · REV / sub-task count · F7 dependency badge · hover + sub-task and ⋯ menu.
import { memo, useEffect, useRef, useState } from 'react';
import { ChevronRight, Check, X, Plus, MoreHorizontal, Link2, MessageSquare, UserPlus, Users, Building2, Tag, ExternalLink, CornerDownRight, Ban, CircleCheck, CircleDashed } from 'lucide-react';
import { Avatar, OptionList, personColor } from '../primitives.js';
import { AvatarStack, GhostCell, Menu, MenuItem, MenuSeparator, Popover, Button } from '../ui/index.js';
import { EditableSelect, StatusCircle, StatusCell, PriorityFlag, DeadlineCell, AbandonForm, PlanCell, stop, contain } from './TaskCells.js';
import { DepsBadge } from '../task/Dependencies.js';

export const ROW_SELECTOR = '.tl-row[tabindex="0"]';

function moveFocus(from, delta) {
  const rows = [...document.querySelectorAll(ROW_SELECTOR)];
  const n = rows[rows.indexOf(from) + delta];
  if (n) n.focus();
}

export const TaskRow = memo(function TaskRow({
  task, cols, isChild = false, separate = false, parent = null, hasKids = false, expanded = false,
  isSel = false, selectMode = false, showIds = true, subRequested = false, actions, opts,
}) {
  const { saveField, abandonInline, reviseInline, addSubtask, addCollab, openDrawer, toggleExpand, setExpandedOn, toggleSelect, enterSelect, copyTaskLink, focusedRowRef, clearSubRequest } = actions;
  const ed = !!task._can_edit && task.status !== 'abandoned';
  const done = task.status === 'done';
  const nested = isChild && !separate;            // indented child under an expanded parent
  const focusable = !nested;
  // A nested child opens its parent (the drawer shows sub-tasks); a sub-task listed as its
  // own row ("As separate tasks") opens itself.
  const openId = nested ? (task.parent_task_id || task.id) : task.id;
  const collabs = (task.collaborators || []).map(c => c.full_name).filter(Boolean);

  const [adding, setAdding] = useState(false);
  const [subTitle, setSubTitle] = useState('');
  const startAddSub = () => { setSubTitle(''); setAdding(true); setExpandedOn(task.id); };
  const submitSub = () => { const v = subTitle.trim(); if (!v) return; addSubtask(task, v); setSubTitle(''); setAdding(false); };
  const canAddSub = ed && !isChild;

  // + Task → New sub-task (toolbar) asks for this row's inline sub-task input.
  useEffect(() => {
    if (subRequested && canAddSub) { startAddSub(); clearSubRequest(); }
  }, [subRequested]); // eslint-disable-line react-hooks/exhaustive-deps
  // Unmounting (group collapsed, filtered out) drops this row as the + Task sub-task target.
  useEffect(() => () => { if (focusedRowRef.current === task.id) focusedRowRef.current = null; }, [task.id, focusedRowRef]);

  const menuRef = useRef(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [abandoning, setAbandoning] = useState(false);
  const [reason, setReason] = useState('');
  const collabRef = useRef(null);
  const [collabOpen, setCollabOpen] = useState(false);
  const addableCollabs = opts.empOpts.filter(o => o.value !== task.owner_employee_id && !(task.collaborators || []).some(c => c.employee_id === o.value));

  const cls = ['tl-row', nested && 'sub', done && 'done', isSel && 'selected', selectMode && 'selecting'].filter(Boolean).join(' ');

  function cell(k) {
    switch (k) {
      case 'status':
        return <StatusCell task={task} editable={ed} onSet={(s) => saveField(task, 'status', s)} onAbandon={(r) => abandonInline(task, r)} />;
      case 'team':
        return (
          <EditableSelect editable={ed} value={task.department_id || ''} options={opts.teamCellOpts} searchable empty={!task.department_name}
            ghostIcon={Building2} label="Team" onPick={(v) => saveField(task, 'department_id', v)}>
            <span className="chip tl-chip"><span className="dot" style={{ background: personColor(task.department_id) }} /><span className="lbl">{task.department_name}</span></span>
          </EditableSelect>
        );
      case 'program':
        return (
          <EditableSelect editable={ed} value={task.program_id || task.program?.id || ''} options={opts.programCellOpts} searchable empty={!task.program?.name}
            ghostIcon={Tag} label="Program" onPick={(v) => saveField(task, 'program_id', v)}>
            <span className="chip soft tl-chip"><span className="dot" style={{ background: task.program?.color || personColor(task.program?.id) }} /><span className="lbl">{task.program?.name}</span></span>
          </EditableSelect>
        );
      case 'plan':
        return <PlanCell task={task} editable={ed && !task.parent_task_id} items={opts.planItems} onPick={(v) => saveField(task, 'plan_item_id', v)} />;
      case 'space':
        return (
          <span className="chip soft tl-chip" title={task.space_name || 'General'}>
            <span className="dot" style={{ background: personColor(task.space_id) }} /><span className="lbl">{task.space_name || 'General'}</span>
          </span>
        );
      case 'owner':
        return (
          <EditableSelect editable={ed} value={task.owner_employee_id || ''} options={opts.ownerCellOpts} searchable empty={!task.owner_name} width={220}
            ghostIcon={UserPlus} label={task.owner_name ? `Owner: ${task.owner_name}` : 'Set owner'} onPick={(v) => saveField(task, 'owner_employee_id', v)}>
            <Avatar name={task.owner_name} size={22} title={task.owner_name} />
          </EditableSelect>
        );
      case 'collabs':
        return (
          <span className="tl-collabs">
            {collabs.length > 0 && <AvatarStack names={collabs} size={20} title={collabs.join(', ')} />}
            {!isChild && ed && <>
              <GhostCell ref={collabRef} icon={collabs.length ? Plus : Users} size={collabs.length ? 13 : 16} label="Add collaborator"
                className={'tl-ghost' + (collabs.length ? ' tl-ghost-sm' : '')} onClick={(e) => { stop(e); setCollabOpen(o => !o); }} />
              <Popover anchorRef={collabRef} open={collabOpen} onClose={() => setCollabOpen(false)} width={220} {...contain}>
                <OptionList options={addableCollabs} searchable onPick={(v) => { addCollab(task, v); setCollabOpen(false); }} />
              </Popover>
            </>}
          </span>
        );
      case 'priority':
        return (
          <EditableSelect editable={ed} value={task.priority} options={opts.prioOpts} width={180} label="Priority" onPick={(v) => saveField(task, 'priority', v)}>
            <PriorityFlag priority={task.priority} />
          </EditableSelect>
        );
      case 'deadline':
        return <DeadlineCell task={task} editable={ed} onFirstSet={(iso) => saveField(task, 'deadline', iso)} onRevise={reviseInline} />;
      case 'meta':
        return (
          <span className="tl-meta">
            {task.doc_count > 0 && <span className="m" title="Documents"><Link2 size={12} />{task.doc_count}</span>}
            {task.comment_count > 0 && <span className="m" title="Comments"><MessageSquare size={12} />{task.comment_count}</span>}
          </span>
        );
      default: return null;
    }
  }

  return (
    <>
      <div className={cls} tabIndex={focusable ? 0 : undefined} data-task-id={focusable ? task.id : undefined}
        onClick={() => openDrawer(openId)}
        onFocus={focusable ? (e) => { if (e.target === e.currentTarget) focusedRowRef.current = task.id; } : undefined}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter') { e.preventDefault(); openDrawer(openId); }
          else if (actions.isViewOpen?.()) return; // TaskView open (side mode): no row shortcuts
          else if ((e.key === 'x' || e.key === ' ') && ed) { e.preventDefault(); saveField(task, 'status', done ? 'not_started' : 'done'); }
          else if (e.key === 's' && canAddSub) { e.preventDefault(); startAddSub(); }
          else if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); moveFocus(e.currentTarget, 1); }
          else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); moveFocus(e.currentTarget, -1); }
          else if ((e.key === 'ArrowRight' || e.key === 'l') && hasKids && !expanded) { e.preventDefault(); toggleExpand(task.id); }
          else if ((e.key === 'ArrowLeft' || e.key === 'h') && hasKids && expanded) { e.preventDefault(); toggleExpand(task.id); }
        }}>
        {/* Left gutter: select (nested sub-tasks only in Select mode; they stay out of select-all) */}
        {(!nested || selectMode) && (ed
          ? <button type="button" className={'tl-sel' + (isSel ? ' on' : '')} aria-label={isSel ? 'Deselect task' : 'Select task'} aria-pressed={isSel}
              onClick={(e) => { stop(e); if (!selectMode) enterSelect(); toggleSelect(task.id); }}>{isSel && <Check size={11} strokeWidth={3} />}</button>
          : (selectMode && <span className="tl-sel disabled" title="You can only bulk-edit tasks you can edit" />))}

        {/* Title */}
        <span className="tl-cell tl-title">
          {nested
            ? <span className="tl-branch" aria-hidden><CornerDownRight size={12} /></span>
            : (hasKids
              ? <button type="button" className={'tl-expand' + (expanded ? ' open' : '')} aria-label={expanded ? 'Collapse sub-tasks' : 'Expand sub-tasks'} aria-expanded={expanded}
                  onClick={(e) => { stop(e); toggleExpand(task.id); }}><ChevronRight size={14} /></button>
              : <span className="tl-expand-sp" />)}
          <StatusCircle task={task} editable={ed} onToggle={() => saveField(task, 'status', done ? 'not_started' : 'done')} />
          <span className="tl-ttl" title={task.title}>{task.title}</span>
          {separate && isChild && parent && (
            <span className="tl-parent" title={`Sub-task of ${parent.task_no} · ${parent.title}`}><CornerDownRight size={11} />{parent.task_no}</span>
          )}
          {showIds && !nested && <span className="tl-id">{task.task_no}</span>}
          {hasKids && <span className="tl-kids" title="Sub-tasks done">{task.child_done ?? 0}/{task.child_count ?? 0}</span>}
          <DepsBadge task={task} getSession={actions.getSession} editable={ed} onOpen={openDrawer} onChanged={actions.depsChanged} />
          <span className="tl-row-acts">
            {canAddSub && (
              <button type="button" className="tl-act" aria-label="Add sub-task" title="Add sub-task  (s)" onClick={(e) => { stop(e); startAddSub(); }}><Plus size={13} /></button>
            )}
            <button ref={menuRef} type="button" className="tl-act" aria-label="Task actions" aria-haspopup="menu"
              onClick={(e) => { stop(e); setAbandoning(false); setMenuOpen(o => !o); }}><MoreHorizontal size={14} /></button>
          </span>
        </span>

        {/* Meta, space and the collaborator avatars open the drawer like the row; editable cells stop. */}
        {cols.map(k => <span key={k} className={'tl-cell tl-c-' + k} onClick={k === 'meta' || k === 'space' || k === 'collabs' ? undefined : stop}>{cell(k)}</span>)}
      </div>

      <Menu anchorRef={menuRef} open={menuOpen} onClose={() => setMenuOpen(false)} align="right" width={210} label="Task actions" {...contain}>
        <MenuItem icon={ExternalLink} onClick={() => openDrawer(openId)}>Open</MenuItem>
        <MenuItem icon={Link2} onClick={() => copyTaskLink(task)}>Copy link</MenuItem>
        {canAddSub && <MenuItem icon={Plus} shortcut="s" onClick={startAddSub}>Add sub-task</MenuItem>}
        {ed && <MenuItem icon={done ? CircleDashed : CircleCheck} shortcut="x" onClick={() => saveField(task, 'status', done ? 'not_started' : 'done')}>{done ? 'Mark not done' : 'Mark done'}</MenuItem>}
        {ed && <>
          <MenuSeparator />
          <MenuItem icon={Ban} danger onClick={() => { setReason(''); setAbandoning(true); }}>Abandon…</MenuItem>
        </>}
      </Menu>
      <Popover anchorRef={menuRef} open={abandoning} onClose={() => setAbandoning(false)} align="right" width={240} {...contain}>
        <AbandonForm reason={reason} setReason={setReason} onCancel={() => setAbandoning(false)}
          onSubmit={() => { if (!reason.trim()) return; abandonInline(task, reason.trim()); setAbandoning(false); }} />
      </Popover>

      {adding && (
        <div className="tl-row tl-subadd" onClick={stop}>
          <span className="tl-cell tl-title">
            <span className="tl-branch" aria-hidden><CornerDownRight size={12} /></span>
            <input autoFocus value={subTitle} onChange={e => setSubTitle(e.target.value)} placeholder="Sub-task title, Enter to add…"
              className="tl-input" aria-label="Sub-task title"
              onKeyDown={e => { if (e.key === 'Enter') submitSub(); if (e.key === 'Escape') setAdding(false); }} />
            <Button variant={subTitle.trim() ? 'primary' : 'neutral'} size="sm" icon={Check} aria-label="Add sub-task" disabled={!subTitle.trim()} onClick={submitSub} />
            <Button variant="ghost" size="sm" icon={X} aria-label="Cancel" onClick={() => setAdding(false)} />
          </span>
        </div>
      )}
    </>
  );
});

export default TaskRow;
