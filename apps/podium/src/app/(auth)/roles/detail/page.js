'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { ArrowLeft, Plus, Trash2, Save } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../../../../lib/podiumopsFetch.js';
import { fmtMoney } from '../../../../lib/format.js';

export default function RoleDetailPage() {
  const { session, perms } = useAuth();
  const router = useRouter();
  const id = useSearchParams().get('id');
  const { showToast } = useToast();
  const [data, setData] = useState(null);
  const [depts, setDepts] = useState([]);
  const [jd, setJd] = useState(null);
  const [kpis, setKpis] = useState([]);
  const [busy, setBusy] = useState(false);
  const canManage = !!perms?.podium_hr;
  const canComp = !!(perms?.podium_comp || perms?.podium_admin);

  const load = useCallback(() => {
    if (!session || !id) return;
    podiumopsGet('getJobRole', { id }, session).then(d => {
      setData(d);
      setJd({
        title: d.job_role.title || '', role_code: d.job_role.role_code || '', level: d.job_role.level || '',
        department_id: d.job_role.department_id || '', summary: d.job_role.summary || '',
        job_description: d.job_role.job_description || '', responsibilities: (d.job_role.responsibilities || []).join('\n'),
        active: d.job_role.active !== false,
        salary_band_min: d.job_role.salary_band_min ?? '', salary_band_mid: d.job_role.salary_band_mid ?? '', salary_band_max: d.job_role.salary_band_max ?? '',
      });
      setKpis(d.kpis || []);
    }).catch(() => setData(false));
  }, [session, id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (session) podiumopsGet('getDepartments', {}, session).then(d => setDepts(d.departments || [])).catch(() => {}); }, [session]);

  async function saveJd() {
    setBusy(true);
    try {
      const patch = {
        title: jd.title, role_code: jd.role_code || null, level: jd.level || null,
        department_id: jd.department_id || null, summary: jd.summary || null,
        job_description: jd.job_description || null,
        responsibilities: jd.responsibilities.split('\n').map(s => s.trim()).filter(Boolean),
        active: jd.active,
      };
      if (canComp) {
        patch.salary_band_min = jd.salary_band_min === '' ? null : Number(jd.salary_band_min);
        patch.salary_band_mid = jd.salary_band_mid === '' ? null : Number(jd.salary_band_mid);
        patch.salary_band_max = jd.salary_band_max === '' ? null : Number(jd.salary_band_max);
      }
      await podiumopsPost('updateJobRole', { job_role_id: id, patch }, session);
      showToast('Saved', 'success'); load();
    } catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }
  async function saveKpis() {
    setBusy(true);
    try {
      await podiumopsPost('setRoleKpis', { job_role_id: id, kpis }, session);
      showToast('KPIs saved', 'success'); load();
    } catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }
  const addKpi = () => setKpis(k => [...k, { name: '', description: '', metric_type: 'quantitative', target: '', weight: '' }]);
  const setKpi = (i, key, v) => setKpis(k => k.map((x, j) => j === i ? { ...x, [key]: v } : x));
  const delKpi = (i) => setKpis(k => k.filter((_, j) => j !== i));

  if (data === false) return <div style={{ color: 'var(--text-3)' }}>Not found.</div>;
  if (!data || !jd) return <Spinner />;

  return (
    <div style={{ maxWidth: 980 }}>
      <button onClick={() => router.back()} style={backBtn}><ArrowLeft size={15} /> Back</button>
      <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 24, fontWeight: 700, letterSpacing: '0.03em', margin: '10px 0 16px' }}>{data.job_role.title}</h1>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14, alignItems: 'start' }}>
        <Card title="Job Definition">
          <Row><F label="Title"><input style={inp} disabled={!canManage} value={jd.title} onChange={e => setJd(s => ({ ...s, title: e.target.value }))} /></F>
            <F label="Code"><input style={inp} disabled={!canManage} value={jd.role_code} onChange={e => setJd(s => ({ ...s, role_code: e.target.value }))} /></F></Row>
          <Row><F label="Level"><input style={inp} disabled={!canManage} value={jd.level} onChange={e => setJd(s => ({ ...s, level: e.target.value }))} /></F>
            <F label="Department"><select style={inp} disabled={!canManage} value={jd.department_id} onChange={e => setJd(s => ({ ...s, department_id: e.target.value }))}><option value="">—</option>{depts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></F></Row>
          <F label="Summary"><input style={inp} disabled={!canManage} value={jd.summary} onChange={e => setJd(s => ({ ...s, summary: e.target.value }))} /></F>
          <F label="Job description (markdown)"><textarea rows={6} style={{ ...inp, resize: 'vertical' }} disabled={!canManage} value={jd.job_description} onChange={e => setJd(s => ({ ...s, job_description: e.target.value }))} /></F>
          <F label="Responsibilities (one per line)"><textarea rows={5} style={{ ...inp, resize: 'vertical' }} disabled={!canManage} value={jd.responsibilities} onChange={e => setJd(s => ({ ...s, responsibilities: e.target.value }))} /></F>
          {canComp && (
            <Row3>
              <F label="Band min"><input style={inp} value={jd.salary_band_min} onChange={e => setJd(s => ({ ...s, salary_band_min: e.target.value }))} /></F>
              <F label="Band mid"><input style={inp} value={jd.salary_band_mid} onChange={e => setJd(s => ({ ...s, salary_band_mid: e.target.value }))} /></F>
              <F label="Band max"><input style={inp} value={jd.salary_band_max} onChange={e => setJd(s => ({ ...s, salary_band_max: e.target.value }))} /></F>
            </Row3>
          )}
          {!canComp && data.job_role._bands_hidden && <div style={{ fontSize: 11, color: 'var(--text-4)', marginTop: 6 }}>🔒 Salary bands hidden (requires podium_comp)</div>}
          {canManage && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 13 }}>
              <input type="checkbox" checked={jd.active} onChange={e => setJd(s => ({ ...s, active: e.target.checked }))} /> Active
            </label>
          )}
          {canManage && <button onClick={saveJd} disabled={busy} style={{ ...primaryBtn, marginTop: 12 }}><Save size={14} /> {busy ? 'Saving…' : 'Save definition'}</button>}
        </Card>

        <div>
          <Card title="KPIs">
            {kpis.length === 0 && <div style={{ color: 'var(--text-3)', fontSize: 12, marginBottom: 8 }}>No KPIs yet.</div>}
            {kpis.map((k, i) => (
              <div key={i} style={{ borderTop: '1px solid var(--border)', padding: '8px 0' }}>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input placeholder="KPI name" style={inp} disabled={!canManage} value={k.name || ''} onChange={e => setKpi(i, 'name', e.target.value)} />
                  {canManage && <button onClick={() => delKpi(i)} style={iconBtn}><Trash2 size={13} /></button>}
                </div>
                <input placeholder="Description" style={{ ...inp, marginTop: 6 }} disabled={!canManage} value={k.description || ''} onChange={e => setKpi(i, 'description', e.target.value)} />
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  <select style={{ ...inp, width: 130 }} disabled={!canManage} value={k.metric_type || 'quantitative'} onChange={e => setKpi(i, 'metric_type', e.target.value)}>
                    <option value="quantitative">Quantitative</option><option value="qualitative">Qualitative</option>
                  </select>
                  <input placeholder="Target" style={inp} disabled={!canManage} value={k.target || ''} onChange={e => setKpi(i, 'target', e.target.value)} />
                  <input placeholder="Weight" style={{ ...inp, width: 90 }} disabled={!canManage} value={k.weight ?? ''} onChange={e => setKpi(i, 'weight', e.target.value)} />
                </div>
              </div>
            ))}
            {canManage && (
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button onClick={addKpi} style={ghostBtn}><Plus size={14} /> Add KPI</button>
                <button onClick={saveKpis} disabled={busy} style={primaryBtn}><Save size={14} /> Save KPIs</button>
              </div>
            )}
          </Card>

          {(data.employees || []).length > 0 && (
            <div style={{ marginTop: 14 }}>
              <Card title={`People in this role (${data.employees.length})`}>
                {data.employees.map(e => (
                  <div key={e.id} onClick={() => router.push(`/people/detail/?id=${e.id}`)} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderTop: '1px solid var(--border)', fontSize: 13, cursor: 'pointer' }}>
                    <span>{e.full_name}</span><span style={{ color: 'var(--text-3)', fontSize: 11 }}>{e.employee_code}</span>
                  </div>
                ))}
              </Card>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Card({ title, children }) { return <div style={card}><div style={{ fontSize: 11, color: 'var(--text-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600, marginBottom: 10 }}>{title}</div>{children}</div>; }
function F({ label, children }) { return <label style={{ display: 'block', marginBottom: 10, flex: 1 }}><div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 4 }}>{label}</div>{children}</label>; }
function Row({ children }) { return <div style={{ display: 'flex', gap: 10 }}>{children}</div>; }
function Row3({ children }) { return <div style={{ display: 'flex', gap: 10 }}>{children}</div>; }

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '14px 16px' };
const backBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '6px 12px', fontSize: 12, cursor: 'pointer' };
const inp = { width: '100%', background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '7px 10px', fontFamily: 'var(--font-mono)', fontSize: 13 };
const primaryBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--podium-green)', color: '#04130d', border: 'none', borderRadius: 'var(--radius-sm)', padding: '8px 16px', fontWeight: 700, fontSize: 12, letterSpacing: '0.04em', textTransform: 'uppercase', cursor: 'pointer' };
const ghostBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '8px 16px', fontSize: 12, cursor: 'pointer' };
const iconBtn = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, flex: '0 0 auto', background: 'var(--surface-2)', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' };
