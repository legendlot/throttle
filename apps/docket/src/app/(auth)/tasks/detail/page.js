'use client';
import { useEffect, useState, useCallback, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast, Combobox } from '@throttle/ui';
import { ArrowLeft, ArrowUp, X, Plus } from 'lucide-react';
import { docketopsGet, docketopsPost } from '../../../../lib/docketopsFetch.js';
import { StatusBadge } from '../../../../components/StatusBadge.js';
import { PriorityBadge } from '../../../../components/PriorityBadge.js';
import { CommentsPanel } from '../../../../components/CommentsPanel.js';
import { HistoryPanel } from '../../../../components/HistoryPanel.js';
import { SubtaskPanel } from '../../../../components/SubtaskPanel.js';
import { DocLinksPanel } from '../../../../components/DocLinksPanel.js';
import { DatePicker } from '../../../../components/DatePicker.js';
import { SETTABLE_STATUSES, PRIORITIES, effectiveDeadline, isOverdue } from '../../../../lib/tasks.js';
import { fmtDate, fmtDateTime } from '../../../../lib/format.js';
import { useHotkey } from '../../../../lib/hotkeys.js';

function DetailInner() {
  const { session } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const id = useSearchParams().get('id');

  const [task, setTask] = useState(null);
  const [departments, setDepartments] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [programs, setPrograms] = useState([]);
  const [spaces, setSpaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('comments');
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState(null); // 'revise' | 'abandon'
  const [reason, setReason] = useState('');
  const [newDeadline, setNewDeadline] = useState('');
  const [collabPick, setCollabPick] = useState('');

  const load = useCallback(async () => {
    if (!session || !id) return;
    try {
      const t = await docketopsGet('getTask', { id }, session);
      setTask(t);
    } catch (e) { showToast(e.message || 'Failed to load task', 'error'); }
    finally { setLoading(false); }
  }, [session, id, showToast]);

  useEffect(() => {
    if (!session) return;
    Promise.all([
      docketopsGet('getDepartments', {}, session).catch(() => []),
      docketopsGet('getEmployees', {}, session).catch(() => []),
      docketopsGet('getPrograms', {}, session).catch(() => []),
      docketopsGet('getSpaces', {}, session).catch(() => []),
    ]).then(([d, e, p, s]) => { setDepartments(d || []); setEmployees(e || []); setPrograms(p || []); setSpaces(s || []); });
  }, [session]);
  useEffect(() => { load(); }, [load]);

  const canEdit = !!task?._can_edit;

  // `s` → add a sub-task to this task (same as the Sub-tasks "Add" button). Only on a
  // parent (one level deep), editable + not abandoned; suspended while a modal/edit is open.
  useHotkey('s', () => {
    if (!(canEdit && task && !task.parent_task_id && task.status !== 'abandoned')) return;
    const el = document.querySelector('[data-subtask-add]');
    if (el) { el.focus(); el.scrollIntoView({ block: 'nearest' }); }
  }, { enabled: !!task && !modal && !editing });

  function startEdit() {
    setForm({
      title: task.title, description: task.description || '',
      department_id: task.department_id, owner_employee_id: task.owner_employee_id,
      priority: task.priority, program_id: task.program_id || null,
    });
    setEditing(true);
  }
  // Create a program on the fly and select it into the buffered edit form.
  async function createProgramInline(name) {
    try {
      const prog = await docketopsPost('createProgram', { name }, session);
      setPrograms(ps => ps.some(p => p.id === prog.id) ? ps : [...ps, prog].sort((a, b) => a.name.localeCompare(b.name)));
      setForm(f => ({ ...f, program_id: prog.id }));
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('docket:programs-changed'));
    } catch (e) { showToast(e.message || 'Failed to add program', 'error'); }
  }
  // Space change is immediate (not part of the buffered form) — goes through moveTask.
  async function moveToSpace(v) {
    if (!v || v === task.space_id) return;
    setBusy(true);
    try { await docketopsPost('moveTask', { id: task.id, space_id: v }, session); await load(); showToast('Moved', 'success'); }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }
  async function saveEdit() {
    setBusy(true);
    try {
      await docketopsPost('updateTask', { id: task.id, ...form }, session);
      setEditing(false); await load(); showToast('Saved', 'success');
    } catch (e) { showToast(e.message || 'Save failed', 'error'); }
    finally { setBusy(false); }
  }
  async function setStatus(status) {
    setBusy(true);
    try { await docketopsPost('changeStatus', { id: task.id, status }, session); await load(); }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }
  async function doRevise() {
    if (!newDeadline || !reason.trim()) { showToast('New deadline and reason required', 'error'); return; }
    setBusy(true);
    try {
      await docketopsPost('reviseDeadline', { id: task.id, new_deadline: new Date(newDeadline).toISOString(), reason: reason.trim() }, session);
      setModal(null); setReason(''); setNewDeadline(''); await load(); showToast('Deadline revised', 'success');
    } catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }
  async function doAbandon() {
    if (!reason.trim()) { showToast('Reason required', 'error'); return; }
    setBusy(true);
    try {
      await docketopsPost('abandonTask', { id: task.id, reason: reason.trim() }, session);
      setModal(null); setReason(''); await load(); showToast('Task abandoned', 'success');
    } catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }
  async function addCollab() {
    if (!collabPick) return;
    setBusy(true);
    try { await docketopsPost('addCollaborator', { id: task.id, employee_id: collabPick }, session); setCollabPick(''); await load(); }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }
  async function removeCollab(employeeId) {
    try { await docketopsPost('removeCollaborator', { id: task.id, employee_id: employeeId }, session); await load(); }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
  }

  // Never swap an open edit form for the spinner — a background reload (a real token
  // refresh re-keys any effect on `session`) must not discard unsaved input.
  if (loading && !editing) return <Spinner />;
  if (!task) return <div style={{ color: 'var(--text-3)' }}>Task not found.</div>;
  const od = isOverdue(task);
  const deptOpts = departments.map(d => ({ value: d.id, label: d.name }));
  const empOpts = employees.map(e => ({ value: e.id, label: e.full_name }));
  const prioOpts = PRIORITIES.map(p => ({ value: p.key, label: p.label }));
  const collabOpts = employees.filter(e => !(task.collaborators || []).some(c => c.employee_id === e.id)).map(e => ({ value: e.id, label: e.full_name }));
  const programCellOpts = [{ value: '', label: '— No program —' }, ...programs.map(p => ({ value: p.id, label: p.name }))];
  const spaceOpts = spaces.map(s => ({ value: s.id, label: s.name + (s.is_private ? '' : ' (open)') }));

  return (
    <div className="tk-page">
      <button className="tk-back" onClick={() => router.push('/tasks')}><ArrowLeft size={13} /> All tasks</button>

      {/* header */}
      <div className="panel" style={{ marginBottom: 14 }}>
        <div className="tk-head">
          <div className="tk-headmain">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <span style={{ fontFamily: 'var(--f-mono)', fontSize: 12, color: 'var(--text-4)' }}>{task.task_no}</span>
              <StatusBadge status={task.status} />
              <PriorityBadge priority={task.priority} />
            </div>
            {task.parent && (
              <div>
                <button className="tk-parent" onClick={() => router.push(`/tasks/detail/?id=${task.parent.id}`)}>
                  <ArrowUp size={12} /> {task.parent.task_no} · {task.parent.title}
                </button>
              </div>
            )}
            {editing
              ? <input className="tk-input" value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} style={{ fontSize: 19, fontWeight: 600 }} />
              : <div className="dr-title">{task.title}</div>}
          </div>
          <div className="tk-actions">
            {canEdit && !editing && task.status !== 'abandoned' && <button className="btn btn-ghost" onClick={startEdit}>Edit</button>}
            {editing && <>
              <button className="btn btn-primary" onClick={saveEdit} disabled={busy}>Save</button>
              <button className="btn btn-ghost" onClick={() => setEditing(false)}>Cancel</button>
            </>}
          </div>
        </div>

        {editing ? (
          <textarea className="tk-input" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            rows={3} placeholder="Description" style={{ marginTop: 12 }} />
        ) : (task.description && <p className="dr-desc" style={{ marginTop: 12 }}>{task.description}</p>)}

        {/* Status row — same .st-btn pills as the drawer, including the per-status
            colour each button adopts when it is the active one. */}
        {canEdit && task.status !== 'abandoned' && (
          <div className="dr-statusrow">
            {SETTABLE_STATUSES.map(s => {
              const on = task.status === s.key;
              return (
                <button key={s.key} className={'st-btn' + (on ? ' on' : '')} onClick={() => setStatus(s.key)} disabled={busy || on}
                  style={on ? { background: s.bg, borderColor: s.color, color: s.color } : {}}>
                  <span className="si" style={{ background: s.color }} />{s.label}
                </button>
              );
            })}
            <button className="st-btn" style={{ color: 'var(--st-abandon)', borderColor: 'var(--st-abandon)' }}
              onClick={() => { setModal('abandon'); setReason(''); }}>Abandon</button>
          </div>
        )}
        {task.status === 'abandoned' && (
          <div className="tk-note">
            Abandoned {task.abandoned_at ? `on ${fmtDate(task.abandoned_at)}` : ''}{task.abandon_reason ? `: “${task.abandon_reason}”` : ''}.
            {canEdit && <button className="btn btn-ghost" style={{ marginLeft: 10 }} onClick={() => setStatus('not_started')} disabled={busy}>Reactivate</button>}
          </div>
        )}
      </div>

      {/* two-column body */}
      <div className="tk-grid">
        {/* left: details + deadline + collaborators */}
        <div className="tk-col">
          <section className="panel">
            <div className="panel-h">Details</div>
            <Field label="Team">
              {editing
                ? <Combobox value={form.department_id || ''} options={deptOpts} onChange={(v, opt) => { if (opt) setForm(f => ({ ...f, department_id: v })); }} placeholder="Team…" style={comboStyle} />
                : (task.department_name || '—')}
            </Field>
            <Field label="Owner">
              {editing
                ? <Combobox value={form.owner_employee_id || ''} options={empOpts} onChange={(v, opt) => { if (opt) setForm(f => ({ ...f, owner_employee_id: v })); }} placeholder="Owner…" style={comboStyle} />
                : (task.owner_name || '—')}
            </Field>
            <Field label="Priority">
              {editing
                ? <Combobox value={form.priority} options={prioOpts} onChange={(v) => setForm(f => ({ ...f, priority: v || 'P2' }))} placeholder="Priority…" allowClear={false} style={comboStyle} />
                : <PriorityBadge priority={task.priority} />}
            </Field>
            <Field label="Program">
              {editing
                ? <Combobox value={form.program_id || ''} options={programCellOpts} allowClear={false} placeholder="Set program…" style={comboStyle}
                    onChange={(v, opt) => { if (opt) setForm(f => ({ ...f, program_id: opt.value || null })); }}
                    onCreateOption={createProgramInline} />
                : (task.program?.name || '—')}
            </Field>
            <Field label="Space">
              {canEdit && spaceOpts.length > 1
                ? <Combobox value={task.space_id || ''} options={spaceOpts} onChange={moveToSpace} allowClear={false} placeholder="Move to space…" style={comboStyle} />
                : (task.space?.name || 'General')}
            </Field>
          </section>

          <section className="panel">
            <div className="panel-h">Timeline</div>
            <Field label="Created">{fmtDateTime(task.created_at)}{task.creator_name ? ` · ${task.creator_name}` : ''}</Field>
            <Field label="Original deadline">{fmtDateTime(task.deadline)} <span style={lock}>locked</span></Field>
            <Field label="Current deadline">
              <span style={{ color: od ? 'var(--overdue)' : 'var(--text-1)', fontWeight: od ? 600 : 400 }}>
                {fmtDateTime(effectiveDeadline(task))}
              </span>
              {task.revised_deadline && <span className="rev-flag" style={{ marginLeft: 8 }}>revised</span>}
            </Field>
            {task.completed_at && <Field label="Completed">{fmtDateTime(task.completed_at)}</Field>}
            {canEdit && task.status !== 'abandoned' && (
              <button className="btn btn-ghost btn-sm" style={{ marginTop: 10 }} onClick={() => { setModal('revise'); setReason(''); setNewDeadline(effectiveDeadline(task)); }}>
                Revise deadline
              </button>
            )}
          </section>

          <section className="panel">
            <div className="panel-h">Collaborators</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: canEdit ? 10 : 0 }}>
              {(task.collaborators || []).length === 0 && <span style={{ fontSize: 12.5, color: 'var(--text-4)' }}>None</span>}
              {(task.collaborators || []).map(c => (
                <span key={c.employee_id} className="chip-rm">
                  {c.full_name || c.employee_id}
                  {canEdit && <span className="x" onClick={() => removeCollab(c.employee_id)}><X size={12} /></span>}
                </span>
              ))}
            </div>
            {canEdit && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <div style={{ flex: 1 }}><Combobox value={collabPick} options={collabOpts} onChange={(v) => setCollabPick(v)} placeholder="Add collaborator…" allowClear style={comboStyle} /></div>
                <button className="btn btn-ghost" onClick={addCollab} disabled={busy || !collabPick}><Plus size={13} /></button>
              </div>
            )}
          </section>
        </div>

        {/* right: subtasks + docs */}
        <div className="tk-col">
          <section className="panel">
            <div className="panel-h">Sub-tasks</div>
            <SubtaskPanel task={task} session={session} canEdit={canEdit} onChange={load} />
          </section>
          <section className="panel">
            <div className="panel-h">Documents</div>
            <DocLinksPanel task={task} session={session} canEdit={canEdit} onChange={load} />
          </section>
        </div>
      </div>

      {/* comments / history tabs */}
      <div className="panel" style={{ marginTop: 14 }}>
        <div className="dr-tabs" style={{ marginTop: 0 }}>
          {['comments', 'history'].map(t => (
            <button key={t} className={'dr-tab' + (tab === t ? ' on' : '')} onClick={() => setTab(t)}>{t === 'comments' ? 'Comments' : 'History'}</button>
          ))}
        </div>
        {tab === 'comments'
          ? <CommentsPanel task={task} session={session} onChange={load} />
          : <HistoryPanel task={task} />}
      </div>

      {/* modals */}
      {modal && (
        <div className="backdrop" onMouseDown={() => setModal(null)}>
          <div className="panel" style={{ width: 440, maxWidth: '100%', margin: 'auto' }} onMouseDown={e => e.stopPropagation()}>
            <div className="panel-h">{modal === 'revise' ? 'Revise deadline' : 'Abandon task'}</div>
            {modal === 'revise' && (
              <div style={{ marginBottom: 14 }}>
                <label className="tk-lbl">New deadline</label>
                <DatePicker value={newDeadline} onChange={setNewDeadline} autoFocus />
              </div>
            )}
            <div style={{ marginBottom: 14 }}>
              <label className="tk-lbl">Reason (required, logged to history)</label>
              <textarea className="tk-input" value={reason} onChange={e => setReason(e.target.value)} rows={3} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
              <button className="btn btn-ghost" onClick={() => setModal(null)}>Cancel</button>
              <button className={'btn ' + (modal === 'revise' ? 'btn-primary' : 'btn-danger')} onClick={modal === 'revise' ? doRevise : doAbandon} disabled={busy}>
                {modal === 'revise' ? 'Revise' : 'Abandon'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// The drawer's own property row, reused verbatim so a task reads identically in
// the drawer and on the full page. `.tk-page .dr-prop` only widens the label
// column — a 110px label is right in a 440px drawer and cramped at 1040px.
function Field({ label, children }) {
  return (
    <div className="dr-prop">
      <span className="k">{label}</span>
      <span className="v">{children}</span>
    </div>
  );
}

export default function DetailPage() {
  return <Suspense fallback={<Spinner />}><DetailInner /></Suspense>;
}

// Only three inline objects survive the S309 restyle. Everything else this file
// used to declare (card / h1 / sectionTitle / btn* / statusBtn / tabBtn / overlay
// / modalCard / chip / parentLink / noteErr / lbl / input) is now a shared class
// in globals.css — .panel, .panel-h, .dr-title, .dr-prop, .dr-statusrow, .st-btn,
// .dr-tabs, .btn*, .backdrop, .chip-rm, .tk-*. Add to those, not back to here.
//
// comboStyle stays inline because Combobox takes a style prop, not a className.
const comboStyle = { width: '100%', background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '7px 10px', fontSize: 13, outline: 'none', fontFamily: 'inherit' };
const lock = { marginLeft: 6, fontFamily: 'var(--f-mono)', fontSize: 9, color: 'var(--text-4)', background: 'var(--surface-2)', borderRadius: 3, padding: '1px 5px', textTransform: 'uppercase' };
