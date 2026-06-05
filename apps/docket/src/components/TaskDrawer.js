'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Spinner, useToast, Combobox } from '@throttle/ui';
import { X, Maximize2, Plus, Check } from 'lucide-react';
import { docketopsGet, docketopsPost } from '../lib/docketopsFetch.js';
import { StatusBadge } from './StatusBadge.js';
import { PriorityBadge } from './PriorityBadge.js';
import { CommentsPanel } from './CommentsPanel.js';
import { HistoryPanel } from './HistoryPanel.js';
import { SubtaskPanel } from './SubtaskPanel.js';
import { DocLinksPanel } from './DocLinksPanel.js';
import { DatePicker } from './DatePicker.js';
import { SETTABLE_STATUSES, PRIORITIES, effectiveDeadline, isOverdue } from '../lib/tasks.js';
import { fmtDateTime } from '../lib/format.js';

// Notion-style slide-over "peek" for a task. Opens on row/title click in the list;
// quick-edits the common fields inline and reuses the full detail panels. The
// "Open full page" button routes to /tasks/detail for the expanded view.
export function TaskDrawer({ id, session, departments = [], employees = [], onClose, onMutated }) {
  const { showToast } = useToast();
  const router = useRouter();
  const [task, setTask] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('comments');
  const [titleDraft, setTitleDraft] = useState('');
  const [descDraft, setDescDraft] = useState('');
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

  // Esc closes the drawer (unless a sub-popover is open).
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') { if (ddOpen) setDdOpen(false); else if (abandoning) setAbandoning(false); else onClose?.(); } }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, ddOpen, abandoning]);

  // Click outside the deadline popover (calendar) closes it — matches the table cell.
  const ddRef = useRef(null);
  useEffect(() => {
    if (!ddOpen) return;
    function onDown(e) { if (ddRef.current && !ddRef.current.contains(e.target)) setDdOpen(false); }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [ddOpen]);

  const canEdit = !!task?._can_edit && task?.status !== 'abandoned';

  const mutated = useCallback(async () => { await load(true); onMutated?.(); }, [load, onMutated]);

  async function saveField(field, value) {
    setBusy(true);
    try { await docketopsPost('updateTask', { id: task.id, [field]: value || null }, session); await mutated(); }
    catch (e) { showToast(e.message || 'Save failed', 'error'); load(true); }
    finally { setBusy(false); }
  }
  async function setStatus(status) {
    setBusy(true);
    try { await docketopsPost('changeStatus', { id: task.id, status }, session); await mutated(); }
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
  async function assignProgram(v, opt) {
    if (!opt) return;                               // ignore mid-type clears
    if (!opt.value) { saveField('program_id', null); return; }
    saveField('program_id', opt.value);
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

  const deptOpts = departments.map(d => ({ value: d.id, label: d.name }));
  const empOpts = employees.map(e => ({ value: e.id, label: e.full_name }));
  const prioOpts = PRIORITIES.map(p => ({ value: p.key, label: p.label }));
  const programCellOpts = [{ value: '', label: '— No program —' }, ...programs.map(p => ({ value: p.id, label: p.name }))];
  const spaceOpts = spaces.map(s => ({ value: s.id, label: s.name + (s.is_private ? '' : ' (open)') }));
  const collabOpts = task ? employees.filter(e => !(task.collaborators || []).some(c => c.employee_id === e.id)).map(e => ({ value: e.id, label: e.full_name })) : [];
  const od = task && isOverdue(task);

  return (
    <div style={backdrop} className="dk-backdrop" onMouseDown={onClose}>
      <aside style={drawer} className="dk-drawer" onMouseDown={e => e.stopPropagation()}>
        {loading || !task ? <div style={{ padding: 40 }}><Spinner /></div> : (
          <>
            <div style={topbar}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-3)' }}>{task.task_no}</span>
                <StatusBadge status={task.status} />
                <PriorityBadge priority={task.priority} />
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                <button className="dk-press" style={iconBtn} title="Open full page" onClick={() => router.push(`/tasks/detail/?id=${task.id}`)}><Maximize2 size={15} /></button>
                <button className="dk-press" style={iconBtn} title="Close (Esc)" onClick={onClose}><X size={16} /></button>
              </div>
            </div>

            <div style={body}>
              {/* Title */}
              {canEdit ? (
                <input value={titleDraft} onChange={e => setTitleDraft(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                  onBlur={() => { const v = titleDraft.trim(); if (v && v !== task.title) saveField('title', v); }}
                  style={titleInput} />
              ) : <h2 style={titleH}>{task.title}</h2>}

              {/* Status row */}
              {canEdit && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
                  {SETTABLE_STATUSES.map(s => (
                    <button key={s.key} className="dk-press" onClick={() => setStatus(s.key)} disabled={busy || task.status === s.key} style={statusBtn(task.status === s.key)}>{s.label}</button>
                  ))}
                  <button className="dk-press" onClick={() => { setAbandoning(true); setAbandonReason(''); }} style={{ ...statusBtn(false), color: 'var(--state-error-fg)', borderColor: 'var(--state-error)' }}>Abandon</button>
                </div>
              )}
              {abandoning && (
                <div style={{ marginTop: 8 }}>
                  <input autoFocus value={abandonReason} onChange={e => setAbandonReason(e.target.value)} placeholder="Reason for abandoning (required, logged)" style={field}
                    onKeyDown={e => { if (e.key === 'Enter' && abandonReason.trim()) doAbandon(); }} />
                  <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 6 }}>
                    <button style={ghostBtn} onClick={() => setAbandoning(false)}>Cancel</button>
                    <button className="dk-press" style={{ ...dangerBtn, opacity: abandonReason.trim() ? 1 : 0.5 }} disabled={!abandonReason.trim() || busy} onClick={doAbandon}>Abandon</button>
                  </div>
                </div>
              )}
              {task.status === 'abandoned' && (
                <div style={abandonedNote}>Abandoned{task.abandon_reason ? `: “${task.abandon_reason}”` : ''}.{task._can_edit && <button style={{ ...ghostBtn, marginLeft: 10 }} onClick={() => setStatus('not_started')}>Reactivate</button>}</div>
              )}

              {/* Properties */}
              <div style={props}>
                <Prop label="Team">
                  {canEdit ? <Combobox value={task.department_id || ''} options={deptOpts} placeholder="Set team…" allowClear commitOnTab style={field} onChange={(v) => saveField('department_id', v)} />
                    : (task.department_name || '—')}
                </Prop>
                <Prop label="Program">
                  {canEdit ? <Combobox value={task.program_id || ''} options={programCellOpts} placeholder="Set program…" allowClear={false} commitOnTab style={field}
                      onChange={assignProgram}
                      onKeyDown={(e) => { if (e.key === 'Enter') { const text = (e.target.value || '').trim(); if (text && !programCellOpts.some(o => o.label.toLowerCase() === text.toLowerCase())) { e.preventDefault(); createProgramInline(text); } } }} />
                    : (task.program?.name || '—')}
                </Prop>
                <Prop label="Space">
                  {canEdit && spaceOpts.length > 1
                    ? <Combobox value={task.space_id || ''} options={spaceOpts} placeholder="Move to space…" allowClear={false} commitOnTab style={field} onChange={moveToSpace} />
                    : (task.space?.name || 'General')}
                </Prop>
                <Prop label="Owner">
                  {canEdit ? <Combobox value={task.owner_employee_id || ''} options={empOpts} placeholder="Set owner…" allowClear commitOnTab style={field} onChange={(v) => saveField('owner_employee_id', v)} />
                    : (task.owner_name || '—')}
                </Prop>
                <Prop label="Priority">
                  {canEdit ? <Combobox value={task.priority} options={prioOpts} placeholder="Priority…" allowClear={false} commitOnTab style={field} onChange={(v) => v && saveField('priority', v)} />
                    : <PriorityBadge priority={task.priority} />}
                </Prop>
                <Prop label="Deadline">
                  <span ref={ddRef} style={{ position: 'relative' }}>
                    <span onClick={canEdit ? () => { setDdDraft(effectiveDeadline(task)); setReviseReason(''); setDdOpen(true); } : undefined}
                      style={{ cursor: canEdit ? 'pointer' : 'default', color: od ? 'var(--state-error-fg)' : 'var(--text-1)', fontWeight: od ? 600 : 400 }}>
                      {effectiveDeadline(task) ? fmtDateTime(effectiveDeadline(task)) : (canEdit ? <em style={{ color: 'var(--text-4)' }}>set deadline</em> : '—')}
                    </span>
                    {task.revised_deadline && <span style={revFlag}>revised</span>}
                    {ddOpen && (
                      <div style={ddPopover} onMouseDown={e => e.stopPropagation()}>
                        <DatePicker value={ddDraft} onChange={setDdDraft} autoFocus />
                        {task.deadline && <input value={reviseReason} onChange={e => setReviseReason(e.target.value)} placeholder="Reason (required, logged)" style={{ ...field, marginTop: 8 }} />}
                        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 8 }}>
                          <button style={ghostBtn} onClick={() => setDdOpen(false)}>Cancel</button>
                          <button className="dk-press" style={primaryBtn} disabled={busy || !ddDraft || (!!task.deadline && !reviseReason.trim())} onClick={commitDeadline}><Check size={13} /> {task.deadline ? 'Revise' : 'Set'}</button>
                        </div>
                      </div>
                    )}
                  </span>
                </Prop>
                <Prop label="Created">{fmtDateTime(task.created_at)}{task.creator_name ? ` · ${task.creator_name}` : ''}</Prop>
              </div>

              {/* Collaborators */}
              <Section title="Collaborators">
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: canEdit ? 8 : 0 }}>
                  {(task.collaborators || []).length === 0 && <span style={{ fontSize: 12, color: 'var(--text-3)' }}>None</span>}
                  {(task.collaborators || []).map(c => (
                    <span key={c.employee_id} style={chip}>{c.full_name || c.employee_id}{canEdit && <X size={12} style={{ cursor: 'pointer' }} onClick={() => removeCollab(c.employee_id)} />}</span>
                  ))}
                </div>
                {canEdit && (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <div style={{ flex: 1 }}><Combobox value={collabPick} options={collabOpts} onChange={setCollabPick} placeholder="Add collaborator…" allowClear style={field} /></div>
                    <button className="dk-press" style={secondaryBtn} onClick={addCollab} disabled={busy || !collabPick}><Plus size={13} /></button>
                  </div>
                )}
              </Section>

              {/* Description */}
              <Section title="Description">
                {canEdit ? (
                  <textarea value={descDraft} onChange={e => setDescDraft(e.target.value)} rows={3} placeholder="Add a description…"
                    onBlur={() => { if (descDraft !== (task.description || '')) saveField('description', descDraft); }}
                    style={{ ...field, resize: 'vertical' }} />
                ) : (task.description ? <p style={{ fontSize: 13, color: 'var(--text-2)', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{task.description}</p> : <span style={{ fontSize: 12, color: 'var(--text-3)' }}>—</span>)}
              </Section>

              <Section title="Sub-tasks"><SubtaskPanel task={task} session={session} /></Section>
              <Section title="Documents"><DocLinksPanel task={task} session={session} canEdit={canEdit} onChange={mutated} /></Section>

              <div style={{ marginTop: 14 }}>
                <div style={{ display: 'flex', gap: 4, marginBottom: 12, borderBottom: '1px solid var(--border)' }}>
                  {['comments', 'history'].map(t => <button key={t} onClick={() => setTab(t)} style={tabBtn(tab === t)}>{t === 'comments' ? 'Comments' : 'History'}</button>)}
                </div>
                {tab === 'comments' ? <CommentsPanel task={task} session={session} onChange={mutated} /> : <HistoryPanel task={task} />}
              </div>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

function Prop({ label, children }) {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', minHeight: 30 }}>
      <span style={{ width: 92, flexShrink: 0, fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
      <span style={{ flex: 1, fontSize: 13, color: 'var(--text-1)' }}>{children}</span>
    </div>
  );
}
function Section({ title, children }) {
  return (
    <section style={{ marginTop: 16 }}>
      <div style={sectionTitle}>{title}</div>
      {children}
    </section>
  );
}

const backdrop = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 70, display: 'flex', justifyContent: 'flex-end' };
const drawer = { width: 'min(560px, 100%)', height: '100%', background: 'var(--bg)', borderLeft: '1px solid var(--border-2)', boxShadow: '-12px 0 40px rgba(0,0,0,0.45)', display: 'flex', flexDirection: 'column', overflow: 'hidden' };
const topbar = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 };
const body = { padding: '16px 18px 40px', overflowY: 'auto', flex: 1 };
const iconBtn = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, background: 'var(--surface-2)', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' };
const titleInput = { width: '100%', background: 'transparent', color: 'var(--text-1)', border: '1px solid transparent', borderRadius: 'var(--radius-sm)', padding: '4px 6px', marginLeft: -6, fontFamily: 'var(--font-cond)', fontSize: 20, fontWeight: 700, outline: 'none' };
const titleH = { fontFamily: 'var(--font-cond)', fontSize: 20, fontWeight: 700, color: 'var(--text-1)' };
const props = { marginTop: 16, display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 14, borderTop: '1px solid var(--border)' };
const field = { width: '100%', background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '6px 9px', fontSize: 13, outline: 'none', fontFamily: 'inherit' };
const sectionTitle = { fontFamily: 'var(--font-cond)', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-2)', marginBottom: 8 };
const chip = { display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-full)', padding: '3px 10px', fontSize: 12, color: 'var(--text-1)' };
const revFlag = { marginLeft: 8, fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--state-warning-fg)', background: 'var(--state-warning-bg)', borderRadius: 3, padding: '1px 5px', textTransform: 'uppercase' };
const abandonedNote = { marginTop: 12, background: 'var(--state-error-bg)', border: '1px solid var(--state-error)', borderRadius: 'var(--radius-sm)', padding: '8px 12px', fontSize: 12, color: 'var(--text-2)' };
const ddPopover = { position: 'absolute', top: '100%', left: 0, zIndex: 20, marginTop: 4, background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-md)', padding: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.4)' };
const btnBase = { display: 'inline-flex', alignItems: 'center', gap: 5, borderRadius: 'var(--radius-sm)', padding: '6px 12px', fontFamily: 'var(--font-cond)', fontSize: 11, fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.04em' };
const primaryBtn = { ...btnBase, background: 'var(--docket-accent)', color: 'var(--accent-fg)', border: '1px solid var(--docket-accent)' };
const secondaryBtn = { ...btnBase, background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)' };
const ghostBtn = { ...btnBase, background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border)' };
const dangerBtn = { ...btnBase, background: 'var(--state-error)', color: '#fff', border: '1px solid var(--state-error)' };
function statusBtn(on) {
  return { background: on ? 'var(--docket-accent)' : 'var(--surface-2)', color: on ? 'var(--accent-fg)' : 'var(--text-2)', border: `1px solid ${on ? 'var(--docket-accent)' : 'var(--border)'}`, borderRadius: 'var(--radius-sm)', padding: '5px 11px', fontFamily: 'var(--font-cond)', fontSize: 11, fontWeight: 700, cursor: on ? 'default' : 'pointer', textTransform: 'uppercase', letterSpacing: '0.04em' };
}
function tabBtn(on) {
  return { background: 'none', border: 'none', borderBottom: `2px solid ${on ? 'var(--docket-accent)' : 'transparent'}`, color: on ? 'var(--text-1)' : 'var(--text-3)', padding: '8px 14px', fontFamily: 'var(--font-cond)', fontSize: 12, fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.05em' };
}

export default TaskDrawer;
