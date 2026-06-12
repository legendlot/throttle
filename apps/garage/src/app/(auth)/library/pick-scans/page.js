'use client';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, useToast, EmptyState, Combobox } from '@throttle/ui';

// Per-run store-issue pick audit. Pick a run → every bag scanned for it,
// grouped by part (bag count + total qty + first/last scan). Backed by the
// lotopsproxy getRunPickScans action over store.run_pick_scans. (S125, Piyush.)

const panelStyle       = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const panelHeaderStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)' };
const panelBodyStyle   = { padding: '12px 14px' };
const thStyle = { padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const tdStyle = { padding: '8px 10px', borderBottom: '1px solid rgba(42,42,42,.6)', fontSize: 12, verticalAlign: 'top' };
const numTd   = { ...tdStyle, fontFamily: 'var(--mono)', textAlign: 'right', whiteSpace: 'nowrap' };

function fmtTs(ts) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch { return ts; }
}
function fmtQty(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

export default function PickScansPage() {
  const { session } = useAuth();
  const { showToast } = useToast();

  const [runs, setRuns]     = useState([]);
  const [runNo, setRunNo]   = useState('');
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(false);

  // Recent runs for the picker.
  useEffect(() => {
    garageFetch('getProductionRuns', {}, session)
      .then(rows => setRuns(Array.isArray(rows) ? rows : []))
      .catch(() => {});
  }, [session]);

  const runOptions = useMemo(() => runs.map(r => ({
    value: r.run_no,
    label: r.run_no,
    hint: [r.product, r.status].filter(Boolean).join(' · '),
  })), [runs]);

  async function load(rn) {
    const run = (rn || '').trim();
    if (!run) return;
    setLoading(true); setData(null);
    try {
      const res = await garageFetch('getRunPickScans', { run }, session);
      setData(res);
      if (!res?.lines?.length) showToast('No pick scans found for ' + run, 'info');
    } catch (e) {
      showToast(e.message || 'Failed to load', 'error');
    } finally { setLoading(false); }
  }

  function exportCsv() {
    if (!data?.lines?.length) return;
    const head = ['Part Code', 'Part Name', 'Bags', 'Total Qty', 'First Scan', 'Last Scan'];
    const rows = data.lines.map(l => [l.part_code, l.part_name, l.bags, l.total_qty, l.first_scan || '', l.last_scan || '']);
    const csv = [head, ...rows].map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pick-scans-${data.run_no}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div style={{ maxWidth: 880 }}>
      <div style={panelStyle}>
        <div style={panelHeaderStyle}>
          <span>Pick Scans — bags scanned per run</span>
        </div>
        <div style={panelBodyStyle}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 240 }}>
              <label style={{ display: 'block', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--t3)', marginBottom: 5 }}>Run</label>
              <Combobox
                value={runNo}
                onChange={(v) => { setRunNo(v); load(v); }}
                options={runOptions}
                placeholder="Pick a run (or type RUN-155) · /"
                data-search-primary
              />
            </div>
            <button onClick={() => load(runNo)} style={{ padding: '8px 14px', background: 'var(--yellow)', color: '#1a1a1a', border: 'none', borderRadius: 3, fontWeight: 700, fontFamily: 'var(--cond)', letterSpacing: '.05em', textTransform: 'uppercase', cursor: 'pointer' }}>Load</button>
            {data?.lines?.length > 0 && (
              <button onClick={exportCsv} style={{ padding: '8px 14px', background: 'transparent', color: 'var(--t2)', border: '1px solid var(--border)', borderRadius: 3, fontWeight: 700, fontFamily: 'var(--cond)', letterSpacing: '.05em', textTransform: 'uppercase', cursor: 'pointer' }}>↓ CSV</button>
            )}
          </div>
        </div>
      </div>

      {loading && <div style={{ padding: 40, textAlign: 'center' }}><Spinner /></div>}

      {!loading && data && (
        <div style={panelStyle}>
          <div style={panelHeaderStyle}>
            <span>{data.run_no}{data.product ? ` · ${data.product}` : ''}</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', letterSpacing: 0, textTransform: 'none' }}>
              {data.part_count} parts · {fmtQty(data.total_bags)} bags · {fmtQty(data.total_qty)} units
            </span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            {data.lines?.length ? (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={thStyle}>Part</th>
                  <th style={thStyle}>Name</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Bags</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Total Qty</th>
                  <th style={thStyle}>First</th>
                  <th style={thStyle}>Last</th>
                </tr></thead>
                <tbody>
                  {data.lines.map(l => (
                    <tr key={l.part_code}>
                      <td style={{ ...tdStyle, fontFamily: 'var(--mono)', whiteSpace: 'nowrap' }}>{l.part_code}</td>
                      <td style={tdStyle}>{l.part_name}</td>
                      <td style={numTd}>{fmtQty(l.bags)}</td>
                      <td style={numTd}>{fmtQty(l.total_qty)}</td>
                      <td style={{ ...tdStyle, color: 'var(--t3)', whiteSpace: 'nowrap' }}>{fmtTs(l.first_scan)}</td>
                      <td style={{ ...tdStyle, color: 'var(--t3)', whiteSpace: 'nowrap' }}>{fmtTs(l.last_scan)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div style={panelBodyStyle}><EmptyState title="No pick scans" message="Nothing has been scanned at the store-issue pick for this run yet." /></div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
