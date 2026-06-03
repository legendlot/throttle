'use client';
import { Suspense, useEffect, useState, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { podiumopsGet, podiumopsPost } from '../../../../lib/podiumopsFetch.js';
import { CYCLE_STATUS, ratingColor, fmtMonths } from '../../../../lib/appraisals.js';
import { fmtDate } from '../../../../lib/format.js';

export default function Page() {
  return <Suspense fallback={<Spinner />}><CyclePage /></Suspense>;
}

function CyclePage() {
  const sp = useSearchParams();
  const id = sp.get('id');
  const router = useRouter();
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [info, setInfo] = useState(null);     // {cycle, counts}
  const [grid, setGrid] = useState(null);      // {appraisals, increment_bands, ...}
  const [enroll, setEnroll] = useState(null);  // enrollment preview rows or null
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!session || !id) return;
    const [i, g] = await Promise.all([
      podiumopsGet('getAppraisalCycle', { id }, session),
      podiumopsGet('getAppraisals', { cycle_id: id }, session).catch(() => ({ appraisals: [] })),
    ]);
    setInfo(i); setGrid(g);
  }, [session, id]);
  useEffect(() => { load(); }, [load]);

  async function setStatus(status) {
    setBusy(true);
    try { await podiumopsPost('setCycleStatus', { data: { cycle_id: id, status } }, session); showToast('Updated', 'success'); load(); }
    catch (e) { showToast(e.message || 'Failed', 'error'); } finally { setBusy(false); }
  }
  async function openEnroll() {
    try { const r = await podiumopsGet('getEnrollmentPreview', { cycle_id: id }, session);
      setEnroll(r.candidates.map(c => ({ ...c, pick: c.eligibility === 'eligible' && !c.already_enrolled }))); }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
  }
  async function doEnroll() {
    const ids = enroll.filter(c => c.pick && !c.already_enrolled).map(c => c.employee_id);
    if (!ids.length) { showToast('No one selected', 'error'); return; }
    setBusy(true);
    try { const r = await podiumopsPost('enrollAppraisalCycle', { data: { cycle_id: id, employee_ids: ids } }, session);
      showToast(`Enrolled ${r.enrolled}`, 'success'); setEnroll(null); load(); }
    catch (e) { showToast(e.message || 'Failed', 'error'); } finally { setBusy(false); }
  }
  async function shareAll() {
    const ids = (grid.appraisals || []).filter(a => a.final_rating && a.status !== 'acknowledged' && a.status !== 'shared').map(a => a.id);
    if (!ids.length) { showToast('Nothing finalized to share', 'error'); return; }
    setBusy(true);
    try { const r = await podiumopsPost('shareAppraisal', { data: { appraisal_ids: ids } }, session);
      showToast(`Shared ${r.shared}`, 'success'); load(); }
    catch (e) { showToast(e.message || 'Failed', 'error'); } finally { setBusy(false); }
  }

  if (perms && !perms.podium_hr) return <div style={{ color: 'var(--text-3)' }}>Requires podium_hr.</div>;
  if (!info || !grid) return <Spinner />;
  const c = info.cycle, k = info.counts;
  const bands = grid.increment_bands;

  return (
    <div>
      <button onClick={() => router.push('/appraisals')} style={back}>← All cycles</button>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap', margin: '8px 0 14px' }}>
        <div>
          <h1 style={h1}>{c.name} <span style={badge(c.status)}>{CYCLE_STATUS[c.status]}</span></h1>
          <p style={sub}>Appraisal date {fmtDate(c.appraisal_date)} · window {fmtDate(c.period_start)}→{fmtDate(c.period_end)} · eligibility cutoff {fmtDate(c.eligibility_cutoff_date)}</p>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {c.status === 'draft' && <button style={btnP} disabled={busy} onClick={() => setStatus('active')}>Activate (open reviews)</button>}
          {c.status === 'active' && <button style={btnP} disabled={busy} onClick={() => setStatus('calibration')}>Lock → calibration</button>}
          {c.status === 'calibration' && <><button style={btnS} disabled={busy} onClick={shareAll}>Share all finalized</button><button style={btnP} disabled={busy} onClick={() => setStatus('closed')}>Close cycle</button></>}
          {c.status !== 'draft' && c.status !== 'closed' && <button style={btnS} disabled={busy} onClick={openEnroll}>Manage enrollment</button>}
          {c.status === 'draft' && <button style={btnP} disabled={busy} onClick={openEnroll}>Enroll people</button>}
        </div>
      </header>

      {/* progress */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
        {[['Enrolled', k.total], ['Self done', k.self_done], ['Mgr done', k.manager_done], ['Finalized', k.finalized], ['Shared', k.shared], ['Acknowledged', k.acknowledged], ['PIP', k.pip]].map(([l, v]) => (
          <div key={l} style={tile}><div style={{ fontSize: 20, fontWeight: 700, color: l === 'PIP' && v ? 'var(--state-error-fg)' : 'var(--text-1)' }}>{v}</div><div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{l}</div></div>
        ))}
      </div>

      {/* enrollment preview */}
      {enroll && (
        <div style={{ ...cardBox, marginBottom: 16 }}>
          <div style={cardHead}><span>Enrollment — pick who to include</span><span><button style={btnS} onClick={() => setEnroll(null)}>Cancel</button> <button style={{ ...btnP, marginLeft: 6 }} disabled={busy} onClick={doEnroll}>Enroll selected</button></span></div>
          <div style={{ maxHeight: 320, overflow: 'auto' }}>
            <table style={tbl}><thead><tr><th style={th}></th><th style={th}>Name</th><th style={th}>Joined</th><th style={th}>Eligibility</th><th style={th}>Period</th><th style={th}>Manager</th></tr></thead>
              <tbody>{enroll.map((r, i) => (
                <tr key={r.employee_id} style={{ borderTop: '1px solid var(--border)', opacity: r.already_enrolled ? 0.5 : 1 }}>
                  <td style={td}><input type="checkbox" disabled={r.already_enrolled} checked={r.already_enrolled || r.pick} onChange={e => setEnroll(prev => prev.map((x, j) => j === i ? { ...x, pick: e.target.checked } : x))} /></td>
                  <td style={td}>{r.full_name}</td>
                  <td style={{ ...td, fontSize: 12, color: 'var(--text-3)' }}>{r.date_joined ? fmtDate(r.date_joined) : '—'}</td>
                  <td style={td}>{r.already_enrolled ? <span style={{ fontSize: 11, color: 'var(--text-3)' }}>enrolled</span> : <EligBadge r={r} />}</td>
                  <td style={{ ...td, fontSize: 12 }}>{fmtMonths(r.review_period_months)}</td>
                  <td style={{ ...td, fontSize: 12, color: 'var(--text-3)' }}>{r.manager_name || '—'}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}

      {/* calibration grid */}
      <div style={cardBox}>
        <div style={cardHead}><span>Reviews {bands ? '· calibration' : ''}</span></div>
        <div style={{ overflowX: 'auto' }}>
          <table style={tbl}>
            <thead><tr>
              <th style={th}>Employee</th><th style={th}>Period</th><th style={th}>Self</th><th style={th}>Manager</th>
              <th style={th}>Final</th><th style={th}>Note</th>{bands && <th style={th}>Suggested %</th>}<th style={th}></th>
            </tr></thead>
            <tbody>
              {(grid.appraisals || []).length === 0 && <tr><td colSpan={8} style={{ ...td, color: 'var(--text-3)', textAlign: 'center' }}>No one enrolled yet.</td></tr>}
              {(grid.appraisals || []).map(a => (
                <GridRow key={a.id} a={a} session={session} canCalibrate={c.status === 'calibration'} showPct={!!bands} onSaved={load} router={router} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function EligBadge({ r }) {
  const map = { eligible: ['var(--state-success-fg)', 'eligible'], ineligible: ['var(--text-3)', 'not yet'], unknown: ['var(--state-warning-fg)', 'unknown'] };
  const [color, label] = map[r.eligibility] || ['var(--text-2)', r.eligibility];
  return <span style={{ fontSize: 11, color }}>{label}{r.flag ? ` · ${r.flag}` : ''}</span>;
}

function GridRow({ a, session, canCalibrate, showPct, onSaved, router }) {
  const { showToast } = useToast();
  const [fr, setFr] = useState(a.final_rating || '');
  const [note, setNote] = useState(a.calibration_note || '');
  const [busy, setBusy] = useState(false);
  async function finalize() {
    if (!fr) { showToast('Set a final rating', 'error'); return; }
    setBusy(true);
    try { await podiumopsPost('finalizeAppraisal', { data: { appraisal_id: a.id, final_rating: Number(fr), calibration_note: note || null } }, session);
      showToast('Finalized', 'success'); onSaved(); }
    catch (e) { showToast(e.message || 'Failed', 'error'); } finally { setBusy(false); }
  }
  return (
    <tr style={{ borderTop: '1px solid var(--border)' }}>
      <td style={td}><a onClick={() => router.push(`/appraisals/detail/?id=${a.id}`)} style={{ color: 'var(--podium-accent)', cursor: 'pointer' }}>{a.employee?.full_name}</a><div style={{ fontSize: 10, color: 'var(--text-3)' }}>{a.status}{a.outcome === 'pip' ? ' · PIP' : ''}</div></td>
      <td style={{ ...td, fontSize: 12 }}>{fmtMonths(a.review_period_months)}</td>
      <td style={{ ...td, color: ratingColor(a.self_overall_rating), fontWeight: 700 }}>{a.self_overall_rating || '—'}</td>
      <td style={{ ...td, color: ratingColor(a.manager_overall_rating), fontWeight: 700 }}>{a.manager_overall_rating || '—'}</td>
      <td style={td}>
        {canCalibrate
          ? <select value={fr} onChange={e => setFr(e.target.value)} style={miniSel}><option value="">—</option>{[5, 4, 3, 2, 1].map(n => <option key={n} value={n}>{n}</option>)}</select>
          : <span style={{ color: ratingColor(a.final_rating), fontWeight: 700 }}>{a.final_rating || '—'}</span>}
      </td>
      <td style={td}>{canCalibrate ? <input value={note} onChange={e => setNote(e.target.value)} placeholder="HR note" style={{ ...miniSel, width: 150 }} /> : <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{a.calibration_note || ''}</span>}</td>
      {showPct && <td style={{ ...td, fontSize: 12 }}>{a.suggested_pct != null ? `${a.suggested_pct}%` : '—'}</td>}
      <td style={td}>{canCalibrate && <button style={{ ...btnP, padding: '4px 10px' }} disabled={busy} onClick={finalize}>{a.final_rating ? 'Update' : 'Finalize'}</button>}</td>
    </tr>
  );
}

const h1 = { fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 10 };
const sub = { fontSize: 12, color: 'var(--text-3)', marginTop: 4 };
const back = { background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer', fontSize: 12 };
const cardBox = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' };
const cardHead = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 12px', borderBottom: '1px solid var(--border)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-2)' };
const tile = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '10px 16px', textAlign: 'center', minWidth: 84 };
const tbl = { width: '100%', borderCollapse: 'collapse', fontSize: 13 };
const th = { textAlign: 'left', padding: '8px 10px', fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700, borderBottom: '1px solid var(--border)' };
const td = { padding: '8px 10px' };
const miniSel = { background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '4px 8px', fontSize: 12, outline: 'none' };
const btnBase = { display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 'var(--radius-sm)', padding: '7px 12px', fontFamily: 'var(--font-cond)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', cursor: 'pointer' };
const btnP = { ...btnBase, background: 'var(--podium-accent)', color: '#1f1f1f', border: '1px solid var(--podium-accent)' };
const btnS = { ...btnBase, background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)' };
function badge(status) { const map = { draft: 'var(--text-3)', active: 'var(--state-success-fg)', calibration: 'var(--state-warning-fg)', closed: 'var(--text-3)' }; return { fontFamily: 'var(--font-mono)', fontSize: 10, color: map[status] || 'var(--text-2)', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '2px 7px', textTransform: 'uppercase' }; }
