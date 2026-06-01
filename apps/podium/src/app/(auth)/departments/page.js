'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast, Modal } from '@throttle/ui';
import { Plus, Pencil } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../../../lib/podiumopsFetch.js';

export default function DepartmentsPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [rows, setRows] = useState(null);
  const [people, setPeople] = useState([]);
  const [edit, setEdit] = useState(null);   // dept object or {} for new, null = closed
  const [busy, setBusy] = useState(false);
  const canManage = !!perms?.podium_hr;

  function load() { podiumopsGet('getDepartments', {}, session).then(d => setRows(d.departments || [])).catch(() => setRows([])); }
  useEffect(() => {
    if (!session) return;
    load();
    podiumopsGet('getEmployees', { status: 'all', limit: 2000 }, session).then(e => setPeople(e.employees || [])).catch(() => {});
  }, [session]);

  async function save() {
    if (!edit.name?.trim()) { showToast('Name required', 'error'); return; }
    setBusy(true);
    try {
      const patch = { name: edit.name, code: edit.code || null, parent_department_id: edit.parent_department_id || null, head_employee_id: edit.head_employee_id || null, description: edit.description || null, active: edit.active !== false };
      if (edit.id) await podiumopsPost('updateDepartment', { department_id: edit.id, patch }, session);
      else await podiumopsPost('createDepartment', patch, session);
      showToast('Saved', 'success'); setEdit(null); load();
    } catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }

  if (!rows) return <Spinner />;

  return (
    <div>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1 style={h1}>Departments</h1>
        {canManage && <button onClick={() => setEdit({ active: true })} style={newBtn}><Plus size={15} /> New Department</button>}
      </header>

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead><tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
            <th style={th}>Name</th><th style={th}>Code</th><th style={th}>Head</th><th style={th}>Parent</th><th style={th}>Headcount</th>{canManage && <th style={th}></th>}
          </tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={6} style={{ ...td, color: 'var(--text-3)', textAlign: 'center' }}>No departments</td></tr>}
            {rows.map(d => (
              <tr key={d.id} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={td}>{d.name}{!d.active && <span style={{ color: 'var(--text-4)', fontSize: 11 }}> (inactive)</span>}</td>
                <td style={td}>{d.code || '—'}</td>
                <td style={td}>{d.head?.full_name || '—'}</td>
                <td style={td}>{d.parent?.name || '—'}</td>
                <td style={td}>{d.headcount || 0}</td>
                {canManage && <td style={td}><button onClick={() => setEdit(d)} style={iconBtn}><Pencil size={13} /></button></td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Edit Department' : 'New Department'} confirmLabel={busy ? 'Saving…' : 'Save'} onConfirm={save} loading={busy}>
        {edit && <>
          <Field label="Name *"><input style={inp} value={edit.name || ''} onChange={e => setEdit(s => ({ ...s, name: e.target.value }))} /></Field>
          <Field label="Code"><input style={inp} value={edit.code || ''} onChange={e => setEdit(s => ({ ...s, code: e.target.value }))} /></Field>
          <Field label="Head"><select style={inp} value={edit.head_employee_id || ''} onChange={e => setEdit(s => ({ ...s, head_employee_id: e.target.value }))}><option value="">—</option>{people.map(p => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></Field>
          <Field label="Parent department"><select style={inp} value={edit.parent_department_id || ''} onChange={e => setEdit(s => ({ ...s, parent_department_id: e.target.value }))}><option value="">—</option>{rows.filter(r => r.id !== edit.id).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
          <Field label="Description"><input style={inp} value={edit.description || ''} onChange={e => setEdit(s => ({ ...s, description: e.target.value }))} /></Field>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}><input type="checkbox" checked={edit.active !== false} onChange={e => setEdit(s => ({ ...s, active: e.target.checked }))} /> Active</label>
        </>}
      </Modal>
    </div>
  );
}

const h1 = { fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' };
const th = { padding: '10px 12px', fontSize: 11, color: 'var(--text-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600 };
const td = { padding: '10px 12px' };
const newBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--podium-green)', color: '#04130d', border: 'none', borderRadius: 'var(--radius-sm)', padding: '8px 14px', fontWeight: 700, fontSize: 12, letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer' };
const iconBtn = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, background: 'var(--surface-2)', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' };
const inp = { width: '100%', background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '7px 10px', fontFamily: 'var(--font-mono)', fontSize: 13 };
function Field({ label, children }) { return <label style={{ display: 'block', marginBottom: 10 }}><div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 4 }}>{label}</div>{children}</label>; }
