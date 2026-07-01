'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { Factory, Users, Upload, Building2, Clock, Plus } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../../../../lib/podiumopsFetch.js';

const monthStart = () => new Date().toISOString().slice(0, 8) + '01';
const fmt = (n) => (n == null || n === '' ? '—' : '₹' + Number(n).toLocaleString('en-IN'));
const DEPT_LABEL = { assembly: 'Assembly', qc: 'QC', packaging: 'Packaging', store: 'Store', dispatch: 'Dispatch', admin: 'Admin' };
const KINDS = [
  { k: 'rent', label: 'Rent (fixed)' }, { k: 'electricity', label: 'Electricity (fixed)' },
  { k: 'other', label: 'Other fixed' }, { k: 'admin', label: 'Admin (overhead)' },
  { k: 'security', label: 'Security guard (overhead)' },
];

export default function FactoryCostPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [wf, setWf] = useState(null);       // { operators, ranks }
  const [ci, setCi] = useState(null);       // { cost_inputs, ot_rates }
  const [busy, setBusy] = useState(false);

  async function reload() {
    if (!session) return;
    const [w, c] = await Promise.all([
      podiumopsGet('getFactoryWorkforce', {}, session).catch(() => false),
      podiumopsGet('getFactoryCostInputs', {}, session).catch(() => false),
    ]);
    setWf(w); setCi(c);
  }
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [session]);

  if (perms && !perms.podium_comp) return <div style={{ color: 'var(--t3)' }}>Requires podium_comp.</div>;
  if (wf === false || ci === false) return <div style={{ color: 'var(--t3)' }}>Could not load factory cost data.</div>;
  if (!wf || !ci) return <Spinner />;

  return (
    <div style={{ maxWidth: 1000, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ fontSize: 12.5, color: 'var(--t3)', lineHeight: 1.6 }}>
        <Factory size={13} style={{ verticalAlign: '-2px' }} /> Confidential factory cost store. Salaries are visible only on this
        page (compensation tier) and are never surfaced in Garage / Redline / Depot — those show aggregate per-unit cost only.
      </div>

      <WorkforceCard wf={wf} session={session} busy={busy} setBusy={setBusy} reload={reload} showToast={showToast} />
      <BulkUploadCard session={session} busy={busy} setBusy={setBusy} reload={reload} showToast={showToast} />
      <CostInputsCard ci={ci} session={session} busy={busy} setBusy={setBusy} reload={reload} showToast={showToast} />
    </div>
  );
}

/* ── Workforce & pay ─────────────────────────────────────────── */
function WorkforceCard({ wf, session, busy, setBusy, reload, showToast }) {
  const ranks = wf.ranks || [];
  async function setWfRow(operator_id, patch, cur) {
    setBusy(true);
    try {
      await podiumopsPost('setFactoryWorkforce', {
        operator_id,
        rank_id: patch.rank_id !== undefined ? patch.rank_id : (cur?.rank_id ?? null),
        employment_type: patch.employment_type !== undefined ? patch.employment_type : (cur?.employment_type ?? 'in_house'),
      }, session);
      await reload(); showToast('Saved', 'success');
    } catch (e) { showToast(e.message || 'Failed', 'error'); } finally { setBusy(false); }
  }
  async function addPay(operator_id) {
    const eff = prompt('Effective from (YYYY-MM-DD):', monthStart());
    if (!eff) return;
    const ctc = prompt('Monthly cost (salary + perks, ₹):', '');
    if (ctc == null || ctc === '' || isNaN(Number(ctc))) return;
    setBusy(true);
    try { await podiumopsPost('setFactoryPay', { operator_id, effective_from: eff, monthly_ctc: Number(ctc) }, session); await reload(); showToast('Pay recorded', 'success'); }
    catch (e) { showToast(e.message || 'Failed', 'error'); } finally { setBusy(false); }
  }
  return (
    <div style={card}>
      <div style={cardTitle}><Users size={14} /> Workforce &amp; pay ({wf.operators.length})</div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead><tr>
            {['Operator', 'Dept', 'Classification', 'Type', 'Monthly cost', ''].map((h, i) => <th key={i} style={th}>{h}</th>)}
          </tr></thead>
          <tbody>
            {wf.operators.map(o => (
              <tr key={o.id}>
                <td style={td}>{o.name} <span style={{ color: 'var(--t3)', fontSize: 11 }}>{o.employee_id}</span></td>
                <td style={td}>{DEPT_LABEL[o.department] || o.department}</td>
                <td style={td}>
                  <select value={o.factory?.rank_id || ''} disabled={busy} onChange={e => setWfRow(o.id, { rank_id: e.target.value || null }, o.factory)} style={sel}>
                    <option value="">—</option>
                    {ranks.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
                  </select>
                </td>
                <td style={td}>
                  <select value={o.factory?.employment_type || 'in_house'} disabled={busy} onChange={e => setWfRow(o.id, { employment_type: e.target.value }, o.factory)} style={sel}>
                    <option value="in_house">In-house</option>
                    <option value="contract">Contract</option>
                  </select>
                </td>
                <td style={{ ...td, fontFamily: 'var(--font-num)' }}>{fmt(o.current_ctc)}{o.current_ctc_from && <span style={{ color: 'var(--t3)', fontSize: 10 }}> · {o.current_ctc_from}</span>}</td>
                <td style={td}><button onClick={() => addPay(o.id)} disabled={busy} style={btnSm}>Set pay</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── Bulk upload ─────────────────────────────────────────────── */
function BulkUploadCard({ session, busy, setBusy, reload, showToast }) {
  const [text, setText] = useState('');
  const [res, setRes] = useState(null);
  function parse(csv) {
    const lines = csv.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) return [];
    const header = lines[0].split(',').map(h => h.trim().toLowerCase());
    const idx = (names) => header.findIndex(h => names.includes(h));
    const iEmp = idx(['employee_id', 'employee id', 'emp_id', 'code']);
    const iName = idx(['name', 'operator', 'operator name']);
    const iCtc = idx(['monthly_ctc', 'monthly cost', 'ctc', 'salary', 'monthly salary', 'cost']);
    const iType = idx(['employment_type', 'type']);
    const iEff = idx(['effective_from', 'effective', 'from', 'date']);
    if (iCtc < 0 || (iEmp < 0 && iName < 0)) throw new Error('Header must include a name/employee_id column and a monthly_ctc column');
    return lines.slice(1).map(l => {
      const c = l.split(',').map(x => x.trim());
      return {
        employee_id: iEmp >= 0 ? c[iEmp] : '',
        name: iName >= 0 ? c[iName] : '',
        monthly_ctc: iCtc >= 0 ? c[iCtc].replace(/[₹,\s]/g, '') : '',
        employment_type: iType >= 0 ? c[iType] : '',
        effective_from: iEff >= 0 ? c[iEff] : '',
      };
    });
  }
  async function upload() {
    let rows;
    try { rows = parse(text); } catch (e) { showToast(e.message, 'error'); return; }
    if (!rows.length) { showToast('Nothing to upload', 'error'); return; }
    setBusy(true);
    try { const r = await podiumopsPost('bulkUploadFactoryPay', { rows, effective_from: monthStart() }, session); setRes(r); await reload(); showToast(`Inserted ${r.inserted}`, 'success'); }
    catch (e) { showToast(e.message || 'Failed', 'error'); } finally { setBusy(false); }
  }
  return (
    <div style={card}>
      <div style={cardTitle}><Upload size={14} /> Bulk upload salaries</div>
      <p style={p}>Paste CSV from the salary sheet. First row is a header; include a <code className="num">name</code> or <code className="num">employee_id</code> column, a <code className="num">monthly_ctc</code> column, and optionally <code className="num">employment_type</code> (in_house/contract) and <code className="num">effective_from</code> (YYYY-MM-DD, defaults to this month).</p>
      <textarea value={text} onChange={e => setText(e.target.value)} rows={6} placeholder={'employee_id,name,monthly_ctc,employment_type,effective_from\nLOT-FACT-1052,Akhil,18000,in_house,2026-07-01'} style={{ width: '100%', background: 'var(--bg)', color: 'var(--t1)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: 10, fontFamily: 'var(--font-num)', fontSize: 12.5, marginTop: 8 }} />
      <div style={{ marginTop: 8 }}><button onClick={upload} disabled={busy || !text.trim()} style={btn}><Upload size={13} /> Upload</button></div>
      {res && (
        <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--t2)' }}>
          Inserted <strong>{res.inserted}</strong> · matched {res.matched}
          {res.unmatched?.length > 0 && <div style={{ marginTop: 6, color: 'var(--orange, var(--t3))' }}>Unmatched ({res.unmatched.length}): {res.unmatched.map(u => u.name || u.employee_id).join(', ')}</div>}
        </div>
      )}
    </div>
  );
}

/* ── Fixed & overhead + OT ───────────────────────────────────── */
function CostInputsCard({ ci, session, busy, setBusy, reload, showToast }) {
  const [f, setF] = useState({ kind: 'rent', label: '', monthly_amount: '', effective_from: monthStart(), is_estimated: false });
  const rate = (ci.ot_rates || [])[0];
  const [ot, setOt] = useState({ in_house_per_hour: rate?.in_house_per_hour || '96', contract_per_hour: rate?.contract_per_hour || '103', effective_from: monthStart() });
  async function addInput() {
    if (!f.label || f.monthly_amount === '' || isNaN(Number(f.monthly_amount))) { showToast('Label + amount required', 'error'); return; }
    setBusy(true);
    try { await podiumopsPost('setFactoryCostInput', { ...f, monthly_amount: Number(f.monthly_amount) }, session); setF({ ...f, label: '', monthly_amount: '' }); await reload(); showToast('Added', 'success'); }
    catch (e) { showToast(e.message || 'Failed', 'error'); } finally { setBusy(false); }
  }
  async function saveOt() {
    setBusy(true);
    try { await podiumopsPost('setFactoryOtRates', { in_house_per_hour: Number(ot.in_house_per_hour), contract_per_hour: Number(ot.contract_per_hour), effective_from: ot.effective_from }, session); await reload(); showToast('OT rates saved', 'success'); }
    catch (e) { showToast(e.message || 'Failed', 'error'); } finally { setBusy(false); }
  }
  // latest per (kind,label)
  const latest = {}; for (const r of (ci.cost_inputs || [])) { const k = r.kind + '|' + r.label; if (!latest[k]) latest[k] = r; }
  const active = Object.values(latest);
  return (
    <div style={card}>
      <div style={cardTitle}><Building2 size={14} /> Fixed &amp; overhead costs (monthly)</div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead><tr>{['Kind', 'Label', 'Monthly', 'From', ''].map((h, i) => <th key={i} style={th}>{h}</th>)}</tr></thead>
          <tbody>
            {active.length === 0 && <tr><td style={td} colSpan={5}><span style={{ color: 'var(--t3)' }}>None yet — add rent, electricity, admin, security below.</span></td></tr>}
            {active.map((r, i) => (
              <tr key={i}>
                <td style={td}>{r.kind}</td>
                <td style={td}>{r.label} {r.is_estimated && <span style={{ color: 'var(--t3)', fontSize: 10 }}>(est)</span>}</td>
                <td style={{ ...td, fontFamily: 'var(--font-num)' }}>{fmt(r.monthly_amount)}</td>
                <td style={{ ...td, fontSize: 11, color: 'var(--t3)' }}>{r.effective_from}</td>
                <td style={td} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
        <select value={f.kind} onChange={e => setF({ ...f, kind: e.target.value })} style={sel}>{KINDS.map(k => <option key={k.k} value={k.k}>{k.label}</option>)}</select>
        <input placeholder="Label" value={f.label} onChange={e => setF({ ...f, label: e.target.value })} style={inp} />
        <input placeholder="Monthly ₹" value={f.monthly_amount} onChange={e => setF({ ...f, monthly_amount: e.target.value })} style={{ ...inp, width: 120, fontFamily: 'var(--font-num)' }} />
        <input type="date" value={f.effective_from} onChange={e => setF({ ...f, effective_from: e.target.value })} style={inp} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--t2)' }}><input type="checkbox" checked={f.is_estimated} onChange={e => setF({ ...f, is_estimated: e.target.checked })} /> estimated</label>
        <button onClick={addInput} disabled={busy} style={btn}><Plus size={13} /> Add</button>
      </div>

      <div style={{ ...cardTitle, marginTop: 22 }}><Clock size={14} /> Overtime rates (₹/hour)</div>
      <p style={p}>v1 cost math uses the <strong>average</strong> of these two rates (segregation by employment type comes later).</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
        <label style={lbl}>In-house<input value={ot.in_house_per_hour} onChange={e => setOt({ ...ot, in_house_per_hour: e.target.value })} style={{ ...inp, width: 90, fontFamily: 'var(--font-num)' }} /></label>
        <label style={lbl}>Contract<input value={ot.contract_per_hour} onChange={e => setOt({ ...ot, contract_per_hour: e.target.value })} style={{ ...inp, width: 90, fontFamily: 'var(--font-num)' }} /></label>
        <input type="date" value={ot.effective_from} onChange={e => setOt({ ...ot, effective_from: e.target.value })} style={inp} />
        <button onClick={saveOt} disabled={busy} style={btn}>Save rates</button>
      </div>
    </div>
  );
}

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: '18px 20px' };
const cardTitle = { display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-display)', fontSize: 11, color: 'var(--t2)', letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600, marginBottom: 12 };
const p = { fontSize: 12.5, color: 'var(--t2)', lineHeight: 1.6 };
const th = { textAlign: 'left', padding: '6px 8px', fontSize: 11, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };
const td = { padding: '7px 8px', borderBottom: '1px solid var(--border)', color: 'var(--t1)', verticalAlign: 'middle' };
const sel = { background: 'var(--bg)', color: 'var(--t1)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '5px 8px', fontSize: 12.5, outline: 'none' };
const inp = { background: 'var(--bg)', color: 'var(--t1)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '7px 10px', fontSize: 12.5, outline: 'none' };
const lbl = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--t2)' };
const btn = { display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--yellow)', color: '#111', border: 'none', borderRadius: 'var(--r-sm)', padding: '7px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' };
const btnSm = { background: 'var(--bg)', color: 'var(--t1)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '4px 9px', fontSize: 12, cursor: 'pointer' };
