'use client';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, useToast, EmptyState, Combobox, Panel, ProductTag, StatusBadge } from '@throttle/ui';
import { ScanLine, Download } from 'lucide-react';

// Per-run store-issue pick audit (S125, Piyush; reskinned S128). Pick a run →
// every bag scanned for it, grouped by part. The run picker now shows each
// run's Product · Status beside the number (a bare run number is meaningless).
// Backed by getProductionRuns (picker) + getRunPickScans, both unchanged.

const fmtQty = (n) => (n == null) ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
function fmtTs(ts) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch { return ts; }
}
const STATUS_VARIANT = { Picking: 'info', Issued: 'success', 'Awaiting pick': 'warning', Submitted: 'neutral', Pending: 'warning' };
const STATUS_FG = { Picking: 'var(--info-fg)', Issued: 'var(--ok-fg)', 'Awaiting pick': 'var(--warn-fg)', Submitted: 'var(--t3)', Pending: 'var(--warn-fg)' };

const th = { padding: '9px 12px', fontFamily: 'var(--font-display)', fontSize: 10.5, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const td = { padding: '11px 12px', fontSize: 13.5, color: 'var(--t2)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', fontFamily: 'var(--font-ui)' };
const tdNum = { ...td, fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', textAlign: 'right' };
const btnPri = { display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--yellow)', color: '#161616', border: '1px solid var(--yellow)', borderRadius: 'var(--r-sm)', padding: '8px 14px', fontFamily: 'var(--font-display)', fontSize: 12, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', cursor: 'pointer', whiteSpace: 'nowrap' };
const btnSec = { display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--surface-2)', color: 'var(--t2)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '8px 14px', fontFamily: 'var(--font-display)', fontSize: 12, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', cursor: 'pointer', whiteSpace: 'nowrap' };

export default function PickScansPage() {
  const { session } = useAuth();
  const { showToast } = useToast();

  const [runs, setRuns] = useState([]);
  const [runNo, setRunNo] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    garageFetch('getProductionRuns', {}, session)
      .then(rows => setRuns(Array.isArray(rows) ? rows : []))
      .catch(() => {});
  }, [session]);

  // Each option carries product + status so the dropdown can render them
  // beside the run number (and the typed query filters on them via `hint`).
  const runOptions = useMemo(() => runs.map(r => ({
    value: r.run_no,
    label: r.run_no,
    hint: [r.product, r.status].filter(Boolean).join(' · '),
    product: r.product || '',
    status: r.status || '',
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

  const renderRunOption = (o, { selected }) => (
    <>
      <span className="num" style={{ fontSize: 13, fontWeight: 600, color: 'var(--t1)', whiteSpace: 'nowrap' }}>{o.label}</span>
      <span style={{ flex: 1 }} />
      {o.product && <ProductTag name={o.product} />}
      {o.status && <span style={{ color: 'var(--t4)' }}>·</span>}
      {o.status && <span style={{ fontSize: 12.5, color: STATUS_FG[o.status] || 'var(--t3)', fontWeight: 500, minWidth: 84, textAlign: 'left' }}>{o.status}</span>}
      {selected && <span style={{ color: 'var(--yellow)', fontSize: 12 }}>✓</span>}
    </>
  );

  return (
    <div>
      <div style={{ marginBottom: 4 }}>
        <div className="eyebrow" style={{ marginBottom: 5 }}>Fulfilment</div>
        <h1 className="title" style={{ fontSize: 27, lineHeight: 1, margin: 0 }}>Pick Scans</h1>
      </div>
      <div style={{ fontSize: 13, color: 'var(--t3)', marginTop: 8, marginBottom: 18, maxWidth: 640 }}>
        Every bag scanned at the store-issue pick for a run, grouped by part. Pick a run to audit what was physically scanned while issuing it.
      </div>

      <div style={{ marginBottom: 18, maxWidth: 760 }}>
        <div className="eyebrow" style={{ marginBottom: 6 }}>Run</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'stretch' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Combobox
              value={runNo}
              onChange={(v) => { setRunNo(v); load(v); }}
              options={runOptions}
              renderOption={renderRunOption}
              placeholder="Search a run, product or status… · /"
              data-search-primary
            />
          </div>
          <button onClick={() => load(runNo)} style={btnPri}>Load</button>
          {data?.lines?.length > 0 && (
            <button onClick={exportCsv} style={btnSec}><Download size={14} strokeWidth={1.75} />CSV</button>
          )}
        </div>
      </div>

      {loading && <div style={{ padding: 40, textAlign: 'center' }}><Spinner /></div>}

      {!loading && data && (
        <Panel padding={0} icon={ScanLine} title={data.run_no}
          action={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
            {data.product && <ProductTag name={data.product} />}
            {data.status && <StatusBadge variant={STATUS_VARIANT[data.status] || 'neutral'}>{data.status}</StatusBadge>}
            <span className="num" style={{ fontSize: 12, color: 'var(--t3)', textTransform: 'none', letterSpacing: 0 }}>{data.part_count} parts · {fmtQty(data.total_bags)} bags · {fmtQty(data.total_qty)} units</span>
          </span>}>
          {data.lines?.length ? (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  {['Part', 'Name', 'Bags', 'Total Qty', 'First Scan', 'Last Scan'].map((h, i) =>
                    <th key={h} style={{ ...th, textAlign: i === 2 || i === 3 ? 'right' : 'left' }}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {data.lines.map(l => (
                    <tr key={l.part_code} className="g-row">
                      <td style={td}><span className="num" style={{ fontWeight: 600, color: 'var(--t1)' }}>{l.part_code}</span></td>
                      <td style={td}>{l.part_name}</td>
                      <td style={{ ...tdNum, color: 'var(--t1)', fontWeight: 600 }}>{fmtQty(l.bags)}</td>
                      <td style={{ ...tdNum }}>{fmtQty(l.total_qty)}</td>
                      <td style={td}><span className="num" style={{ fontSize: 11.5, color: 'var(--t3)' }}>{fmtTs(l.first_scan)}</span></td>
                      <td style={td}><span className="num" style={{ fontSize: 11.5, color: 'var(--t3)' }}>{fmtTs(l.last_scan)}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{ padding: 14 }}><EmptyState title="No pick scans" message="Nothing has been scanned at the store-issue pick for this run yet." /></div>
          )}
        </Panel>
      )}
    </div>
  );
}
