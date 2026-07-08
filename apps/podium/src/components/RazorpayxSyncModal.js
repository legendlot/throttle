'use client';
import { useEffect, useState } from 'react';
import { Spinner, useToast } from '@throttle/ui';
import { X, RefreshCw, DownloadCloud } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../lib/podiumopsFetch.js';
import { fmtINR } from '../lib/payouts.js';

// This API has no employee-list endpoint, so we walk sequential employee-ids via
// getRazorpayxPayrollScan until a run of misses (or the id cap / a rate-limit). Each hit
// is auto-resolved to a Podium person (persisted id, else unique name match); the rest get
// a manual dropdown. Confirm writes gross (= salary+additions+arrears) to podium.payouts.
const STOP_MISSES = 15;   // stop after this many consecutive empty ids past the last hit
const ID_CAP = 300;       // hard ceiling on ids scanned
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default function RazorpayxSyncModal({ session, month, onClose, onDone }) {
  const { showToast } = useToast();
  const [phase, setPhase] = useState('loading');   // loading | ready | applying | error
  const [error, setError] = useState(null);
  const [rows, setRows] = useState([]);            // scanned hits (accumulated)
  const [roster, setRoster] = useState([]);        // Podium people for the manual dropdown
  const [override, setOverride] = useState({});    // razorpayx_employee_id -> chosen employee_id
  const [scannedTo, setScannedTo] = useState(0);
  const [warn, setWarn] = useState(null);

  useEffect(() => { run(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function run() {
    setPhase('loading'); setError(null); setRows([]); setOverride({}); setWarn(null);
    try {
      const acc = [];
      let start = 1, roster0 = [];
      for (let guard = 0; guard < 20; guard++) {   // ≤20 chunks × 40 = 800 ids max, well past cap
        let r, tries = 0;
        // Rate-limit backoff: retry the same start a few times.
        do {
          r = await podiumopsGet('getRazorpayxPayrollScan', { month, start, span: 40 }, session);
          if (r.rate_limited) { setWarn('RazorpayX rate limit — backing off…'); await sleep(2500); tries++; }
        } while (r.rate_limited && tries < 4);
        if (r.rate_limited) { setWarn('Stopped early on RazorpayX rate limit — re-run to continue.'); break; }
        setWarn(null);
        if (start <= 1 && Array.isArray(r.roster)) { roster0 = r.roster; setRoster(r.roster); }
        acc.push(...(r.rows || []));
        setRows([...acc]); setScannedTo(r.scanned_to);
        start = r.next_start;
        if (r.trailing_misses >= STOP_MISSES || start > ID_CAP) break;
      }
      setRoster(roster0);
      setPhase('ready');
    } catch (e) { setError(e.message || 'Scan failed'); setPhase('error'); }
  }

  // Effective employee_id for a row = manual override if set, else auto-match.
  const effId = (r) => (override[r.razorpayx_employee_id] ?? r.employee_id) || null;
  const priced = rows.filter(r => r.gross != null && Number(r.gross) > 0);
  const willWrite = priced.filter(r => effId(r));
  const unmatched = priced.filter(r => !effId(r));
  const total = willWrite.reduce((s, r) => s + Number(r.gross), 0);
  const matchedIds = new Set(willWrite.map(r => String(effId(r))));
  const noPayroll = roster.filter(p => !matchedIds.has(String(p.employee_id)));

  async function apply() {
    setPhase('applying');
    try {
      const payload = willWrite.map(r => ({ employee_id: effId(r), amount: Number(r.gross), razorpayx_employee_id: r.razorpayx_employee_id }));
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
            <Spinner /> Scanning payroll… ids up to {scannedTo}, {rows.length} found{warn ? ` · ${warn}` : ''}
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
              {willWrite.length} to write · total gross <b>{fmtINR(total)}</b>
              {unmatched.length ? ` · ${unmatched.length} unmatched` : ''}
              {noPayroll.length ? ` · ${noPayroll.length} Podium no-payroll` : ''}
              {warn ? <span style={{ color: 'var(--danger,#d33)' }}> · {warn}</span> : null}
            </div>
            <div style={{ maxHeight: 360, overflow: 'auto', padding: '0 14px' }}>
              <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--t3)' }}>
                    <th style={{ padding: '4px 0' }}>RazorpayX employee</th>
                    <th style={{ padding: '4px 0' }}>Podium match</th>
                    <th style={{ textAlign: 'right', padding: '4px 0' }}>Gross</th>
                  </tr>
                </thead>
                <tbody>
                  {priced.map(r => {
                    const id = effId(r);
                    return (
                      <tr key={r.razorpayx_employee_id} style={{ borderTop: '1px solid var(--border,#2a2a33)' }}>
                        <td style={{ padding: '4px 0' }}>{r.name} <span style={{ color: 'var(--t4)' }}>#{r.razorpayx_employee_id}</span></td>
                        <td style={{ padding: '4px 6px 4px 0' }}>
                          {r.match_method === 'persisted' || r.match_method === 'name' ? (
                            <span>{r.full_name} <span style={{ color: 'var(--t4)', fontSize: 11 }}>({r.match_method})</span></span>
                          ) : (
                            <select value={id || ''} onChange={(e) => setOverride(o => ({ ...o, [r.razorpayx_employee_id]: e.target.value || null }))}
                              className="pd-input" style={{ background: 'var(--bg)', color: 'var(--t1)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 6px', fontSize: 12 }}>
                              <option value="">— map to… {r.match_method === 'ambiguous' ? '(ambiguous name)' : ''}</option>
                              {roster.map(p => <option key={p.employee_id} value={p.employee_id}>{p.full_name} ({p.employee_code})</option>)}
                            </select>
                          )}
                        </td>
                        <td style={{ textAlign: 'right', padding: '4px 0' }}>{fmtINR(r.gross)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!!noPayroll.length && (
                <div style={{ margin: '10px 0', color: 'var(--t4)', fontSize: 12 }}>
                  Podium people with no matched payroll this month: {noPayroll.map(p => p.full_name).join(', ')}
                </div>
              )}
            </div>
            <div style={{ padding: 14, textAlign: 'right' }}>
              <button onClick={apply} disabled={phase === 'applying' || !willWrite.length} style={btnPrimary}>
                <DownloadCloud size={14} /> {phase === 'applying' ? 'Writing…' : `Confirm & write ${willWrite.length} to ledger`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const ov = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60 };
const panel = { background: 'var(--surface)', borderRadius: 12, width: 'min(760px, 95vw)', maxHeight: '88vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' };
const hd = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px', borderBottom: '1px solid var(--border, #2a2a33)' };
const btn = { display: 'inline-flex', gap: 6, alignItems: 'center', padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border,#2a2a33)', background: 'transparent', color: 'var(--t1)', cursor: 'pointer' };
const btnPrimary = { ...btn, background: 'var(--yellow, #f5c518)', color: '#1a1a1a', border: 'none', fontWeight: 600 };
