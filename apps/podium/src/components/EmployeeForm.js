'use client';
import { useEffect, useState } from 'react';
import { useToast, Combobox } from '@throttle/ui';
import { podiumopsGet, podiumopsPost } from '../lib/podiumopsFetch.js';
import { EMPLOYMENT_TYPES, EMPLOYEE_STATUSES, LEGAL_ENTITIES, GENDER_OPTIONS, BLOOD_GROUPS } from '../lib/format.js';
import { formLabel, cardLabel, btnPrimary, btnGhost } from './ui.js';

// Shared create/edit form (Pit Wall v2). `initial` (with .id) → edit mode; else create.
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Section title="Identity">
        <div style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 16, marginTop: -4 }}>Employee code auto-generates as LOT-####. They appear in the directory as Active once saved.</div>
        <Grid>
          <Field label="Full name *"><Input value={f.full_name} onChange={e => set('full_name', e.target.value)} placeholder="e.g. Neha Sharma" /></Field>
          <Field label="Preferred name"><Input value={f.preferred_name} onChange={e => set('preferred_name', e.target.value)} placeholder="Neha" /></Field>
          <Field label="Work email"><Input value={f.work_email} onChange={e => set('work_email', e.target.value)} placeholder="name@legendoftoys.com" /></Field>
          <Field label="Personal email"><Input value={f.personal_email} onChange={e => set('personal_email', e.target.value)} /></Field>
          <Field label="Phone"><Input value={f.phone} onChange={e => set('phone', e.target.value)} /></Field>
          <Field label="Date of birth"><Input type="date" mono value={f.date_of_birth} onChange={e => set('date_of_birth', e.target.value)} /></Field>
          <Field label="Gender"><Select value={f.gender} onChange={e => set('gender', e.target.value)}><option value="">—</option>{GENDER_OPTIONS.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}</Select></Field>
          <Field label="Blood group"><Select value={f.blood_group} onChange={e => set('blood_group', e.target.value)}><option value="">—</option>{BLOOD_GROUPS.map(b => <option key={b} value={b}>{b}</option>)}</Select></Field>
          <Field label="PAN"><Input value={f.pan_number} onChange={e => set('pan_number', e.target.value.toUpperCase())} placeholder="ABCDE1234F" /></Field>
          <Field label="Photo URL"><Input value={f.photo_url} onChange={e => set('photo_url', e.target.value)} /></Field>
        </Grid>
      </Section>

      <Section title="Role & Reporting">
        <Grid>
          <Field label="Job title"><Input value={f.job_title} onChange={e => set('job_title', e.target.value)} placeholder="e.g. Account Manager" /></Field>
          <Field label="Department"><Combobox value={f.department_id || ''} onChange={v => set('department_id', v)} inputStyle={comboInp} placeholder="Search department…" options={depts.map(d => ({ value: d.id, label: d.name }))} /></Field>
          <Field label="Job role"><Combobox value={f.job_role_id || ''} onChange={v => set('job_role_id', v)} inputStyle={comboInp} placeholder="Search role…" options={roles.map(r => ({ value: r.id, label: r.title, hint: r.level || '' }))} /></Field>
          <Field label="Manager"><Combobox value={f.manager_id || ''} onChange={v => set('manager_id', v)} inputStyle={comboInp} placeholder="Search manager…" options={people.filter(p => p.id !== initial?.id).map(p => ({ value: p.id, label: p.full_name, hint: p.employee_code || '' }))} /></Field>
          <Field label="Secondary manager (dotted line)"><Combobox value={f.secondary_manager_id || ''} onChange={v => set('secondary_manager_id', v)} inputStyle={comboInp} placeholder="Search dotted-line manager…" options={people.filter(p => p.id !== initial?.id && p.id !== f.manager_id).map(p => ({ value: p.id, label: p.full_name, hint: p.employee_code || '' }))} /></Field>
          <Field label="Employment type">
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {EMPLOYMENT_TYPES.map(t => {
                const on = f.employment_type === t.id;
                return (
                  <span key={t.id} onClick={() => set('employment_type', on ? '' : t.id)} style={{
                    flex: '1 1 auto', textAlign: 'center', fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 600,
                    letterSpacing: '0.04em', textTransform: 'uppercase', padding: '9px 10px', borderRadius: 6, cursor: 'pointer', userSelect: 'none',
                    background: on ? 'var(--yellow)' : 'var(--bg)', color: on ? '#1b1b1e' : 'var(--t2)', border: on ? '1px solid var(--yellow)' : '1px solid var(--border)',
                  }}>{t.label}</span>
                );
              })}
            </div>
          </Field>
          <Field label="Legal entity"><Select value={f.legal_entity} onChange={e => set('legal_entity', e.target.value)}><option value="">—</option>{LEGAL_ENTITIES.map(x => <option key={x} value={x}>{x}</option>)}</Select></Field>
          <Field label="Work location"><Input value={f.work_location} onChange={e => set('work_location', e.target.value)} /></Field>
        </Grid>
      </Section>

      <Section title="Lifecycle">
        <Grid>
          <Field label="Date joined"><Input type="date" mono value={f.date_joined} onChange={e => set('date_joined', e.target.value)} /></Field>
          <Field label="Probation end"><Input type="date" mono value={f.probation_end_date} onChange={e => set('probation_end_date', e.target.value)} /></Field>
          <Field label="Confirmed on"><Input type="date" mono value={f.confirmed_at} onChange={e => set('confirmed_at', e.target.value)} /></Field>
          <Field label="Status"><Select value={f.status} onChange={e => set('status', e.target.value)}>{EMPLOYEE_STATUSES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</Select></Field>
          {f.status === 'exited' && <>
            <Field label="Date exited"><Input type="date" mono value={f.date_exited} onChange={e => set('date_exited', e.target.value)} /></Field>
            <Field label="Exit reason"><Input value={f.exit_reason} onChange={e => set('exit_reason', e.target.value)} /></Field>
          </>}
        </Grid>
      </Section>

      <Section title="Emergency Contact">
        <Grid>
          <Field label="Name"><Input value={f.emergency_contact_name} onChange={e => set('emergency_contact_name', e.target.value)} /></Field>
          <Field label="Phone"><Input value={f.emergency_contact_phone} onChange={e => set('emergency_contact_phone', e.target.value)} /></Field>
        </Grid>
      </Section>

      <div style={{ display: 'flex', gap: 10 }}>
        <button onClick={save} disabled={busy} style={{ ...btnPrimary, padding: '9px 18px', opacity: busy ? 0.7 : 1, cursor: busy ? 'wait' : 'pointer' }}>{busy ? 'Saving…' : (editing ? 'Save changes' : 'Create Person')}</button>
        {onCancel && <button onClick={onCancel} style={{ ...btnGhost, padding: '9px 18px' }}>Cancel</button>}
      </div>
    </div>
  );
}

const FIELDS = ['full_name', 'preferred_name', 'work_email', 'personal_email', 'phone', 'date_of_birth', 'gender', 'blood_group', 'pan_number', 'photo_url',
  'job_title', 'department_id', 'job_role_id', 'manager_id', 'secondary_manager_id', 'employment_type', 'legal_entity', 'work_location',
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
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: '18px 20px' }}>
      <div style={cardLabel}>{title}</div>
      {children}
    </div>
  );
}
function Grid({ children }) { return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px 18px' }}>{children}</div>; }
function Field({ label, children }) {
  return <label style={{ display: 'block' }}><div style={formLabel}>{label}</div>{children}</label>;
}
function Input({ mono, ...rest }) {
  return <input className="pd-input" style={{ ...inp, fontFamily: mono ? 'var(--font-num)' : 'var(--font-ui)' }} {...rest} />;
}
function Select({ children, ...rest }) {
  return <select className="pd-input" style={inp} {...rest}>{children}</select>;
}
const inp = { width: '100%', background: 'var(--bg)', color: 'var(--t1)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '9px 11px', fontFamily: 'var(--font-ui)', fontSize: 13, outline: 'none' };
const comboInp = { fontFamily: 'var(--font-ui)', fontSize: 13, padding: '9px 11px' };
