'use client';
import { useEffect, useState } from 'react';
import { useToast, Combobox } from '@throttle/ui';
import { useAuth } from '@throttle/auth';
import { podiumopsGet, podiumopsPost } from '../lib/podiumopsFetch.js';
import { EMPLOYMENT_TYPES, EMPLOYEE_STATUSES, LEGAL_ENTITIES, GENDER_OPTIONS, BLOOD_GROUPS, teamOptions } from '../lib/format.js';
import { formLabel, cardLabel, btnPrimary, btnGhost } from './ui.js';
import { LEAVE_POLICIES } from '../lib/leave.js';

// Shared create/edit form (Pit Wall v2). `initial` (with .id) → edit mode; else create.
export default function EmployeeForm({ session, initial, onSaved, onCancel }) {
  const { showToast } = useToast();
  const { perms } = useAuth();
  const editing = !!initial?.id;
  // Leave R1 (D1): the leave policy is HR's field. It is sent only by HR, and on an edit only when the loaded row
  // carried the column — so a stale read can never null out a seeded policy.
  const leaveField = !!perms?.podium_hr && (!editing || (initial && 'leave_policy' in initial));
  const [f, setF] = useState(() => seed(initial));
  const [depts, setDepts] = useState([]);
  const [founders, setFounders] = useState([]);
  const [levels, setLevels] = useState([]);
  const [people, setPeople] = useState([]);
  // J1b D5: the Google org unit Podium owns. Options = Google's live OUs minus the excluded ones (getOrgUnitOptions);
  // the department's usual OU is suggested when the department changes.
  const [ouOpts, setOuOpts] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!session) return;
    Promise.all([
      podiumopsGet('getDepartments', {}, session).catch(() => ({ departments: [] })),
      podiumopsGet('listLevels', {}, session).catch(() => ({ levels: [] })),
      podiumopsGet('getEmployees', { status: 'all', limit: 2000 }, session).catch(() => ({ employees: [] })),
    ]).then(([d, l, e]) => { setDepts(d.departments || []); setFounders(d.founders || []); setLevels(l.levels || []); setPeople(e.employees || []); });
    podiumopsGet('getOrgUnitOptions', {}, session)
      .then(o => setOuOpts(o || { ous: [], default_by_department: {} }))
      .catch(() => setOuOpts({ ous: [], default_by_department: {}, error: true }));
  }, [session]);

  function set(k, v) { setF(prev => ({ ...prev, [k]: v })); }
  // A vacant manager seat ("To be hired") clears the manager; the worker enforces the same (never both).
  function setToBeHired(on) { setF(prev => ({ ...prev, manager_to_be_hired: on, ...(on ? { manager_id: '' } : {}) })); }
  // Skip-level for a vacant seat = the founder owner of the team (a sub-team with none inherits its parent's);
  // none up the chain → the worker's approver is null and HR decides. Mirrors teamFounderOwner in the worker's leave.js.
  const skipLevel = (() => {
    if (!f.manager_to_be_hired) return null;
    const byId = new Map(depts.map(d => [d.id, d]));
    let d = f.department_id ? byId.get(f.department_id) : null;
    for (let i = 0; d && i < 25; i++) {
      if (d.founder_owner_employee_id) return d.founder_owner?.full_name || founders.find(x => x.id === d.founder_owner_employee_id)?.full_name || 'Founder';
      d = d.parent_department_id ? byId.get(d.parent_department_id) : null;
    }
    return 'HR (no founder owner on this team)';
  })();
  // A department change pre-fills its usual org unit, but only over a blank OU or the OLD department's suggestion:
  // an OU HR picked by hand is never replaced. HR can still pick another one.
  function setDepartment(v) {
    setF(prev => {
      if (v === prev.department_id) return prev;
      const byDept = ouOpts?.default_by_department || {};
      const oldSug = prev.department_id ? byDept[prev.department_id] || null : null;
      const sug = v ? byDept[v] || null : null;
      const take = !!sug && (!prev.org_unit_path || prev.org_unit_path === oldSug);
      return { ...prev, department_id: v, ...(take ? { org_unit_path: sug } : {}) };
    });
  }
  const ouSuggested = f.department_id ? ouOpts?.default_by_department?.[f.department_id] || null : null;
  const ouList = (() => {
    const l = [...(ouOpts?.ous || [])];
    if (f.org_unit_path && !l.includes(f.org_unit_path)) l.unshift(f.org_unit_path);   // keep the current value visible
    return l;
  })();

  async function save() {
    if (!f.full_name?.trim()) { showToast('Full name is required', 'error'); return; }
    setBusy(true);
    try {
      const payload = clean(f, leaveField);
      // Create: leave_policy rides only when HR picked a policy (the column's default is already null = not covered).
      if (!editing && !payload.leave_policy) delete payload.leave_policy;
      if (editing) {
        const r = await podiumopsPost('updateEmployee', { employee_id: initial.id, patch: payload }, session);
        toastSaved(showToast, 'Saved', r?.google_sync);
        onSaved && onSaved(initial.id);
      } else {
        const r = await podiumopsPost('createEmployee', payload, session);
        toastSaved(showToast, 'Employee created', r?.google_sync);
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
          <Field label="Level"><Select value={f.level_id || ''} onChange={e => set('level_id', e.target.value)}><option value="">—</option>{levels.map(l => <option key={l.id} value={l.id}>{l.code} · {l.name}</option>)}</Select></Field>
          <Field label="Department"><Combobox value={f.department_id || ''} onChange={setDepartment} inputStyle={comboInp} placeholder="Search department…" options={teamOptions(depts)} /></Field>
          <Field label="Google org unit">
            {ouOpts && ouList.length > 0 ? (
              <Select value={f.org_unit_path || ''} onChange={e => set('org_unit_path', e.target.value)}>
                <option value="">Not set (Google keeps its own)</option>
                {ouList.map(ou => <option key={ou} value={ou}>{ou}{ou === ouSuggested ? '  (usual for this department)' : ''}</option>)}
              </Select>
            ) : (
              <Input value={f.org_unit_path || ''} disabled placeholder={ouOpts ? 'Google org units unavailable' : 'Loading…'} />
            )}
            <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 4 }}>Podium pushes this to Google on save. Org units with nobody in them yet don&apos;t appear.</div>
          </Field>
          {/* Job role is hidden (Title / Level / Team, 2026-11-14); job_role_id still round-trips unchanged. */}
          <div>
            <div style={formLabel}>Manager</div>
            <Combobox value={f.manager_to_be_hired ? '' : (f.manager_id || '')} onChange={v => set('manager_id', v)} disabled={!!f.manager_to_be_hired} inputStyle={comboInp}
              placeholder={f.manager_to_be_hired ? 'To be hired' : 'Search manager…'} options={people.filter(p => p.id !== initial?.id).map(p => ({ value: p.id, label: p.full_name, hint: p.employee_code || '' }))} />
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--t2)', marginTop: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={!!f.manager_to_be_hired} onChange={e => setToBeHired(e.target.checked)} /> To be hired
            </label>
            {skipLevel && <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 4 }}>Skip-level: {skipLevel}</div>}
          </div>
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
          {/* X1: exits happen ONLY through the Exit panel on the person's page (the worker refuses a hand-set
              exited / notice status and any last-working-day or reason change — use_exit_flow). So the select
              offers neither; an exited person's status, date and reason show read-only. */}
          <Field label="Status">
            {f.status === 'exited'
              ? <Input value="Exited" disabled />
              : <Select value={f.status} onChange={e => set('status', e.target.value)}>{EMPLOYEE_STATUSES.filter(s => (s.id !== 'exited' && s.id !== 'notice') || s.id === f.status).map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</Select>}
            {editing && f.status !== 'exited' && (
              <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 4 }}>To exit someone, use the Exit panel on their profile.</div>
            )}
          </Field>
          {leaveField && (
            <Field label="Leave policy">
              <Select value={f.leave_policy || ''} onChange={e => set('leave_policy', e.target.value)}>
                {LEAVE_POLICIES.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
              </Select>
              <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 4 }}>Covered people apply for leave in Podium and earn 1.5 PL + 1 SL a month.</div>
            </Field>
          )}
          {f.status === 'exited' && <>
            <Field label="Last working day"><Input type="date" mono value={f.date_exited} disabled /></Field>
            <Field label="Exit reason"><Input value={f.exit_reason} disabled /></Field>
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
  'job_title', 'level_id', 'department_id', 'org_unit_path', 'job_role_id', 'manager_id', 'manager_to_be_hired', 'secondary_manager_id', 'employment_type', 'legal_entity', 'work_location',
  'date_joined', 'probation_end_date', 'confirmed_at', 'status', 'date_exited', 'exit_reason',
  'emergency_contact_name', 'emergency_contact_phone', 'leave_policy'];

function seed(initial) {
  const o = {};
  for (const k of FIELDS) o[k] = initial?.[k] ?? '';
  o.manager_to_be_hired = !!initial?.manager_to_be_hired;
  if (!initial) o.status = 'active';
  return o;
}
// date_exited / exit_reason are shown, never sent: only the exit flow writes them (X1).
const READ_ONLY = new Set(['date_exited', 'exit_reason']);
function clean(f, leaveField) {
  const o = {};
  for (const k of FIELDS) if (!READ_ONLY.has(k)) o[k] = f[k] === '' ? null : f[k];
  if (!leaveField) delete o.leave_policy;
  return o;
}

// J1b D7: the save never fails because Google did; say so when the push did not go through.
function toastSaved(showToast, msg, gs) {
  if (gs?.status === 'failed') showToast(`${msg}. Google not updated: ${gs.error || 'push failed'}. Retry from the profile.`, 'error');
  else if (gs?.status === 'pending') showToast(`${msg}. Google update pending.`, 'success');
  else showToast(msg, 'success');
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
