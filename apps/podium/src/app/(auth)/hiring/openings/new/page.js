'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { useToast, Combobox } from '@throttle/ui';
import { ArrowLeft, Save, Info } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../../../../../lib/podiumopsFetch.js';
import { Card, F, Row, Note, JdInput, jdProvided, submitJd, inp, comboInp, backBtn, primaryBtn, ghostBtn, muted } from '../../../../../components/HiringBits.js';
import { HIRING_EMPLOYMENT_TYPES, hiringError, idOf, numOrNull, formatINR } from '../../../../../lib/hiring.js';

export default function NewOpeningPage() {
  const { session, brandUser } = useAuth();
  const router = useRouter();
  const { showToast } = useToast();
  const [roles, setRoles] = useState([]);
  const [depts, setDepts] = useState([]);
  const [emps, setEmps] = useState([]);
  const [busy, setBusy] = useState(false);
  const isHiring = !!brandUser?.permissions?.podium_hiring;
  // A role's band is allow-list data; the worker refuses band_from_role without it (403).
  const canUseRoleBand = !!brandUser?.tier?.comp;
  const [f, setF] = useState({
    job_role_id: '', designation: '', department_id: '',
    reporting_manager_employee_id: '', hiring_owner_employee_id: '',
    location_city: 'Bangalore', location_state: 'Karnataka', employment_type: 'full_time',
    headcount: '1', target_join_date: '', notes: '',
    band_mode: 'manual', band_min: '', band_max: '',
  });
  const [jd, setJd] = useState({ mode: 'none', text: '', file: null });
  const set = (k, v) => setF(s => ({ ...s, [k]: v }));

  useEffect(() => {
    if (!session) return;
    // getHiringLookups is self-serve (most hiring managers hold no podium_view) and never returns bands.
    podiumopsGet('getHiringLookups', {}, session).then(d => {
      setRoles(d.job_roles || []); setDepts(d.departments || []); setEmps(d.employees || []);
    }).catch(() => {});
  }, [session]);

  // Reporting manager defaults to the caller (the common case: a manager hiring into their team).
  useEffect(() => {
    if (brandUser?.employee_id) setF(s => (s.reporting_manager_employee_id ? s : { ...s, reporting_manager_employee_id: brandUser.employee_id }));
  }, [brandUser?.employee_id]);

  const role = useMemo(() => roles.find(r => r.id === f.job_role_id) || null, [roles, f.job_role_id]);
  const roleHasBand = !!role?.has_band;
  const roleHasJd = !!role?.has_jd;
  const empOpts = emps.map(e => ({ value: e.id, label: e.full_name, hint: e.employee_code }));

  function pickRole(id) {
    const r = roles.find(x => x.id === id);
    setF(s => ({
      ...s, job_role_id: id,
      designation: s.designation || r?.title || '',
      department_id: s.department_id || r?.department_id || r?.department?.id || '',
    }));
  }

  async function save() {
    if (!f.designation.trim()) { showToast('Designation is required', 'error'); return; }
    if (!f.reporting_manager_employee_id) { showToast('Reporting manager is required', 'error'); return; }
    const useRoleBand = canUseRoleBand && f.band_mode === 'role';
    const bmin = numOrNull(f.band_min), bmax = numOrNull(f.band_max);
    if (useRoleBand && !f.job_role_id) { showToast("Pick a job role to use the role's band", 'error'); return; }
    if (!useRoleBand && (bmin == null || bmax == null)) { showToast('Band min and max are required', 'error'); return; }
    if (!useRoleBand && bmax < bmin) { showToast('Band max must be ≥ band min', 'error'); return; }
    if (jd.mode === 'role' && !f.job_role_id) { showToast("Pick a job role to use the role's JD", 'error'); return; }

    const body = {
      job_role_id: f.job_role_id || null,
      designation: f.designation.trim(),
      department_id: f.department_id || null,
      reporting_manager_employee_id: f.reporting_manager_employee_id,
      location_city: f.location_city || null,
      location_state: f.location_state || null,
      employment_type: f.employment_type,
      headcount: Math.round(Number(f.headcount) || 1),
      target_join_date: f.target_join_date || null,
      notes: f.notes || null,
    };
    // Only podium_hiring may name another owner; everyone else defaults to themselves (worker rule).
    if (isHiring && f.hiring_owner_employee_id) body.hiring_owner_employee_id = f.hiring_owner_employee_id;
    if (useRoleBand) body.band_from_role = true; else { body.band_min = bmin; body.band_max = bmax; }
    if (jd.mode === 'text' && jd.text.trim()) body.jd_text = jd.text.trim();
    if (jd.mode === 'role') body.use_role_jd = true;

    setBusy(true);
    try {
      const r = await podiumopsPost('createOpening', body, session);
      const id = idOf(r, 'opening');
      // A file JD needs the opening id for its storage path → upload after create.
      if (id && jd.mode === 'file' && jd.file) {
        try { await submitJd(id, jd, session); }
        catch (e) { showToast(`Opening created, but the JD upload failed: ${hiringError(e)}`, 'error'); }
      }
      showToast('Opening created — band sent for approval', 'success');
      router.push(id ? `/hiring/openings/detail/?id=${id}` : '/hiring/openings');
    } catch (e) { showToast(hiringError(e, 'Could not create the opening'), 'error'); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ maxWidth: 900 }}>
      <button onClick={() => router.back()} style={{ ...backBtn, marginBottom: 14 }}><ArrowLeft size={14} /> Back</button>
      <Note tone="info"><Info size={13} /> Without a JD the opening stays a draft and no CVs can be added. You can add the JD later.</Note>

      <div style={{ display: 'grid', gap: 14 }}>
        <Card title="Role">
          <Row>
            <F label="Job role (optional — prefills designation + department)">
              <Combobox value={f.job_role_id} onChange={pickRole} inputStyle={comboInp} placeholder="Search job role…"
                options={roles.filter(r => r.active !== false).map(r => ({ value: r.id, label: r.title, hint: r.role_code || r.level || '' }))} />
            </F>
            <F label="Designation *"><input style={inp} value={f.designation} onChange={e => set('designation', e.target.value)} /></F>
          </Row>
          <Row>
            <F label="Department">
              <Combobox value={f.department_id} onChange={v => set('department_id', v)} inputStyle={comboInp} placeholder="Search department…"
                options={depts.map(d => ({ value: d.id, label: d.name }))} />
            </F>
            <F label="Type">
              <select style={inp} value={f.employment_type} onChange={e => set('employment_type', e.target.value)}>
                {HIRING_EMPLOYMENT_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </F>
            <F label="Headcount" style={{ maxWidth: 110 }}><input type="number" min={1} max={100} style={inp} value={f.headcount} onChange={e => set('headcount', e.target.value)} /></F>
          </Row>
          <Row>
            <F label="City"><input style={inp} value={f.location_city} onChange={e => set('location_city', e.target.value)} /></F>
            <F label="State"><input style={inp} value={f.location_state} onChange={e => set('location_state', e.target.value)} /></F>
            <F label="Target join date"><input type="date" style={inp} value={f.target_join_date} onChange={e => set('target_join_date', e.target.value)} /></F>
          </Row>
          <F label="Notes"><textarea rows={2} style={{ ...inp, resize: 'vertical' }} value={f.notes} onChange={e => set('notes', e.target.value)} /></F>
        </Card>

        <Card title="Team">
          <Row>
            <F label="Reporting manager *">
              <Combobox value={f.reporting_manager_employee_id} onChange={v => set('reporting_manager_employee_id', v)} inputStyle={comboInp} placeholder="Search people…" options={empOpts} />
            </F>
            <F label={isHiring ? 'Hiring owner (defaults to you)' : 'Hiring owner'}>
              {isHiring
                ? <Combobox value={f.hiring_owner_employee_id} onChange={v => set('hiring_owner_employee_id', v)} inputStyle={comboInp} placeholder="You" options={empOpts} />
                : <input style={inp} disabled value={brandUser?.fullName || 'You'} />}
            </F>
          </Row>
          <div style={muted}>The band is approved by the reporting manager's manager (a founder when that is you or there is none).</div>
        </Card>

        <Card title="Salary band — annual total CTC (INR) *">
          <div style={{ display: 'flex', gap: 14, marginBottom: 10, fontSize: 13 }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="radio" checked={f.band_mode === 'manual'} onChange={() => set('band_mode', 'manual')} /> Enter a band</label>
            {canUseRoleBand && (
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', opacity: f.job_role_id ? 1 : 0.5 }}>
                <input type="radio" disabled={!f.job_role_id} checked={f.band_mode === 'role'} onChange={() => set('band_mode', 'role')} /> Use the role's band
              </label>
            )}
          </div>
          {!(canUseRoleBand && f.band_mode === 'role') ? (
            <Row>
              <F label="Band min"><input style={inp} inputMode="numeric" value={f.band_min} onChange={e => set('band_min', e.target.value)} placeholder="e.g. 600000" /></F>
              <F label="Band max"><input style={inp} inputMode="numeric" value={f.band_max} onChange={e => set('band_max', e.target.value)} placeholder="e.g. 900000" /></F>
            </Row>
          ) : (
            <div style={muted}>
              {roleHasBand ? "The role's band is copied when you save; you'll see it on the opening."
                : 'This role has no band set — enter one instead.'}
            </div>
          )}
        </Card>

        <Card title="Job description">
          <JdInput value={jd} onChange={setJd} allowNone allowRole={!!f.job_role_id} />
          {jd.mode === 'role' && role && !roleHasJd && <div style={{ ...muted, marginTop: 6, color: 'var(--warn-fg)' }}>This role has no JD text yet.</div>}
          {!jdProvided(jd) && jd.mode !== 'none' && <div style={{ ...muted, marginTop: 6 }}>Nothing entered — the opening will start as a draft.</div>}
        </Card>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={() => router.back()} style={ghostBtn} disabled={busy}>Cancel</button>
          <button onClick={save} style={{ ...primaryBtn, opacity: busy ? 0.6 : 1 }} disabled={busy}><Save size={14} /> {busy ? 'Creating…' : 'Create opening'}</button>
        </div>
      </div>
    </div>
  );
}
