'use client';
// TaskView left pane, part 1: the 2-column property grid (icon + muted label → value or
// a muted "Empty"; values wrap, never truncate). Every picker is a ui Popover opened by
// `edit` (owned by TaskView so Shift+S / A / D / P can open one). The writes are the
// TaskView actions — the same docketops calls + payloads the old drawer made.
import { useEffect, useState } from 'react';
import { Combobox } from '@throttle/ui';
import { CircleDot, User, Users, Calendar, Flag, Network, Layers, Hash, Clock, CheckCheck, Repeat, Plus, X, Check, Ban, Target } from 'lucide-react';
import { PlanPicker, PlanChip } from '../plan/PlanPicker.js';
import { StatusBadge } from '../StatusBadge.js';
import { DatePicker } from '../DatePicker.js';
import { Avatar, OptionList, personColor, relDeadline, deadlineState, firstName } from '../primitives.js';
import { Popover, Button } from '../ui/index.js';
import { PriorityFlag, AbandonForm, contain } from '../tasks/TaskCells.js';
import { SETTABLE_STATUSES, effectiveDeadline } from '../../lib/tasks.js';
import { fmtDateTime } from '../../lib/format.js';
import { recurrenceSummary } from '../../lib/recurrence.js';

function Prop({ icon: Ic, label, children }) {
  return (
    <div className="tv-prop">
      <span className="tv-k"><Ic size={14} strokeWidth={1.75} aria-hidden />{label}</span>
      <div className="tv-v">{children}</div>
    </div>
  );
}
const Empty = ({ children = 'Empty' }) => <span className="tv-empty">{children}</span>;

// A value that opens its picker when editable; static text otherwise.
function Trigger({ field, refs, edit, setEdit, canEdit, label, children }) {
  if (!canEdit) return <span className="tv-static">{children}</span>;
  return (
    <button ref={refs[field]} type="button" className={'tv-trigger' + (edit === field ? ' on' : '')} aria-label={label}
      aria-haspopup="dialog" aria-expanded={edit === field} onClick={() => setEdit(edit === field ? null : field)}>
      {children}
    </button>
  );
}

export function TaskProps({ task, canEdit, busy, edit, setEdit, refs, abandonMode, setAbandonMode, actions, opts, revisions }) {
  const close = () => { setEdit(null); setAbandonMode(false); };
  const [abandonReason, setAbandonReason] = useState('');
  const [ddDraft, setDdDraft] = useState(null);
  const [reviseReason, setReviseReason] = useState('');
  const dl = effectiveDeadline(task);
  const dstate = deadlineState(task);
  // Opening the deadline picker (click or Shift+D) starts from the current deadline.
  useEffect(() => { if (edit === 'deadline') { setDdDraft(dl); setReviseReason(''); } }, [edit]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (abandonMode) setAbandonReason(''); }, [abandonMode]);

  const pop = (field, width, body) => (
    <Popover anchorRef={refs[field]} open={edit === field} onClose={close} width={width} className="tv-pop" {...contain}>{body}</Popover>
  );
  const collabs = task.collaborators || [];

  return (
    <div className="tv-props">
      <Prop icon={CircleDot} label="Status">
        <Trigger field="status" label="Status" {...{ refs, edit, setEdit, canEdit }}><StatusBadge status={task.status} /></Trigger>
        {canEdit && pop('status', abandonMode ? 260 : 200, !abandonMode ? <>
          {SETTABLE_STATUSES.map(s => (
            <button key={s.key} type="button" className={'menu-item' + (task.status === s.key ? ' active' : '')} disabled={busy}
              onClick={() => { actions.setStatus(s.key); close(); }}>
              <span className="si" style={{ background: s.color }} />{s.label}
              {task.status === s.key && <span className="ck"><Check size={14} /></span>}
            </button>
          ))}
          <div className="tl-pop-sep" />
          <button type="button" className="menu-item" style={{ color: 'var(--st-abandon)' }} onClick={() => setAbandonMode(true)}>
            <Ban size={14} /> Abandon…
          </button>
        </> : (
          <AbandonForm reason={abandonReason} setReason={setAbandonReason} onCancel={() => setAbandonMode(false)}
            onSubmit={async () => { if (!abandonReason.trim()) return; const ok = await actions.doAbandon(abandonReason.trim()); if (ok) close(); }} />
        ))}
      </Prop>

      <Prop icon={User} label="Owner">
        <Trigger field="owner" label="Owner" {...{ refs, edit, setEdit, canEdit }}>
          {task.owner_name ? <span className="tv-person"><Avatar name={task.owner_name} size={20} />{task.owner_name}</span> : <Empty />}
        </Trigger>
        {canEdit && pop('owner', 240, <OptionList options={opts.ownerOpts} value={task.owner_employee_id || ''} searchable
          onPick={(v) => { actions.saveField('owner_employee_id', v); close(); }} />)}
      </Prop>

      <Prop icon={Users} label="Collaborators">
        <div className="tv-collabs">
          {collabs.length === 0 && !canEdit && <Empty />}
          {collabs.map(c => (
            <span key={c.employee_id} className="tv-chip" title={c.full_name || ''}>
              <Avatar name={c.full_name || '?'} size={18} />{firstName(c.full_name) || c.employee_id}
              {canEdit && <button type="button" className="tv-chip-x" aria-label={`Remove ${c.full_name || 'collaborator'}`}
                onClick={() => actions.removeCollab(c.employee_id)}><X size={12} /></button>}
            </span>
          ))}
          {canEdit && <>
            <button ref={refs.collab} type="button" className="tv-add" aria-label="Add collaborator" aria-haspopup="dialog"
              onClick={() => setEdit(edit === 'collab' ? null : 'collab')}>
              <Plus size={13} />{collabs.length === 0 && <span>Add</span>}
            </button>
            {pop('collab', 240, <OptionList options={opts.collabOpts} value="" searchable
              onPick={(v) => { actions.addCollab(v); close(); }} />)}
          </>}
        </div>
      </Prop>

      {task.is_recurring ? (
        <Prop icon={Repeat} label="Repeats">
          <span className="tv-static">{recurrenceSummary(task.recurrence)} <span className="rev-flag">checklist</span></span>
        </Prop>
      ) : (
        <Prop icon={Calendar} label="Deadline">
          <Trigger field="deadline" label="Deadline" {...{ refs, edit, setEdit, canEdit }}>
            {dl ? (
              <span className={'tv-dl ' + (dstate || '')}>
                {fmtDateTime(dl)}{task.status === 'done' || task.status === 'abandoned' ? '' : ` · ${relDeadline(dl)}`}
                {task.revised_deadline && <span className="tl-rev" title="Deadline revised">REV{revisions > 1 ? ` ×${revisions}` : ''}</span>}
              </span>
            ) : <Empty />}
          </Trigger>
          {task.revised_deadline && task.deadline && (
            <div className="tv-sub">Original {fmtDateTime(task.deadline)} · locked{revisions ? ` · revised ${revisions}×` : ''}</div>
          )}
          {canEdit && pop('deadline', undefined, (
            <div className="tv-dd">
              <DatePicker value={ddDraft} onChange={setDdDraft} autoFocus />
              {task.deadline && <input className="reason-input" placeholder="Reason (required, logged)" value={reviseReason} onChange={e => setReviseReason(e.target.value)} />}
              <div className="tl-pop-actions">
                <Button variant="ghost" size="sm" onClick={close}>Cancel</Button>
                <Button variant="primary" size="sm" icon={Check} disabled={busy || !ddDraft || (!!task.deadline && !reviseReason.trim())}
                  onClick={async () => { const ok = await actions.commitDeadline(ddDraft, reviseReason); if (ok) close(); }}>
                  {task.deadline ? 'Revise' : 'Set'}
                </Button>
              </div>
            </div>
          ))}
        </Prop>
      )}

      <Prop icon={Flag} label="Priority">
        <Trigger field="priority" label="Priority" {...{ refs, edit, setEdit, canEdit }}>
          {task.priority ? <PriorityFlag priority={task.priority} /> : <Empty />}
        </Trigger>
        {canEdit && pop('priority', 190, <OptionList options={opts.prioOpts} value={task.priority}
          onPick={(v) => { actions.saveField('priority', v); close(); }} />)}
      </Prop>

      <Prop icon={Network} label="Team">
        <Trigger field="team" label="Team" {...{ refs, edit, setEdit, canEdit }}>
          {task.department_name ? <span className="tv-person"><span className="tv-dot" style={{ background: personColor(task.department_id) }} />{task.department_name}</span> : <Empty />}
        </Trigger>
        {canEdit && pop('team', 230, <OptionList options={opts.teamOpts} value={task.department_id || ''} searchable
          onPick={(v) => { actions.saveField('department_id', v); close(); }} />)}
      </Prop>

      <Prop icon={Layers} label="Program">
        <Trigger field="program" label="Program" {...{ refs, edit, setEdit, canEdit }}>
          {task.program ? <span className="tv-person">{task.program.name}</span> : <Empty />}
        </Trigger>
        {canEdit && pop('program', 260, (
          <div style={{ padding: 6 }}>
            <Combobox value={task.program_id || ''} options={opts.programCellOpts} placeholder="Pick or type to create…" allowClear={false} style={{ width: '100%' }}
              onChange={(v, opt) => { if (!opt) return; actions.saveField('program_id', opt.value || null); close(); }}
              onCreateOption={(text) => { actions.createProgramInline(text); close(); }} />
          </div>
        ))}
      </Prop>

      {/* F9 R2: the plan link. A sub-task shows its parent's (muted, read-only) — set it on the parent. */}
      <Prop icon={Target} label="Plan">
        {task.parent_task_id ? (
          task.plan ? <span className="tv-static"><PlanChip plan={task.plan} /> <span className="tv-sub-inline">from the parent task</span></span> : <Empty>Follows the parent task</Empty>
        ) : <>
          <Trigger field="plan" label="Plan" {...{ refs, edit, setEdit, canEdit }}>
            {task.plan ? <PlanChip plan={task.plan} /> : <Empty>Unplanned</Empty>}
          </Trigger>
          {canEdit && pop('plan', 320, <PlanPicker items={opts.planItems || []} value={task.plan_item_id || ''}
            onPick={(v) => { actions.saveField('plan_item_id', v); close(); }} />)}
        </>}
      </Prop>

      <Prop icon={Hash} label="Space">
        <Trigger field="space" label="Space" {...{ refs, edit, setEdit, canEdit }}>
          <span className="tv-person">{task.space?.name || 'General'}</span>
        </Trigger>
        {canEdit && pop('space', 240, <OptionList options={opts.spaceOpts} value={task.space_id || ''} searchable
          onPick={(v) => { actions.moveToSpace(v); close(); }} />)}
      </Prop>

      <Prop icon={Clock} label="Created">
        <span className="tv-static">{fmtDateTime(task.created_at)}{task.creator_name ? ` · ${task.creator_name}` : ''}</span>
      </Prop>
      {task.completed_at && (
        <Prop icon={CheckCheck} label="Completed"><span className="tv-static">{fmtDateTime(task.completed_at)}</span></Prop>
      )}
    </div>
  );
}
