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

function DetailInner() {
  const { session } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const id = useSearchParams().get('id');

  const [task, setTask] = useState(null);
  const [departments, setDepartments] = useState([]);
  const [employees, setEmployees] = useState([]);
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
    ]).then(([d, e]) => { setDepartments(d || []); setEmployees(e || []); });
  }, [session]);
  useEffect(() => { load(); }, [load]);

  const canEdit = !!task?._can_edit;

  function startEdit() {
    setForm({
      title: task.title, description: task.description || '',
      department_id: task.department_id, owner_employee_id: task.owner_employee_id,
      priority: task.priority,
    });
    setEditing(true);
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

  if (loading) return <Spinner />;
  if (!task) return <div style={{ color: 'var(--text-3)' }}>Task not found.</div>;
  const od = isOverdue(task);
  const deptOpts = departments.map(d => ({ value: d.id, label: d.name }));
  const empOpts = employees.map(e => ({ value: e.id, label: e.full_name }));
  const prioOpts = PRIORITIES.map(p => ({ value: p.key, label: p.label }));
  const collabOpts = employees.filter(e => !(task.collaborators || []).some(c => c.employee_id === e.id)).map(e => ({ value: e.id, label: e.full_name }));

  return (
    <div style={{ maxWidth: 1040 }}>
      <button style={btnGhost} onClick={() => router.push('/tasks')}><ArrowLeft size={14} /> All tasks</button>

      {/* header */}
      <div style={{ ...card, marginTop: 12, marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-3)' }}>{task.task_no}</span>
              <StatusBadge status={task.status} />
              <PriorityBadge priority={task.priority} />
            </div>
            {task.parent && (
              <div style={{ marginBottom: 6 }}>
                <button style={parentLink} onClick={() => router.push(`/tasks/detail/?id=${task.parent.id}`)}>
                  <ArrowUp size={12} /> {task.parent.task_no} · {task.parent.title}
                </button>
              </div>
            )}
            {editing
              ? <input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} style={{ ...input, fontSize: 18 }} />
              : <h1 style={h1}>{task.title}</h1>}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {canEdit && !editing && task.status !== 'abandoned' && <button style={btnSecondary} onClick={startEdit}>Edit</button>}
            {editing && <>
              <button style={btnPrimary} onClick={saveEdit} disabled={busy}>Save</button>
              <button style={btnGhost} onClick={() => setEditing(false)}>Cancel</button>
            </>}
          </div>
        </div>

        {editing ? (
          <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            rows={3} placeholder="Description" style={{ ...input, marginTop: 10, resize: 'vertical' }} />
        ) : (task.description && <p style={{ marginTop: 10, fontSize: 13, color: 'var(--text-2)', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{task.description}</p>)}

        {/* status controls */}
        {canEdit && task.status !== 'abandoned' && (
          <div style={{ display: 'flex', gap: 6, marginTop: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginRight: 4 }}>Status</span>
            {SETTABLE_STATUSES.map(s => (
              <button key={s.key} onClick={() => setStatus(s.key)} disabled={busy || task.status === s.key}
                style={statusBtn(task.status === s.key)}>{s.label}</button>
            ))}
            <button onClick={() => { setModal('abandon'); setReason(''); }} style={{ ...statusBtn(false), color: 'var(--state-error-fg)', borderColor: 'var(--state-error)' }}>Abandon</button>
          </div>
        )}
        {task.status === 'abandoned' && (
          <div style={{ ...noteErr, marginTop: 14 }}>
            Abandoned {task.abandoned_at ? `on ${fmtDate(task.abandoned_at)}` : ''}{task.abandon_reason ? `: “${task.abandon_reason}”` : ''}.
            {canEdit && <button style={{ ...btnGhost, marginLeft: 10 }} onClick={() => setStatus('not_started')} disabled={busy}>Reactivate</button>}
          </div>
        )}
      </div>

      {/* two-column body */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        {/* left: details + deadline + collaborators */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <section style={card}>
            <div style={sectionTitle}>Details</div>
            <Field label="Team">
              {editing
                ? <Combobox value={form.department_id || ''} options={deptOpts} onChange={(v, opt) => { if (opt) setForm(f => ({ ...f, department_id: v })); }} placeholder="Team…" style={input} />
                : (task.department_name || '—')}
            </Field>
            <Field label="Owner">
              {editing
                ? <Combobox value={form.owner_employee_id || ''} options={empOpts} onChange={(v, opt) => { if (opt) setForm(f => ({ ...f, owner_employee_id: v })); }} placeholder="Owner…" style={input} />
                : (task.owner_name || '—')}
            </Field>
            <Field label="Priority">
              {editing
                ? <Combobox value={form.priority} options={prioOpts} onChange={(v) => setForm(f => ({ ...f, priority: v || 'P2' }))} placeholder="Priority…" allowClear={false} style={input} />
                : <PriorityBadge priority={task.priority} />}
            </Field>
          </section>

          <section style={card}>
            <div style={sectionTitle}>Timeline</div>
            <Field label="Created">{fmtDateTime(task.created_at)}{task.creator_name ? ` · ${task.creator_name}` : ''}</Field>
            <Field label="Original deadline">{fmtDateTime(task.deadline)} <span style={lock}>locked</span></Field>
            <Field label="Current deadline">
              <span style={{ color: od ? 'var(--state-error-fg)' : 'var(--text-1)', fontWeight: od ? 600 : 400 }}>
                {fmtDateTime(effectiveDeadline(task))}
              </span>
              {task.revised_deadline && <span style={revFlag}>revised</span>}
            </Field>
            {task.completed_at && <Field label="Completed">{fmtDateTime(task.completed_at)}</Field>}
            {canEdit && task.status !== 'abandoned' && (
              <button style={{ ...btnSecondary, marginTop: 8 }} onClick={() => { setModal('revise'); setReason(''); setNewDeadline(effectiveDeadline(task)); }}>
                Revise deadline
              </button>
            )}
          </section>

          <section style={card}>
            <div style={sectionTitle}>Collaborators</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: canEdit ? 10 : 0 }}>
              {(task.collaborators || []).length === 0 && <span style={{ fontSize: 12, color: 'var(--text-3)' }}>None</span>}
              {(task.collaborators || []).map(c => (
                <span key={c.employee_id} style={chip}>
                  {c.full_name || c.employee_id}
                  {canEdit && <X size={12} style={{ cursor: 'pointer' }} onClick={() => removeCollab(c.employee_id)} />}
                </span>
              ))}
            </div>
            {canEdit && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <div style={{ flex: 1 }}><Combobox value={collabPick} options={collabOpts} onChange={(v) => setCollabPick(v)} placeholder="Add collaborator…" allowClear style={input} /></div>
                <button style={btnSecondary} onClick={addCollab} disabled={busy || !collabPick}><Plus size={13} /></button>
              </div>
            )}
          </section>
        </div>

        {/* right: subtasks + docs */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <section style={card}>
            <div style={sectionTitle}>Sub-tasks</div>
            <SubtaskPanel task={task} session={session} />
          </section>
          <section style={card}>
            <div style={sectionTitle}>Documents</div>
            <DocLinksPanel task={task} session={session} canEdit={canEdit} onChange={load} />
          </section>
        </div>
      </div>

      {/* comments / history tabs */}
      <div style={{ ...card, marginTop: 14 }}>
        <div style={{ display: 'flex', gap: 4, marginBottom: 14, borderBottom: '1px solid var(--border)' }}>
          {['comments', 'history'].map(t => (
            <button key={t} onClick={() => setTab(t)} style={tabBtn(tab === t)}>{t === 'comments' ? 'Comments' : 'History'}</button>
          ))}
        </div>
        {tab === 'comments'
          ? <CommentsPanel task={task} session={session} onChange={load} />
          : <HistoryPanel task={task} />}
      </div>

      {/* modals */}
      {modal && (
        <div style={overlay} onClick={() => setModal(null)}>
          <div style={modalCard} onClick={e => e.stopPropagation()}>
            <div style={sectionTitle}>{modal === 'revise' ? 'Revise deadline' : 'Abandon task'}</div>
            {modal === 'revise' && (
              <div style={{ marginBottom: 12 }}>
                <label style={lbl}>New deadline</label>
                <DatePicker value={newDeadline} onChange={setNewDeadline} autoFocus />
              </div>
            )}
            <div style={{ marginBottom: 12 }}>
              <label style={lbl}>Reason (required, logged to history)</label>
              <textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} style={{ ...input, resize: 'vertical' }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
              <button style={btnGhost} onClick={() => setModal(null)}>Cancel</button>
              <button style={btnPrimary} onClick={modal === 'revise' ? doRevise : doAbandon} disabled={busy}>
                {modal === 'revise' ? 'Revise' : 'Abandon'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ display: 'flex', gap: 10, padding: '6px 0', alignItems: 'center' }}>
      <span style={{ width: 130, flexShrink: 0, fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
      <span style={{ fontSize: 13, color: 'var(--text-1)', flex: 1 }}>{children}</span>
    </div>
  );
}

export default function DetailPage() {
  return <Suspense fallback={<Spinner />}><DetailInner /></Suspense>;
}

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '16px 18px' };
const h1 = { fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.02em', color: 'var(--text-1)' };
const sectionTitle = { fontFamily: 'var(--font-cond)', fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-2)', marginBottom: 10 };
const input = { width: '100%', background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '7px 10px', fontSize: 13, outline: 'none', fontFamily: 'inherit' };
const lbl = { display: 'block', fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4, fontWeight: 700 };
const chip = { display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-full)', padding: '3px 10px', fontSize: 12, color: 'var(--text-1)' };
const lock = { marginLeft: 6, fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-4)', background: 'var(--surface-2)', borderRadius: 3, padding: '1px 5px', textTransform: 'uppercase' };
const revFlag = { marginLeft: 8, fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--state-warning-fg)', background: 'var(--state-warning-bg)', borderRadius: 3, padding: '1px 5px', textTransform: 'uppercase' };
const parentLink = { display: 'inline-flex', alignItems: 'center', gap: 5, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '3px 9px', fontSize: 11, color: 'var(--text-2)', cursor: 'pointer', fontFamily: 'var(--font-mono)' };
const noteErr = { background: 'var(--state-error-bg)', border: '1px solid var(--state-error)', borderRadius: 'var(--radius-sm)', padding: '8px 12px', fontSize: 12, color: 'var(--text-2)' };
const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 20 };
const modalCard = { background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-md)', padding: '18px 20px', width: 440, maxWidth: '100%' };
const btnBase = { display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 'var(--radius-sm)', padding: '7px 14px', fontFamily: 'var(--font-cond)', fontSize: 12, fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.04em' };
const btnPrimary = { ...btnBase, background: 'var(--docket-accent)', color: 'var(--accent-fg)', border: '1px solid var(--docket-accent)' };
const btnSecondary = { ...btnBase, background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)' };
const btnGhost = { ...btnBase, background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border)' };
function statusBtn(on) {
  return { background: on ? 'var(--docket-accent)' : 'var(--surface-2)', color: on ? 'var(--accent-fg)' : 'var(--text-2)', border: `1px solid ${on ? 'var(--docket-accent)' : 'var(--border)'}`, borderRadius: 'var(--radius-sm)', padding: '5px 12px', fontFamily: 'var(--font-cond)', fontSize: 11, fontWeight: 700, cursor: on ? 'default' : 'pointer', textTransform: 'uppercase', letterSpacing: '0.04em' };
}
function tabBtn(on) {
  return { background: 'none', border: 'none', borderBottom: `2px solid ${on ? 'var(--docket-accent)' : 'transparent'}`, color: on ? 'var(--text-1)' : 'var(--text-3)', padding: '8px 14px', fontFamily: 'var(--font-cond)', fontSize: 12, fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.05em' };
}
