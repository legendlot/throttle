'use client';
import { useState, useMemo } from 'react';
import { X } from 'lucide-react';
import { Combobox } from '@throttle/ui';
import { DatePicker } from './DatePicker.js';
import { PRIORITIES } from '../lib/tasks.js';

// Controlled create form. `departments` + `employees` are loaded by the parent.
// onSubmit receives the assembled payload; parent calls createTask.
export function TaskForm({ departments, employees, programs = [], parentTask, onCreateProgram, onSubmit, saving }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [departmentId, setDepartmentId] = useState(parentTask?.department_id || '');
  const [ownerId, setOwnerId] = useState('');
  const [programId, setProgramId] = useState('');
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
  const programOpts = useMemo(() => [{ value: '', label: '— No program —' }, ...(programs || []).map(p => ({ value: p.id, label: p.name }))], [programs]);
  const collabOpts = useMemo(() => (employees || []).filter(e => !collaborators.includes(e.id) && e.id !== ownerId).map(e => ({ value: e.id, label: e.full_name })), [employees, collaborators, ownerId]);

  async function pickProgram(v, opt) {
    if (!opt) return;                      // ignore mid-type clears
    setProgramId(opt.value || '');
  }
  async function createProgram(name) {
    try { const prog = await onCreateProgram(name); if (prog?.id) setProgramId(prog.id); } catch { /* parent toasts */ }
  }

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
      program_id: programId || null,
      collaborators,
      deadline: new Date(deadline).toISOString(),
      priority,
      documents: docs,
      parent_task_id: parentTask?.id || null,
    });
  }

  return (
    <form onSubmit={submit} className="panel" style={{ maxWidth: 720 }}>
      {parentTask && (
        <div className="tk-note" style={{ marginTop: 0, marginBottom: 14, background: 'var(--accent-soft)', borderColor: 'var(--accent-line)' }}>
          Sub-task of <strong>{parentTask.task_no}</strong> · {parentTask.title}
        </div>
      )}
      <div style={{ marginBottom: 12 }}>
        <label className="tk-lbl">Title *</label>
        <input value={title} onChange={e => setTitle(e.target.value)} className="tk-input" disabled={saving} autoFocus />
      </div>
      <div style={{ marginBottom: 12 }}>
        <label className="tk-lbl">Description</label>
        <textarea className="tk-input" value={description} onChange={e => setDescription(e.target.value)} rows={3} disabled={saving} />
      </div>

      <div className="tk-form-grid">
        <div>
          <label className="tk-lbl">Department (Team) *</label>
          <Combobox value={departmentId} options={deptOpts} onChange={(v) => setDepartmentId(v)} placeholder="Select team…" disabled={saving} style={comboStyle} />
        </div>
        <div>
          <label className="tk-lbl">Priority</label>
          <Combobox value={priority} options={prioOpts} onChange={(v) => setPriority(v || 'P2')} placeholder="Priority…" allowClear={false} disabled={saving} style={comboStyle} />
        </div>
      </div>

      <div className="tk-form-grid">
        <div>
          <label className="tk-lbl">Owner *</label>
          <Combobox value={ownerId} options={empOpts} onChange={(v) => setOwnerId(v)} placeholder="Select owner…" disabled={saving} style={comboStyle} />
        </div>
        <div>
          <label className="tk-lbl">Program</label>
          <Combobox value={programId} options={programOpts} onChange={pickProgram}
            onCreateOption={onCreateProgram ? createProgram : undefined}
            placeholder={onCreateProgram ? 'Pick or type to create…' : 'Select program…'} allowClear={false} disabled={saving} style={comboStyle} />
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <label className="tk-lbl">Deadline * (cannot be changed after creation; revisions are tracked separately)</label>
        <DatePicker value={deadline || null} onChange={setDeadline} />
      </div>

      <div style={{ marginBottom: 12 }}>
        <label className="tk-lbl">Collaborators</label>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <div style={{ flex: 1 }}><Combobox value={collabPick} options={collabOpts} onChange={(v) => setCollabPick(v)} placeholder="Add a collaborator…" allowClear disabled={saving} style={comboStyle} /></div>
          <button type="button" className="btn btn-ghost" onClick={addCollab} disabled={saving || !collabPick}>Add</button>
        </div>
        {collaborators.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {collaborators.map(id => (
              <span key={id} className="chip-rm">
                {empName[id] || id}
                <span className="x" onClick={() => setCollaborators(c => c.filter(x => x !== id))}><X size={12} /></span>
              </span>
            ))}
          </div>
        )}
      </div>

      <div style={{ marginBottom: 16 }}>
        <label className="tk-lbl">Document links</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <input value={docTitle} onChange={e => setDocTitle(e.target.value)} placeholder="Label (optional)" className="tk-input" style={{ flex: 1 }} disabled={saving} />
          <input value={docUrl} onChange={e => setDocUrl(e.target.value)} placeholder="https://…" className="tk-input" style={{ flex: 2 }} disabled={saving} />
          <button type="button" className="btn btn-ghost" onClick={addDoc} disabled={saving || !/^https?:\/\//i.test(docUrl.trim())}>Add</button>
        </div>
        {docs.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
            {docs.map((d, i) => (
              <div key={i} style={docRow}>
                <span style={{ fontSize: 12, color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {d.title ? `${d.title} · ` : ''}{d.url}
                </span>
                <X size={13} style={{ cursor: 'pointer', flexShrink: 0 }} onClick={() => setDocs(x => x.filter((_, j) => j !== i))} />
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? 'Creating…' : 'Create Task'}
        </button>
      </div>
    </form>
  );
}

// S309: card / grid2 / lbl / input / note / chip / btn* moved to shared classes in
// globals.css (.panel, .tk-form-grid, .tk-lbl, .tk-input, .tk-note, .chip-rm, .btn*).
// comboStyle and docRow stay inline — Combobox takes a style prop, not a className.
const comboStyle = { width: '100%', background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '7px 10px', fontSize: 13, outline: 'none', fontFamily: 'inherit' };
const docRow = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '6px 10px' };
