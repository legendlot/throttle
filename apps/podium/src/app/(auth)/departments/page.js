'use client';
import { useEffect, useState } from 'react';
import { teamOptions } from '../../../lib/format.js';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast, Modal, Combobox } from '@throttle/ui';
import { Pencil } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../../../lib/podiumopsFetch.js';
import { GridHead, GridRow, gridTh, PrimaryButton, iconBtn, formLabel } from '../../../components/ui.js';
import { LoadError } from '../../../components/LoadError.js';

const COLS = '1.8fr 0.7fr 1.4fr 1.2fr 1.2fr 110px 60px';

export default function DepartmentsPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [rows, setRows] = useState(null);
  const [founders, setFounders] = useState([]);   // FOUNDER_CODES people — the founder-owner choices
  const [people, setPeople] = useState([]);
  const [edit, setEdit] = useState(null);   // dept object or {} for new, null = closed
  const [busy, setBusy] = useState(false);
  const canManage = !!perms?.podium_hr;
  const [rowsErr, setRowsErr] = useState(null);
  const [peopleErr, setPeopleErr] = useState(null);

  // A failed read is an error with a Retry — never "0 departments" or an empty Head picker.
  function load() {
    setRowsErr(null);
    podiumopsGet('getDepartments', {}, session).then(d => { setRows(d.departments || []); setFounders(d.founders || []); }).catch(setRowsErr);
  }
  function loadPeople() {
    setPeopleErr(null);
    podiumopsGet('getEmployees', { status: 'all', limit: 2000 }, session).then(e => setPeople(e.employees || [])).catch(setPeopleErr);
  }
  useEffect(() => {
    if (!session) return;
    load();
    loadPeople();
  }, [session]); // eslint-disable-line

  async function save() {
    if (!edit.name?.trim()) { showToast('Name required', 'error'); return; }
    setBusy(true);
    try {
      const patch = { name: edit.name, code: edit.code || null, parent_department_id: edit.parent_department_id || null, head_employee_id: edit.head_employee_id || null, founder_owner_employee_id: edit.founder_owner_employee_id || null, description: edit.description || null, active: edit.active !== false };
      if (edit.id) await podiumopsPost('updateDepartment', { department_id: edit.id, patch }, session);
      else await podiumopsPost('createDepartment', patch, session);
      showToast('Saved', 'success'); setEdit(null); load();
    } catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }

  if (!rows && rowsErr) return <LoadError message="Couldn't load departments." onRetry={load} />;
  if (!rows) return <Spinner />;
  const total = rows.reduce((s, d) => s + (d.headcount || 0), 0);
  // Founder owner: the team's own, else inherited from the nearest parent that names one, else both founders.
  const byId = new Map(rows.map(d => [d.id, d]));
  const ownerOf = (d) => {
    for (let x = d, i = 0; x && i < 25; i++) {
      if (x.founder_owner_employee_id) return { name: x.founder_owner?.full_name || founders.find(f => f.id === x.founder_owner_employee_id)?.full_name || 'Founder', inherited: x !== d };
      x = x.parent_department_id ? byId.get(x.parent_department_id) : null;
    }
    return { name: 'Both', inherited: false };
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
        <span style={{ fontSize: 13, color: 'var(--t3)' }}>{rows.length} department{rows.length === 1 ? '' : 's'} · {total} people</span>
        <span style={{ flex: 1 }} />
        {canManage && <PrimaryButton onClick={() => setEdit({ active: true })}>New Department</PrimaryButton>}
      </div>

      <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 11, overflow: 'hidden' }}>
        <GridHead cols={COLS}>
          <div style={gridTh}>Name</div>
          <div style={gridTh}>Code</div>
          <div style={gridTh}>Head</div>
          <div style={gridTh}>Parent</div>
          <div style={gridTh}>Founder owner</div>
          <div style={gridTh}>Headcount</div>
          <div style={gridTh} />
        </GridHead>
        {rows.length === 0 && <div style={{ padding: '20px 16px', color: 'var(--t3)', fontSize: 13, textAlign: 'center' }}>No departments</div>}
        {rows.map(d => (
          <GridRow key={d.id} cols={COLS} onClick={canManage ? () => setEdit(d) : undefined}>
            <div style={{ padding: '11px 16px', fontSize: 13.5, fontWeight: 600, color: 'var(--t1)' }}>{d.name}{!d.active && <span style={{ color: 'var(--t4)', fontSize: 11 }}> (inactive)</span>}</div>
            <div style={{ padding: '11px 16px' }}><span className="num" style={{ fontSize: 11.5, color: 'var(--t2)' }}>{d.code || '—'}</span></div>
            <div style={{ padding: '11px 16px', fontSize: 13, color: 'var(--t2)' }}>{d.head?.full_name || <span style={{ color: 'var(--t4)', fontStyle: 'italic' }}>To be hired</span>}</div>
            <div style={{ padding: '11px 16px', fontSize: 13, color: 'var(--t3)' }}>{d.parent?.name || '—'}</div>
            <div style={{ padding: '11px 16px', fontSize: 13, color: 'var(--t2)' }}>{(o => <>{o.name}{o.inherited && <span style={{ color: 'var(--t4)', fontSize: 11 }}> (from parent)</span>}</>)(ownerOf(d))}</div>
            <div style={{ padding: '11px 16px' }}><span className="num" style={{ fontSize: 13, color: 'var(--t1)' }}>{d.headcount || 0}</span></div>
            <div style={{ padding: '11px 16px', display: 'flex', justifyContent: 'center' }}>
              {canManage && <button onClick={(e) => { e.stopPropagation(); setEdit(d); }} style={iconBtn} title="Edit"><Pencil size={13} /></button>}
            </div>
          </GridRow>
        ))}
      </div>

      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Edit Department' : 'New Department'} confirmLabel={busy ? 'Saving…' : 'Save'} onConfirm={save} loading={busy}>
        {edit && <>
          <Field label="Name *"><input style={inp} value={edit.name || ''} onChange={e => setEdit(s => ({ ...s, name: e.target.value }))} /></Field>
          <Field label="Code"><input style={inp} value={edit.code || ''} onChange={e => setEdit(s => ({ ...s, code: e.target.value }))} /></Field>
          <Field label="Head"><Combobox value={edit.head_employee_id || ''} onChange={v => setEdit(s => ({ ...s, head_employee_id: v }))} inputStyle={comboInp} placeholder="To be hired" options={people.map(p => ({ value: p.id, label: p.full_name, hint: p.employee_code || '' }))} />
            {peopleErr && <LoadError compact message="The people list didn't load." onRetry={loadPeople} style={{ marginTop: 4 }} />}</Field>
          <Field label="Founder owner">
            <select style={inp} value={edit.founder_owner_employee_id || ''} onChange={e => setEdit(s => ({ ...s, founder_owner_employee_id: e.target.value }))}>
              <option value="">{edit.parent_department_id ? 'Same as parent team' : 'Both'}</option>
              {founders.map(f => <option key={f.id} value={f.id}>{f.full_name}</option>)}
            </select>
            <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 4 }}>Skip-level approver for anyone in this team whose manager is to be hired.</div>
          </Field>
          <Field label="Parent department"><Combobox value={edit.parent_department_id || ''} onChange={v => setEdit(s => ({ ...s, parent_department_id: v }))} inputStyle={comboInp} placeholder="Search department…" options={teamOptions(rows, edit.id)} /></Field>
          <Field label="Description"><input style={inp} value={edit.description || ''} onChange={e => setEdit(s => ({ ...s, description: e.target.value }))} /></Field>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--t2)' }}><input type="checkbox" checked={edit.active !== false} onChange={e => setEdit(s => ({ ...s, active: e.target.checked }))} /> Active</label>
        </>}
      </Modal>
    </div>
  );
}

const inp = { width: '100%', background: 'var(--bg)', color: 'var(--t1)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '9px 11px', fontFamily: 'var(--font-ui)', fontSize: 13, outline: 'none' };
const comboInp = { fontFamily: 'var(--font-ui)', fontSize: 13, padding: '9px 11px' };
function Field({ label, children }) { return <label style={{ display: 'block', marginBottom: 12 }}><div style={formLabel}>{label}</div>{children}</label>; }
