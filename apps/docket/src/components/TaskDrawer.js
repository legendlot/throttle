'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Spinner, useToast, Combobox } from '@throttle/ui';
import { X, Maximize2, Plus, Check, Users, Layers, Hash, User, Flag, Calendar, Clock, Repeat } from 'lucide-react';
import { docketopsGet, docketopsPost } from '../lib/docketopsFetch.js';
import { useHotkey } from '../lib/hotkeys.js';
import { StatusBadge } from './StatusBadge.js';
import { PriorityBadge } from './PriorityBadge.js';
import { CommentsPanel } from './CommentsPanel.js';
import { HistoryPanel } from './HistoryPanel.js';
import { SubtaskPanel } from './SubtaskPanel.js';
import { DocLinksPanel } from './DocLinksPanel.js';
import { DatePicker } from './DatePicker.js';
import { Avatar, Popover, AnchoredPopover, OptionList, firstName, personColor, relDeadline, deadlineState } from './primitives.js';
import { SETTABLE_STATUSES, STATUS_MAP, PRIORITIES, effectiveDeadline } from '../lib/tasks.js';
import { fmtDateTime } from '../lib/format.js';
import { recurrenceSummary } from '../lib/recurrence.js';

// Notion-style slide-over "peek" for a task. Restyled to the redesign; the data
// layer (docketops reads/writes, wired panels) is unchanged. "Open full page"
// routes to /tasks/detail for the expanded view.
export function TaskDrawer({ id, session, departments = [], employees = [], onClose, onMutated }) {
  const { showToast } = useToast();
  const router = useRouter();
  const [task, setTask] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('comments');
  const [titleDraft, setTitleDraft] = useState('');
  const [descDraft, setDescDraft] = useState('');
  const [edit, setEdit] = useState(null);          // which property popover is open
  const [ddOpen, setDdOpen] = useState(false);
  const [ddDraft, setDdDraft] = useState(null);
  const [reviseReason, setReviseReason] = useState('');
  const [abandonReason, setAbandonReason] = useState('');
  const [abandoning, setAbandoning] = useState(false);
  const [collabPick, setCollabPick] = useState('');
  const [programs, setPrograms] = useState([]);
  const [spaces, setSpaces] = useState([]);

  useEffect(() => {
    if (!session) return;
    docketopsGet('getPrograms', {}, session).then(p => setPrograms(p || [])).catch(() => {});
    docketopsGet('getSpaces', {}, session).then(s => setSpaces(s || [])).catch(() => {});
  }, [session]);

  const load = useCallback(async (silent) => {
    if (!session || !id) return;
    try {
      const t = await docketopsGet('getTask', { id }, session);
      setTask(t); setTitleDraft(t.title || ''); setDescDraft(t.description || '');
    } catch (e) { showToast(e.message || 'Failed to load task', 'error'); }
    finally { if (!silent) setLoading(false); }
  }, [session, id, showToast]);
  useEffect(() => { setLoading(true); load(); }, [load]);

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') { if (ddOpen) setDdOpen(false); else if (edit) setEdit(null); else if (abandoning) setAbandoning(false); else onClose?.(); } }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, ddOpen, edit, abandoning]);

  const ddRef = useRef(null); // anchor for the deadline calendar (AnchoredPopover handles outside-click)

  const canEdit = !!task?._can_edit && task?.status !== 'abandoned';
  const canAddSub = canEdit && task && !task.parent_task_id;
  useHotkey('s', () => {
    if (!canAddSub) return;
    const el = document.querySelector('[data-subtask-add]');
    if (el) { el.focus(); el.scrollIntoView({ block: 'nearest' }); }
  }, { enabled: !!task && !ddOpen && !abandoning && !edit });

  const mutated = useCallback(async () => { await load(true); onMutated?.(); }, [load, onMutated]);

  async function saveField(field, value) {
    setBusy(true);
    try { await docketopsPost('updateTask', { id: task.id, [field]: value || null }, session); await mutated(); }
    catch (e) { showToast(e.message || 'Save failed', 'error'); load(true); }
    finally { setBusy(false); }
  }
  async function setStatus(status) {
    setBusy(true);
    try { await docketopsPost('changeStatus', { id: task.id, status }, session); if (status === 'done') showToast('Marked done', 'success'); await mutated(); }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }
  async function commitDeadline() {
    if (!ddDraft) return;
    setBusy(true);
    try {
      if (!task.deadline) {
        await docketopsPost('updateTask', { id: task.id, deadline: ddDraft }, session);
      } else {
        if (!reviseReason.trim()) { showToast('A reason is required to revise', 'error'); setBusy(false); return; }
        await docketopsPost('reviseDeadline', { id: task.id, new_deadline: ddDraft, reason: reviseReason.trim() }, session);
      }
      setDdOpen(false); setReviseReason(''); await mutated();
    } catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }
  async function doAbandon() {
    if (!abandonReason.trim()) return;
    setBusy(true);
    try { await docketopsPost('abandonTask', { id: task.id, reason: abandonReason.trim() }, session); setAbandoning(false); setAbandonReason(''); await mutated(); }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }
  async function addCollab() {
    if (!collabPick) return;
    setBusy(true);
    try { await docketopsPost('addCollaborator', { id: task.id, employee_id: collabPick }, session); setCollabPick(''); await mutated(); }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }
  async function removeCollab(employeeId) {
    try { await docketopsPost('removeCollaborator', { id: task.id, employee_id: employeeId }, session); await mutated(); }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
  }
  async function createProgramInline(name) {
    setBusy(true);
    try {
      const prog = await docketopsPost('createProgram', { name }, session);
      setPrograms(ps => ps.some(p => p.id === prog.id) ? ps : [...ps, prog].sort((a, b) => a.name.localeCompare(b.name)));
      await docketopsPost('updateTask', { id: task.id, program_id: prog.id }, session); await mutated();
    } catch (e) { showToast(e.message || 'Failed to add program', 'error'); }
    finally { setBusy(false); }
  }
  async function moveToSpace(v) {
    if (!v || v === task.space_id) return;
    setBusy(true);
    try { await docketopsPost('moveTask', { id: task.id, space_id: v }, session); await mutated(); showToast('Moved', 'success'); }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }

  const teamOpts = [{ value: '', label: '— No team —' }, ...departments.map(d => ({ value: d.id, label: d.name, dot: personColor(d.id) }))];
  const ownerOpts = [{ value: '', label: '— Unassigned —' }, ...employees.map(e => ({ value: e.id, label: e.full_name }))];
  const prioOpts = PRIORITIES.map(p => ({ value: p.key, label: p.label }));
  const programCellOpts = [{ value: '', label: '— No program —' }, ...programs.map(p => ({ value: p.id, label: p.name }))];
  const spaceOpts = spaces.map(s => ({ value: s.id, label: s.name + (s.is_private ? '' : ' · open') }));
  const collabOpts = task ? employees.filter(e => !(task.collaborators || []).some(c => c.employee_id === e.id) && e.id !== task.owner_employee_id).map(e => ({ value: e.id, label: e.full_name })) : [];

  const dl = task && effectiveDeadline(task);
  const dstate = task && deadlineState(task);

  const Prop = ({ icon: Ic, label, children }) => (
    <div className="dr-prop">
      <span className="k"><Ic size={14} /> {label}</span>
      <span className="v">{children}</span>
    </div>
  );
  const EditTrigger = ({ field, children, empty, width = 220, render }) => (
    <span style={{ position: 'relative', display: 'inline-flex', maxWidth: '100%' }}>
      <span className={'editable' + (empty ? ' empty' : '')} onClick={() => canEdit && setEdit(edit === field ? null : field)} style={{ cursor: canEdit ? 'pointer' : 'default' }}>
        <span className="tx">{children}</span>
      </span>
      {canEdit && <Popover open={edit === field} onClose={() => setEdit(null)} width={width}>{render}</Popover>}
    </span>
  );

  return (
    <div className="backdrop" onMouseDown={onClose}>
      <aside className="drawer" onMouseDown={e => e.stopPropagation()}>
        {loading || !task ? <div style={{ padding: 40 }}><Spinner /></div> : (
          <>
            <div className="dr-top">
              <div className="left">
                <span className="id">{task.task_no}</span>
                <StatusBadge status={task.status} />
                <PriorityBadge priority={task.priority} />
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="dr-icon" title="Open full page" onClick={() => router.push(`/tasks/detail/?id=${task.id}`)}><Maximize2 size={16} /></button>
                <button className="dr-icon" title="Close (Esc)" onClick={onClose}><X size={16} /></button>
              </div>
            </div>

            <div className="dr-body">
              {canEdit ? (
                <textarea className="dr-title" value={titleDraft} rows={1}
                  onChange={e => { setTitleDraft(e.target.value); e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'; }}
                  onBlur={() => { const v = titleDraft.trim(); if (v && v !== task.title) saveField('title', v); }} />
              ) : <div className="dr-title">{task.title}</div>}

              {canEdit && (
                <div className="dr-statusrow">
                  {SETTABLE_STATUSES.map(s => {
                    const on = task.status === s.key;
                    return (
                      <button key={s.key} className={'st-btn' + (on ? ' on' : '')} onClick={() => setStatus(s.key)} disabled={busy}
                        style={on ? { background: s.bg, borderColor: s.color, color: s.color } : {}}>
                        <span className="si" style={{ background: s.color }} />{s.label}
                      </button>
                    );
                  })}
                  <button className="st-btn" style={{ color: 'var(--st-abandon)', borderColor: 'var(--st-abandon)' }} onClick={() => { setAbandoning(true); setAbandonReason(''); }}>Abandon</button>
                </div>
              )}
              {abandoning && (
                <div style={{ marginTop: 8 }}>
                  <input className="reason-input" autoFocus value={abandonReason} onChange={e => setAbandonReason(e.target.value)} placeholder="Reason for abandoning (required, logged)"
                    onKeyDown={e => { if (e.key === 'Enter' && abandonReason.trim()) doAbandon(); }} />
                  <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 8 }}>
                    <button className="btn btn-ghost" onClick={() => setAbandoning(false)}>Cancel</button>
                    <button className="btn btn-danger" disabled={!abandonReason.trim() || busy} onClick={doAbandon}>Abandon</button>
                  </div>
                </div>
              )}
              {task.status === 'abandoned' && (
                <div style={{ marginTop: 12, background: 'var(--st-abandon-bg)', border: '1px solid var(--st-abandon)', borderRadius: 'var(--r-sm)', padding: '8px 12px', fontSize: 12, color: 'var(--text-2)' }}>
                  Abandoned{task.abandon_reason ? `: “${task.abandon_reason}”` : ''}.{task._can_edit && <button className="btn btn-ghost" style={{ marginLeft: 10 }} onClick={() => setStatus('not_started')}>Reactivate</button>}
                </div>
              )}

              <div className="dr-props">
                <Prop icon={Users} label="Team">
                  <EditTrigger field="team" empty={!task.department_name}
                    render={<OptionList options={teamOpts} value={task.department_id || ''} searchable onPick={(v) => { saveField('department_id', v); setEdit(null); }} />}>
                    {task.department_name ? <span className="chip"><span className="dot" style={{ background: personColor(task.department_id) }} />{task.department_name}</span> : (canEdit ? 'Set team' : '—')}
                  </EditTrigger>
                </Prop>
                <Prop icon={Layers} label="Program">
                  <EditTrigger field="program" empty={!task.program}
                    render={
                      <div style={{ padding: 8 }}>
                        <Combobox value={task.program_id || ''} options={programCellOpts} placeholder="Pick or type to create…" allowClear={false} style={{ width: 220 }}
                          onChange={(v, opt) => { if (!opt) return; saveField('program_id', opt.value || null); setEdit(null); }}
                          onKeyDown={(e) => { if (e.key === 'Enter') { const text = (e.target.value || '').trim(); if (text && !programCellOpts.some(o => o.label.toLowerCase() === text.toLowerCase())) { e.preventDefault(); createProgramInline(text); setEdit(null); } } }} />
                      </div>}>
                    {task.program ? <span className="chip">{task.program.name}</span> : (canEdit ? 'Set program' : '—')}
                  </EditTrigger>
                </Prop>
                <Prop icon={Hash} label="Space">
                  <EditTrigger field="space"
                    render={<OptionList options={spaceOpts} value={task.space_id || ''} searchable onPick={(v) => { moveToSpace(v); setEdit(null); }} />}>
                    {task.space?.name || 'General'}
                  </EditTrigger>
                </Prop>
                <Prop icon={User} label="Owner">
                  <EditTrigger field="owner" empty={!task.owner_name} width={240}
                    render={<OptionList options={ownerOpts} value={task.owner_employee_id || ''} searchable onPick={(v) => { saveField('owner_employee_id', v); setEdit(null); }} />}>
                    {task.owner_name ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Avatar name={task.owner_name} size={20} />{task.owner_name}</span> : (canEdit ? 'Assign owner' : '—')}
                  </EditTrigger>
                </Prop>
                <Prop icon={Flag} label="Priority">
                  <EditTrigger field="priority" width={180}
                    render={<OptionList options={prioOpts} value={task.priority} onPick={(v) => { saveField('priority', v); setEdit(null); }} />}>
                    <PriorityBadge priority={task.priority} />
                  </EditTrigger>
                </Prop>
                {task.is_recurring ? (
                  <Prop icon={Repeat} label="Repeats">
                    <span style={{ fontSize: 13, color: 'var(--text-1)' }}>{recurrenceSummary(task.recurrence)}</span>
                    <span className="rev-flag" style={{ marginLeft: 8 }}>checklist</span>
                  </Prop>
                ) : (
                <Prop icon={Calendar} label="Deadline">
                  <span ref={ddRef} style={{ position: 'relative', display: 'inline-flex' }}>
                    <span className={'editable' + (!dl ? ' empty' : '')} onClick={canEdit ? () => { setDdDraft(dl); setReviseReason(''); setDdOpen(true); } : undefined} style={{ cursor: canEdit ? 'pointer' : 'default' }}>
                      <span className="tx" style={dstate === 'over' ? { color: 'var(--overdue)', fontWeight: 600 } : {}}>{dl ? `${fmtDateTime(dl)} · ${relDeadline(dl)}` : (canEdit ? 'Set deadline' : '—')}</span>
                      {task.revised_deadline && <span className="rev-flag" style={{ marginLeft: 8 }}>revised</span>}
                    </span>
                    <AnchoredPopover anchorRef={ddRef} open={ddOpen} onClose={() => setDdOpen(false)}>
                      <DatePicker value={ddDraft} onChange={setDdDraft} autoFocus />
                      {task.deadline && <input className="reason-input" placeholder="Reason (required, logged)" value={reviseReason} onChange={e => setReviseReason(e.target.value)} />}
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 10 }}>
                        <button className="btn btn-ghost" onClick={() => setDdOpen(false)}>Cancel</button>
                        <button className="btn btn-primary" disabled={busy || !ddDraft || (!!task.deadline && !reviseReason.trim())} onClick={commitDeadline}><Check size={13} /> {task.deadline ? 'Revise' : 'Set'}</button>
                      </div>
                    </AnchoredPopover>
                  </span>
                </Prop>
                )}
                <Prop icon={Clock} label="Created"><span style={{ fontSize: 13, color: 'var(--text-2)' }}>{fmtDateTime(task.created_at)}{task.creator_name ? ` · ${task.creator_name}` : ''}</span></Prop>
              </div>

              {/* Collaborators */}
              <div className="dr-section">
                <div className="sh">Collaborators</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, alignItems: 'center' }}>
                  {(task.collaborators || []).length === 0 && <span style={{ fontSize: 12.5, color: 'var(--text-4)' }}>None yet</span>}
                  {(task.collaborators || []).map(c => (
                    <span key={c.employee_id} className="chip-rm"><Avatar name={c.full_name} size={18} />{firstName(c.full_name)}
                      {canEdit && <span className="x" onClick={() => removeCollab(c.employee_id)}><X size={12} /></span>}
                    </span>
                  ))}
                  {canEdit && (
                    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      <span style={{ width: 200 }}><Combobox value={collabPick} options={collabOpts} onChange={setCollabPick} placeholder="Add collaborator…" allowClear style={{ width: '100%' }} /></span>
                      <button className="btn btn-primary" onClick={addCollab} disabled={busy || !collabPick}><Plus size={13} /></button>
                    </span>
                  )}
                </div>
              </div>

              {/* Description */}
              <div className="dr-section">
                <div className="sh">Description</div>
                {canEdit ? (
                  <textarea className="reason-input" style={{ minHeight: 80, marginTop: 0, resize: 'vertical', lineHeight: 1.6 }} placeholder="Add a description…"
                    value={descDraft} onChange={e => setDescDraft(e.target.value)} onBlur={() => { if (descDraft !== (task.description || '')) saveField('description', descDraft); }} />
                ) : (task.description ? <div className="dr-desc">{task.description}</div> : <span style={{ fontSize: 12.5, color: 'var(--text-4)' }}>—</span>)}
              </div>

              {!task.is_recurring && <div className="dr-section"><div className="sh">Sub-tasks</div><SubtaskPanel task={task} session={session} canEdit={canEdit} onChange={mutated} /></div>}
              <div className="dr-section"><div className="sh">Documents</div><DocLinksPanel task={task} session={session} canEdit={canEdit} onChange={mutated} /></div>

              <div className="dr-tabs">
                <button className={'dr-tab' + (tab === 'comments' ? ' on' : '')} onClick={() => setTab('comments')}>Comments · {(task.comments || []).length}</button>
                <button className={'dr-tab' + (tab === 'history' ? ' on' : '')} onClick={() => setTab('history')}>History</button>
              </div>
              {tab === 'comments' ? <CommentsPanel task={task} session={session} onChange={mutated} /> : <HistoryPanel task={task} />}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

export default TaskDrawer;
