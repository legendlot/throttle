'use client';
import { useState, useMemo } from 'react';
import { X } from 'lucide-react';
import { Combobox } from '@throttle/ui';
import { PRIORITIES } from '../lib/tasks.js';

// Controlled create form. `departments` + `employees` are loaded by the parent.
// onSubmit receives the assembled payload; parent calls createTask.
export function TaskForm({ departments, employees, parentTask, onSubmit, saving }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [departmentId, setDepartmentId] = useState(parentTask?.department_id || '');
  const [ownerId, setOwnerId] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [collaborators, setCollaborators] = useState([]); // [employee_id]
  const [collabPick, setCollabPick] = useState('');
  const [deadline, setDeadline] = useState('');
  const [priority, setPriority] = useState('P2');
  const [docs, setDocs] = useState([]); // [{title,url}]
  const [docTitle, setDocTitle] = useState('');
  const [docUrl, setDocUrl] = useState('');

  const empName = Object.fromEntries((employees || []).map(e => [e.id, e.full_name]));
  const deptOpts = useMemo(() => (departments || []).map(d => ({ value: d.id, label: d.name })), [departments]);
  const empOpts = useMemo(() => (employees || []).map(e => ({ value: e.id, label: e.full_name })), [employees]);
  const prioOpts = PRIORITIES.map(p => ({ value: p.key, label: p.label }));
  const collabOpts = useMemo(() => (employees || []).filter(e => !collaborators.includes(e.id) && e.id !== ownerId).map(e => ({ value: e.id, label: e.full_name })), [employees, collaborators, ownerId]);

  function addCollab() {
    if (collabPick && !collaborators.includes(collabPick)) setCollaborators(c => [...c, collabPick]);
    setCollabPick('');
  }
  function addDoc() {
    const u = docUrl.trim();
    if (!/^https?:\/\//i.test(u)) return;
    setDocs(d => [...d, { title: docTitle.trim() || null, url: u }]);
    setDocTitle(''); setDocUrl('');
  }

  function submit(e) {
    e.preventDefault();
    if (!title.trim() || !departmentId || !ownerId || !deadline) return;
    onSubmit({
      title: title.trim(),
      description: description.trim() || null,
      department_id: departmentId,
      owner_employee_id: ownerId,
      assignee_employee_id: assigneeId || null,
      collaborators,
      deadline: new Date(deadline).toISOString(),
      priority,
      documents: docs,
      parent_task_id: parentTask?.id || null,
    });
  }

  return (
    <form onSubmit={submit} style={card}>
      {parentTask && (
        <div style={{ ...note, marginBottom: 14 }}>
          Sub-task of <strong>{parentTask.task_no}</strong> — {parentTask.title}
        </div>
      )}
      <div style={{ marginBottom: 12 }}>
        <label style={lbl}>Title *</label>
        <input value={title} onChange={e => setTitle(e.target.value)} style={input} disabled={saving} autoFocus />
      </div>
      <div style={{ marginBottom: 12 }}>
        <label style={lbl}>Description</label>
        <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3}
          style={{ ...input, resize: 'vertical' }} disabled={saving} />
      </div>

      <div style={grid2}>
        <div>
          <label style={lbl}>Department (Team) *</label>
          <Combobox value={departmentId} options={deptOpts} onChange={(v) => setDepartmentId(v)} placeholder="Select team…" disabled={saving} style={input} />
        </div>
        <div>
          <label style={lbl}>Priority</label>
          <Combobox value={priority} options={prioOpts} onChange={(v) => setPriority(v || 'P2')} placeholder="Priority…" allowClear={false} disabled={saving} style={input} />
        </div>
      </div>

      <div style={grid2}>
        <div>
          <label style={lbl}>Owner *</label>
          <Combobox value={ownerId} options={empOpts} onChange={(v) => setOwnerId(v)} placeholder="Select owner…" disabled={saving} style={input} />
        </div>
        <div>
          <label style={lbl}>Assignee</label>
          <Combobox value={assigneeId} options={empOpts} onChange={(v) => setAssigneeId(v)} placeholder="— none —" allowClear disabled={saving} style={input} />
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <label style={lbl}>Deadline * (cannot be changed after creation — revisions are tracked separately)</label>
        <input type="datetime-local" value={deadline} onChange={e => setDeadline(e.target.value)} style={input} disabled={saving} />
      </div>

      <div style={{ marginBottom: 12 }}>
        <label style={lbl}>Collaborators</label>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <div style={{ flex: 1 }}><Combobox value={collabPick} options={collabOpts} onChange={(v) => setCollabPick(v)} placeholder="Add a collaborator…" allowClear disabled={saving} style={input} /></div>
          <button type="button" style={btnSecondary} onClick={addCollab} disabled={saving || !collabPick}>Add</button>
        </div>
        {collaborators.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {collaborators.map(id => (
              <span key={id} style={chip}>
                {empName[id] || id}
                <X size={12} style={{ cursor: 'pointer' }} onClick={() => setCollaborators(c => c.filter(x => x !== id))} />
              </span>
            ))}
          </div>
        )}
      </div>

      <div style={{ marginBottom: 16 }}>
        <label style={lbl}>Document links</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <input value={docTitle} onChange={e => setDocTitle(e.target.value)} placeholder="Label (optional)" style={{ ...input, flex: 1 }} disabled={saving} />
          <input value={docUrl} onChange={e => setDocUrl(e.target.value)} placeholder="https://…" style={{ ...input, flex: 2 }} disabled={saving} />
          <button type="button" style={btnSecondary} onClick={addDoc} disabled={saving || !/^https?:\/\//i.test(docUrl.trim())}>Add</button>
        </div>
        {docs.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
            {docs.map((d, i) => (
              <div key={i} style={docRow}>
                <span style={{ fontSize: 12, color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {d.title ? `${d.title} — ` : ''}{d.url}
                </span>
                <X size={13} style={{ cursor: 'pointer', flexShrink: 0 }} onClick={() => setDocs(x => x.filter((_, j) => j !== i))} />
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button type="submit" style={{ ...btnPrimary, opacity: saving ? 0.6 : 1 }} disabled={saving}>
          {saving ? 'Creating…' : 'Create Task'}
        </button>
      </div>
    </form>
  );
}

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '18px 20px', maxWidth: 720 };
const grid2 = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 };
const lbl = { display: 'block', fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4, fontWeight: 700 };
const input = { width: '100%', background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '7px 10px', fontSize: 13, outline: 'none', fontFamily: 'inherit' };
const note = { background: 'var(--accent-bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', fontSize: 12, color: 'var(--text-2)' };
const chip = { display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-full)', padding: '3px 10px', fontSize: 12, color: 'var(--text-1)' };
const docRow = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '6px 10px' };
const btnBase = { display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 'var(--radius-sm)', padding: '7px 14px', fontFamily: 'var(--font-cond)', fontSize: 12, fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.04em' };
const btnPrimary = { ...btnBase, background: 'var(--docket-accent)', color: '#1f1f1f', border: '1px solid var(--docket-accent)' };
const btnSecondary = { ...btnBase, background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)' };
