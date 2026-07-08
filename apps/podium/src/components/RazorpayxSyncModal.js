'use client';
import { useEffect, useState } from 'react';
import { Spinner, useToast } from '@throttle/ui';
import { X, RefreshCw, DownloadCloud } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../lib/podiumopsFetch.js';
import { fmtINR } from '../lib/payouts.js';

const CHUNK = 40;

// On-demand RazorpayX Payroll sync — review-and-confirm. Maps employees, fetches a
// month's gross per employee in <=40-id chunks (50-subrequest limit), previews, then
// writes to podium.payouts via applyRazorpayxPayouts. Fraternitas white-collar only.
export default function RazorpayxSyncModal({ session, month, onClose, onDone }) {
  const { showToast } = useToast();
  const [phase, setPhase] = useState('loading');   // loading | ready | applying | error
  const [error, setError] = useState(null);
  const [map, setMap] = useState(null);            // {matched, unmatched_podium, unmatched_razorpayx}
  const [amounts, setAmounts] = useState({});      // razorpayx_employee_id -> {gross, employee_id, ...}
  const [progress, setProgress] = useState(0);

  useEffect(() => { run(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function run() {
    setPhase('loading'); setError(null); setAmounts({}); setProgress(0);
    try {
      const m = await podiumopsGet('getRazorpayxPayrollMap', { month }, session);
      setMap(m);
      const ids = (m.matched || []).map(r => r.razorpayx_employee_id);
      const acc = {};
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        const r = await podiumopsGet('getRazorpayxPayrollAmounts', { month, ids: chunk.join(',') }, session);
        for (const a of (r.amounts || [])) acc[a.razorpayx_employee_id] = a;
        setProgress(Math.min(i + CHUNK, ids.length));
      }
      setAmounts(acc);
      setPhase('ready');
    } catch (e) { setError(e.message || 'Sync failed'); setPhase('error'); }
  }

  const rows = (map?.matched || [])
    .map(m => ({ ...m, amt: amounts[m.razorpayx_employee_id] || null }))
    .filter(r => r.amt && r.amt.gross != null);
  const total = rows.reduce((s, r) => s + Number(r.amt.gross), 0);

  async function apply() {
    setPhase('applying');
    try {
      const payload = rows.map(r => ({ employee_id: r.employee_id, amount: r.amt.gross, paid_on: r.amt.paid_on, source_ref: r.amt.source_ref }));
      const res = await podiumopsPost('applyRazorpayxPayouts', { month, rows: payload }, session);
      showToast(`Synced ${res.saved} payouts for ${month}`, 'success');
      onDone?.();
    } catch (e) { showToast(e.message || 'Apply failed', 'error'); setPhase('ready'); }
  }

  return (
    <div style={ov} onClick={onClose}>
      <div style={panel} onClick={e => e.stopPropagation()}>
        <div style={hd}>
          <b>Sync payroll from RazorpayX — {month}</b>
          <X size={18} style={{ cursor: 'pointer' }} onClick={onClose} />
        </div>

        {phase === 'loading' && (
          <div style={{ padding: 20, display: 'flex', gap: 10, alignItems: 'center', color: 'var(--t3)' }}>
            <Spinner /> Fetching payroll… {progress}/{(map?.matched || []).length || '…'}
          </div>
        )}

        {phase === 'error' && (
          <div style={{ padding: 20, color: 'var(--danger, #d33)' }}>
            {error} <button onClick={run} style={btn}><RefreshCw size={13} /> Retry</button>
          </div>
        )}

        {(phase === 'ready' || phase === 'applying') && (
          <>
            <div style={{ padding: '8px 14px', color: 'var(--t3)', fontSize: 13 }}>
              {rows.length} matched with payroll · total gross <b>{fmtINR(total)}</b>
              {map.unmatched_razorpayx?.length ? ` · ${map.unmatched_razorpayx.length} RazorpayX unmatched` : ''}
              {map.unmatched_podium?.length ? ` · ${map.unmatched_podium.length} Podium no-payroll` : ''}
            </div>
            <div style={{ maxHeight: 340, overflow: 'auto', padding: '0 14px' }}>
              <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--t3)' }}>
                    <th style={{ padding: '4px 0' }}>Employee</th>
                    <th style={{ textAlign: 'right', padding: '4px 0' }}>Gross</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.employee_id}>
                      <td style={{ padding: '3px 0' }}>{r.full_name} <span style={{ color: 'var(--t4)' }}>{r.employee_code}</span></td>
                      <td style={{ textAlign: 'right', padding: '3px 0' }}>{fmtINR(r.amt.gross)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!!map.unmatched_razorpayx?.length && (
                <div style={{ margin: '10px 0', color: 'var(--t4)', fontSize: 12 }}>
                  Unmatched (in RazorpayX, no Podium email): {map.unmatched_razorpayx.map(u => u.name || u.email).join(', ')}
                </div>
              )}
            </div>
            <div style={{ padding: 14, textAlign: 'right' }}>
              <button onClick={apply} disabled={phase === 'applying' || !rows.length} style={btnPrimary}>
                <DownloadCloud size={14} /> {phase === 'applying' ? 'Writing…' : `Confirm & write ${rows.length} to ledger`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const ov = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60 };
const panel = { background: 'var(--surface)', borderRadius: 12, width: 'min(680px, 94vw)', maxHeight: '86vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' };
const hd = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px', borderBottom: '1px solid var(--border, #2a2a33)' };
const btn = { display: 'inline-flex', gap: 6, alignItems: 'center', padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border,#2a2a33)', background: 'transparent', color: 'var(--t1)', cursor: 'pointer' };
const btnPrimary = { ...btn, background: 'var(--yellow, #f5c518)', color: '#1a1a1a', border: 'none', fontWeight: 600 };
