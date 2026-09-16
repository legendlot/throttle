'use client';
import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';

const panelStyle       = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const panelHeaderStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)', gap: 8, flexWrap: 'wrap' };
const tableThStyle     = { padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const tableTdStyle     = { padding: '9px 10px', borderBottom: '1px solid rgba(42,42,42,.6)', fontSize: 12, whiteSpace: 'nowrap' };
const btnPrimary       = { background: '#f59e0b', border: '1px solid #f59e0b', borderRadius: 3, padding: '6px 12px', fontSize: 11, fontWeight: 700, color: '#000', cursor: 'pointer', fontFamily: 'var(--cond)', letterSpacing: '0.04em' };
const btnSecondary     = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 12px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)' };
const inputStyle       = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '8px 12px', fontSize: 13, color: 'var(--t1)', outline: 'none', fontFamily: 'var(--mono)' };
const selectStyle      = { ...inputStyle, fontFamily: 'inherit', cursor: 'pointer' };

const LINES = ['L1', 'L2', 'L3', 'L4', 'L5'];

// Issue timestamps are shown in IST (the floor's clock), day-first like the Redline repack detail.
const IST = 'Asia/Kolkata';
function fmtIst(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', { timeZone: IST, day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}
function istDay(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', { timeZone: IST, day: '2-digit', month: 'short', year: '2-digit' });
}

export default function RepairIssuePage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();

  const [buckets, setBuckets] = useState([]);
  const [runs, setRuns] = useState([]);
  const [runId, setRunId] = useState('');
  const [newLine, setNewLine] = useState('L1');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [scan, setScan] = useState('');
  const [feed, setFeed] = useState([]);
  const [issued, setIssued] = useState([]);       // "Issued so far" buckets for the selected run (L42)
  const [issuedCount, setIssuedCount] = useState(0);
  const [openBucket, setOpenBucket] = useState(null);   // expanded 'Issued so far' bucket key (LOT list)
  const [issuedTruncated, setIssuedTruncated] = useState(false); // worker caps the issued list at 2,000 newest
  const scanRef = useRef(null);

  const loadRuns = useCallback(async () => {
    if (!session) return;
    try {
      const res = await workerFetch('getRepairRuns', {}, session);
      const list = Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : []);
      setRuns(list);
      if (!runId && list[0]) setRunId(list[0].id);
    } catch { setRuns([]); }
  }, [session, runId]);

  const loadPick = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const data = await garageFetch('getReturnsPickList', { kind: 'repair' }, session);
      setBuckets(Array.isArray(data?.buckets) ? data.buckets : []);
    } catch (e) {
      showToast(e.message || 'Failed to load repair pick list', 'error');
      setBuckets([]);
    } finally {
      setLoading(false);
    }
  }, [session, showToast]);

  // "Issued so far" into the selected run (L42) — return_units routed here (issued_at set).
  const loadIssued = useCallback(async () => {
    if (!session || !runId) { setIssued([]); setIssuedCount(0); setIssuedTruncated(false); return; }
    try {
      const d = await garageFetch('getRepairRunDetail', { run_id: runId }, session);
      setIssued(Array.isArray(d?.issued_buckets) ? d.issued_buckets : []);
      setIssuedCount(d?.issued_count || 0);
      setIssuedTruncated(!!d?.issued_truncated);
    } catch { setIssued([]); setIssuedCount(0); setIssuedTruncated(false); }
  }, [session, runId]);

  useEffect(() => { loadRuns(); }, [loadRuns]);
  useEffect(() => { loadPick(); }, [loadPick]);
  useEffect(() => { loadIssued(); }, [loadIssued]);

  const total = useMemo(() => buckets.reduce((s, b) => s + (b.count || 0), 0), [buckets]);
  const activeRun = useMemo(() => runs.find((r) => r.id === runId) || null, [runs, runId]);
  // Timeline: units issued into the run by IST day × variant (newest day first). Built client-side
  // from the per-unit issued_at the worker returns inside each bucket (getRepairRunDetail).
  const issuedByDay = useMemo(() => {
    const days = {};
    for (const b of issued) {
      for (const u of (b.units || [])) {
        const day = istDay(u.issued_at);
        const ts = u.issued_at ? new Date(u.issued_at).getTime() : 0;
        const d = days[day] || (days[day] = { day, ts: 0, total: 0, variants: {} });
        if (ts > d.ts) d.ts = ts;
        d.total++;
        const vk = [b.disposition, b.product || '—', b.model || '—', b.color || '—'].join('|');
        const v = d.variants[vk] || (d.variants[vk] = { disposition: b.disposition, product: b.product, model: b.model, color: b.color, count: 0 });
        v.count++;
      }
    }
    return Object.values(days)
      .sort((a, c) => c.ts - a.ts)
      .map((d) => ({ ...d, variants: Object.values(d.variants).sort((a, c) => c.count - a.count) }));
  }, [issued]);

  function pushFeed(text, ok) { setFeed((f) => [{ text, ok, t: Date.now() }, ...f].slice(0, 12)); }

  async function createRun() {
    setBusy(true);
    try {
      const res = await workerFetch('createRepairRun', { data: { line: newLine, notes: 'Returns repair run' } }, session);
      const r = res.data || res;
      showToast(`Created ${r.run_no}`, 'success');
      await loadRuns();
      if (r.id) setRunId(r.id);
    } catch (e) { showToast(e.message || 'Create failed', 'error'); }
    finally { setBusy(false); }
  }

  async function issueScan(e) {
    e?.preventDefault();
    const v = scan.trim();
    if (!v) return;
    if (!runId) { showToast('Pick or create a repair run first', 'error'); return; }
    setScan('');
    setBusy(true);
    try {
      const res = await workerFetch('issueReturnUnit', { data: { issue_type: 'repair', repair_run_id: runId, scan: v } }, session);
      const r = res.data || res;
      pushFeed(`✓ ${v} → ${activeRun?.run_no || 'run'} (${r.issued})`, true);
      loadPick(); loadIssued();
    } catch (err) {
      pushFeed(`✗ ${v} — ${err.message || 'failed'}`, false);
    } finally {
      setBusy(false);
      scanRef.current?.focus();
    }
  }

  async function issueBucket(b) {
    if (!runId) { showToast('Pick or create a repair run first', 'error'); return; }
    const ids = (b.units || []).map((u) => u.return_unit_id).filter(Boolean);
    if (!ids.length) return;
    if (!confirm(`Issue all ${ids.length} ${b.disposition} unit(s) of ${[b.product, b.model, b.color].filter(Boolean).join(' ')} to ${activeRun?.run_no || 'run'}?`)) return;
    setBusy(true);
    try {
      const res = await workerFetch('issueReturnUnit', { data: { issue_type: 'repair', repair_run_id: runId, return_unit_ids: ids } }, session);
      const r = res.data || res;
      pushFeed(`✓ Issued ${r.issued} × ${b.product || ''} → ${activeRun?.run_no || 'run'}`, true);
      loadPick(); loadIssued();
    } catch (err) {
      pushFeed(`✗ ${err.message || 'failed'}`, false);
    } finally {
      setBusy(false);
    }
  }

  if (perms && !perms.returns) return <div style={{ padding: 24, color: 'var(--t3)' }}>Access restricted.</div>;

  return (
    <div>
      {/* Run target */}
      <div style={panelStyle}>
        <div style={panelHeaderStyle}><span>Repair Run Target</span></div>
        <div style={{ padding: '12px 14px', display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', display: 'block', marginBottom: 4 }}>Issue into run</span>
            <select value={runId} onChange={(e) => setRunId(e.target.value)} style={{ ...selectStyle, minWidth: 240 }} disabled={busy}>
              <option value="">— Select repair run —</option>
              {runs.map((r) => <option key={r.id} value={r.id}>{r.run_no} · {r.line} · {r.status}</option>)}
            </select>
          </div>
          <button style={btnSecondary} onClick={loadRuns} disabled={busy}>↻</button>
          {/* Run-request consolidation: the ad-hoc parts request already accepts a
              repair_run_id, but only via a manual dropdown in Redline — so the operator had to
              leave Garage, find the Ad Hoc Parts tab and re-pick this run by hand. Deep-link it.
              Opens in a NEW TAB deliberately: this is a scan station, and navigating away
              mid-issue would cost the operator their place in the queue. */}
          <a
            href={runId
              ? `https://redline.legendoftoys.com/new-run?tab=adhoc&repair_run_id=${encodeURIComponent(runId)}`
              : undefined}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              ...btnSecondary,
              display: 'inline-flex', alignItems: 'center', textDecoration: 'none',
              opacity: runId ? 1 : 0.45,
              pointerEvents: runId ? 'auto' : 'none',
            }}
            title={runId
              ? 'Request ad-hoc parts against this repair run (opens in Redline)'
              : 'Select a repair run first'}
          >Request parts from run</a>
          <div style={{ flex: 1 }} />
          <div>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', display: 'block', marginBottom: 4 }}>New run line</span>
            <select value={newLine} onChange={(e) => setNewLine(e.target.value)} style={selectStyle} disabled={busy}>
              {LINES.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </div>
          <button style={btnSecondary} onClick={createRun} disabled={busy}>+ New repair run</button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.4fr)', gap: 16, alignItems: 'start' }}>
        {/* Scan-out */}
        <div style={panelStyle}>
          <div style={panelHeaderStyle}><span>Issue to Repair — scan each unit</span></div>
          <div style={{ padding: '12px 14px' }}>
            <div style={{ fontSize: 11, color: 'var(--t3)', marginBottom: 10 }}>Scan each CXR/BRV unit to issue it into {activeRun?.run_no || 'the selected run'}. The floor then runs REP&nbsp;START → repair → QC.</div>
            <form onSubmit={issueScan}>
              <input ref={scanRef} value={scan} onChange={(e) => setScan(e.target.value)} placeholder="Scan LOT-… or box label" style={{ ...inputStyle, width: '100%' }} disabled={busy || !runId} />
            </form>
            <div style={{ marginTop: 10, display: 'grid', gap: 4 }}>
              {feed.map((f) => <div key={f.t} style={{ fontFamily: 'var(--mono)', fontSize: 11, color: f.ok ? '#4ade80' : '#ff7070' }}>{f.text}</div>)}
            </div>
          </div>
        </div>

        {/* Pick list */}
        <div style={panelStyle}>
          <div style={panelHeaderStyle}>
            <span>Repair Pick List (CXR + BRV) {total > 0 && <span style={{ color: 'var(--t3)', marginLeft: 6, fontSize: 11 }}>({total})</span>}</span>
            <button style={btnSecondary} onClick={loadPick}>↻ Refresh</button>
          </div>
          <div style={{ overflowX: 'auto' }}>
            {loading ? (
              <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
            ) : buckets.length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>No CXR/BRV units waiting. Disposition returns as CXR or BRV on the Process tab to populate.</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={tableThStyle}>Disp</th>
                  <th style={tableThStyle}>Product</th>
                  <th style={tableThStyle}>Model</th>
                  <th style={tableThStyle}>Colour</th>
                  <th style={tableThStyle}>Count</th>
                  <th style={{ ...tableThStyle, textAlign: 'right' }}></th>
                </tr></thead>
                <tbody>
                  {buckets.map((b, i) => (
                    <tr key={`${b.disposition}|${b.product}|${b.model}|${b.color}|${i}`}>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: b.disposition === 'CXR' ? '#f2cd1a' : '#7b93ff' }}>{b.disposition}</td>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--cond)', fontWeight: 700 }}>{b.product || '—'}</td>
                      <td style={tableTdStyle}>{b.model || '—'}</td>
                      <td style={tableTdStyle}>{b.color || '—'}</td>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontWeight: 700, color: '#f59e0b' }}>{b.count}</td>
                      <td style={{ ...tableTdStyle, textAlign: 'right' }}>
                        <button style={{ ...btnPrimary, opacity: busy || !runId ? 0.5 : 1 }} disabled={busy || !runId} onClick={() => issueBucket(b)}>Issue all →</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* Issued so far — units already issued into the selected repair run (L42) */}
      {runId && (
        <div style={panelStyle}>
          <div style={panelHeaderStyle}>
            <span>Issued so far → {activeRun?.run_no || 'run'} {issuedCount > 0 && <span style={{ color: 'var(--t3)', marginLeft: 6, fontSize: 11 }}>({issuedCount})</span>}</span>
            <button style={btnSecondary} onClick={loadIssued}>↻ Refresh</button>
          </div>
          {issuedTruncated && (
            <div style={{ padding: '8px 14px', fontSize: 11, color: '#fbbf24', borderBottom: '1px solid var(--border)' }}>Showing the newest 2,000 issued units only — counts, LOT lists and the timeline below are cut at that point; the oldest days are missing.</div>
          )}
          <div style={{ overflowX: 'auto' }}>
            {issued.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>Nothing issued into this run yet.</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={tableThStyle}>Disp</th>
                  <th style={tableThStyle}>Product</th>
                  <th style={tableThStyle}>Model</th>
                  <th style={tableThStyle}>Colour</th>
                  <th style={tableThStyle}>Count</th>
                  <th style={tableThStyle}>Last issued</th>
                  <th style={{ ...tableThStyle, textAlign: 'right' }}></th>
                </tr></thead>
                <tbody>
                  {issued.map((b) => {
                    // The variant tuple is the worker's own bucket key (unique); no index — the bucket order
                    // changes with every scan (newest-issued first) and an index-keyed row would collapse itself.
                    const key = `iss|${b.disposition}|${b.product}|${b.model}|${b.color}`;
                    const open = openBucket === key;
                    const units = Array.isArray(b.units) ? b.units : [];
                    const last = units.reduce((m, u) => (u.issued_at && (!m || u.issued_at > m) ? u.issued_at : m), null);
                    return [
                      <tr key={key} onClick={() => setOpenBucket(open ? null : key)} style={{ cursor: 'pointer' }} title={open ? 'Hide the LOT numbers' : 'Show the LOT numbers issued in this bucket'}>
                        <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: b.disposition === 'CXR' ? '#f2cd1a' : '#7b93ff' }}>{b.disposition}</td>
                        <td style={{ ...tableTdStyle, fontFamily: 'var(--cond)', fontWeight: 700 }}>{b.product || '—'}</td>
                        <td style={tableTdStyle}>{b.model || '—'}</td>
                        <td style={tableTdStyle}>{b.color || '—'}</td>
                        <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontWeight: 700, color: '#4ade80' }}>{b.count}</td>
                        <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>{fmtIst(last)}</td>
                        <td style={{ ...tableTdStyle, textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>{open ? '▾ LOTs' : '▸ LOTs'}</td>
                      </tr>,
                      open && (
                        <tr key={`${key}|units`}>
                          <td colSpan={7} style={{ padding: 0, borderBottom: '1px solid var(--border)', background: 'var(--surface2)' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                              <thead><tr>
                                <th style={tableThStyle}>Car UPC</th>
                                <th style={tableThStyle}>Remote</th>
                                <th style={tableThStyle}>Label</th>
                                <th style={tableThStyle}>Return</th>
                                <th style={tableThStyle}>Issued</th>
                              </tr></thead>
                              <tbody>
                                {units.map((u) => (
                                  <tr key={u.return_unit_id || `${u.car_upc}|${u.remote_upc}`}>
                                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontWeight: 600 }}>{u.car_upc || '—'}</td>
                                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--t3)' }}>{u.remote_upc || '—'}</td>
                                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--t3)' }}>{u.batch_label || '—'}</td>
                                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--t3)' }}>{u.return_unit_id || '—'}</td>
                                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>{fmtIst(u.issued_at)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      ),
                    ];
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* Timeline — the same issued units by IST day × variant (Mrudula, 2026-09-12: "by variant + issue date") */}
      {runId && issuedByDay.length > 0 && (
        <div style={panelStyle}>
          <div style={panelHeaderStyle}>
            <span>Issue timeline → {activeRun?.run_no || 'run'} <span style={{ color: 'var(--t3)', marginLeft: 6, fontSize: 11 }}>({issuedByDay.length} day{issuedByDay.length === 1 ? '' : 's'})</span></span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={tableThStyle}>Day</th>
                <th style={tableThStyle}>Units</th>
                <th style={tableThStyle}>By variant</th>
              </tr></thead>
              <tbody>
                {issuedByDay.map((d) => (
                  <tr key={d.day}>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontWeight: 600 }}>{d.day}</td>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontWeight: 700, color: '#4ade80' }}>{d.total}</td>
                    <td style={{ ...tableTdStyle, whiteSpace: 'normal' }}>
                      {d.variants.map((v, i) => (
                        <span key={`${d.day}|${i}`} style={{ display: 'inline-block', marginRight: 10, marginBottom: 2 }}>
                          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: v.disposition === 'CXR' ? '#f2cd1a' : '#7b93ff', marginRight: 4 }}>{v.disposition}</span>
                          <span style={{ fontFamily: 'var(--cond)', fontWeight: 700 }}>{v.product || '—'}</span>
                          <span style={{ color: 'var(--t2)' }}> {v.model || '—'} · {v.color || '—'}</span>
                          <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: '#4ade80', marginLeft: 4 }}>×{v.count}</span>
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
