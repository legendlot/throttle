'use client';
import { useEffect, useState } from 'react';
import { useToast } from '@throttle/ui';
import { podiumopsGet, podiumopsPost } from '../lib/podiumopsFetch.js';
import { EMPLOYMENT_TYPES, EMPLOYEE_STATUSES, LEGAL_ENTITIES } from '../lib/format.js';

// Shared create/edit form. `initial` (with .id) → edit mode; else create.
export default function EmployeeForm({ session, initial, onSaved, onCancel }) {
  const { showToast } = useToast();
  const editing = !!initial?.id;
  const [f, setF] = useState(() => seed(initial));
  const [depts, setDepts] = useState([]);
  const [roles, setRoles] = useState([]);
  const [people, setPeople] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!session) return;
    Promise.all([
      podiumopsGet('getDepartments', {}, session).catch(() => ({ departments: [] })),
      podiumopsGet('getJobRoles', {}, session).catch(() => ({ job_roles: [] })),
      podiumopsGet('getEmployees', { status: 'all', limit: 2000 }, session).catch(() => ({ employees: [] })),
    ]).then(([d, r, e]) => { setDepts(d.departments || []); setRoles(r.job_roles || []); setPeople(e.employees || []); });
  }, [session]);

  function set(k, v) { setF(prev => ({ ...prev, [k]: v })); }

  async function save() {
    if (!f.full_name?.trim()) { showToast('Full name is required', 'error'); return; }
    setBusy(true);
    try {
      const payload = clean(f);
      if (editing) {
        await podiumopsPost('updateEmployee', { employee_id: initial.id, patch: payload }, session);
        showToast('Saved', 'success');
        onSaved && onSaved(initial.id);
      } else {
        const r = await podiumopsPost('createEmployee', payload, session);
        showToast('Employee created', 'success');
        onSaved && onSaved(r?.id);
      }
    } catch (e) {
      showToast(e.message || 'Save failed', 'error');
    } finally { setBusy(false); }
  }

  return (
    <div>
      <Section title="Identity">
        <Grid>
          <Field label="Full name *"><input style={inp} value={f.full_name} onChange={e => set('full_name', e.target.value)} /></Field>
          <Field label="Preferred name"><input style={inp} value={f.preferred_name} onChange={e => set('preferred_name', e.target.value)} /></Field>
          <Field label="Work email"><input style={inp} value={f.work_email} onChange={e => set('work_email', e.target.value)} /></Field>
          <Field label="Personal email"><input style={inp} value={f.personal_email} onChange={e => set('personal_email', e.target.value)} /></Field>
          <Field label="Phone"><input style={inp} value={f.phone} onChange={e => set('phone', e.target.value)} /></Field>
          <Field label="Date of birth"><input type="date" style={inp} value={f.date_of_birth} onChange={e => set('date_of_birth', e.target.value)} /></Field>
          <Field label="Photo URL"><input style={inp} value={f.photo_url} onChange={e => set('photo_url', e.target.value)} /></Field>
        </Grid>
      </Section>

      <Section title="Role & Reporting">
        <Grid>
          <Field label="Job title"><input style={inp} value={f.job_title} onChange={e => set('job_title', e.target.value)} /></Field>
          <Field label="Department">
            <select style={inp} value={f.department_id} onChange={e => set('department_id', e.target.value)}>
              <option value="">—</option>{depts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </Field>
          <Field label="Job role">
            <select style={inp} value={f.job_role_id} onChange={e => set('job_role_id', e.target.value)}>
              <option value="">—</option>{roles.map(r => <option key={r.id} value={r.id}>{r.title}</option>)}
            </select>
          </Field>
          <Field label="Manager">
            <select style={inp} value={f.manager_id} onChange={e => set('manager_id', e.target.value)}>
              <option value="">—</option>{people.filter(p => p.id !== initial?.id).map(p => <option key={p.id} value={p.id}>{p.full_name}</option>)}
            </select>
          </Field>
          <Field label="Employment type">
            <select style={inp} value={f.employment_type} onChange={e => set('employment_type', e.target.value)}>
              <option value="">—</option>{EMPLOYMENT_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </Field>
          <Field label="Legal entity">
            <select style={inp} value={f.legal_entity} onChange={e => set('legal_entity', e.target.value)}>
              <option value="">—</option>{LEGAL_ENTITIES.map(x => <option key={x} value={x}>{x}</option>)}
            </select>
          </Field>
          <Field label="Work location"><input style={inp} value={f.work_location} onChange={e => set('work_location', e.target.value)} /></Field>
        </Grid>
      </Section>

      <Section title="Lifecycle">
        <Grid>
          <Field label="Date joined"><input type="date" style={inp} value={f.date_joined} onChange={e => set('date_joined', e.target.value)} /></Field>
          <Field label="Probation end"><input type="date" style={inp} value={f.probation_end_date} onChange={e => set('probation_end_date', e.target.value)} /></Field>
          <Field label="Confirmed on"><input type="date" style={inp} value={f.confirmed_at} onChange={e => set('confirmed_at', e.target.value)} /></Field>
          <Field label="Status">
            <select style={inp} value={f.status} onChange={e => set('status', e.target.value)}>
              {EMPLOYEE_STATUSES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </Field>
          {f.status === 'exited' && <>
            <Field label="Date exited"><input type="date" style={inp} value={f.date_exited} onChange={e => set('date_exited', e.target.value)} /></Field>
            <Field label="Exit reason"><input style={inp} value={f.exit_reason} onChange={e => set('exit_reason', e.target.value)} /></Field>
          </>}
        </Grid>
      </Section>

      <Section title="Emergency Contact">
        <Grid>
          <Field label="Name"><input style={inp} value={f.emergency_contact_name} onChange={e => set('emergency_contact_name', e.target.value)} /></Field>
          <Field label="Phone"><input style={inp} value={f.emergency_contact_phone} onChange={e => set('emergency_contact_phone', e.target.value)} /></Field>
        </Grid>
      </Section>

      <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
        <button onClick={save} disabled={busy} style={primaryBtn(busy)}>{busy ? 'Saving…' : (editing ? 'Save changes' : 'Create person')}</button>
        {onCancel && <button onClick={onCancel} style={ghostBtn}>Cancel</button>}
      </div>
    </div>
  );
}

const FIELDS = ['full_name', 'preferred_name', 'work_email', 'personal_email', 'phone', 'date_of_birth', 'photo_url',
  'job_title', 'department_id', 'job_role_id', 'manager_id', 'employment_type', 'legal_entity', 'work_location',
  'date_joined', 'probation_end_date', 'confirmed_at', 'status', 'date_exited', 'exit_reason',
  'emergency_contact_name', 'emergency_contact_phone'];

function seed(initial) {
  const o = {};
  for (const k of FIELDS) o[k] = initial?.[k] ?? '';
  if (!initial) o.status = 'active';
  return o;
}
function clean(f) {
  const o = {};
  for (const k of FIELDS) o[k] = f[k] === '' ? null : f[k];
  return o;
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 11, color: 'var(--text-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600, marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}
function Grid({ children }) { return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>{children}</div>; }
function Field({ label, children }) {
  return <label style={{ display: 'block' }}><div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 4 }}>{label}</div>{children}</label>;
}
const inp = { width: '100%', background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '7px 10px', fontFamily: 'var(--font-mono)', fontSize: 13 };
const primaryBtn = (busy) => ({ background: 'var(--podium-accent)', color: '#1f1f1f', border: 'none', borderRadius: 'var(--radius-sm)', padding: '10px 20px', fontWeight: 700, fontSize: 13, letterSpacing: '0.04em', textTransform: 'uppercase', cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.7 : 1 });
const ghostBtn = { background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '10px 20px', fontSize: 13, cursor: 'pointer' };
