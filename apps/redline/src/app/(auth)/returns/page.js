'use client';
import { useEffect, useState, useCallback, useMemo } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, EmptyState, Panel, KpiCard, useToast, useEscapeClose } from '@throttle/ui';

function formatAge(ts) {
  if (!ts) return '—';
  const ms = Date.now() - new Date(ts).getTime();
  const days = Math.floor(ms / 86400000);
  if (days >= 1) return `${days}d`;
  return `${Math.floor(ms / 3600000)}h`;
}

const thStyle = { padding: '10px 14px', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', fontWeight: 600, textAlign: 'left' };
const tdStyle = { padding: '10px 14px', fontFamily: 'var(--mono)', fontSize: 13, borderBottom: '1px solid rgba(64,64,64,.5)', whiteSpace: 'nowrap', color: 'var(--t1)' };
const btnPrimary = { background: 'var(--orange)', border: '1px solid var(--orange)', borderRadius: 3, padding: '7px 14px', fontSize: 12, fontWeight: 700, color: '#000', cursor: 'pointer', fontFamily: 'var(--cond)', letterSpacing: '0.04em' };
const btnSecondary = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 12px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)' };
const selectStyle = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px', fontSize: 12, color: 'var(--t1)', cursor: 'pointer', fontFamily: 'inherit' };

const PILE_META = {
  UDR:  { color: 'var(--green)',  label: 'UDR · re-dispatch' },
  CXR:  { color: '#f2cd1a',       label: 'CXR · repair' },
  BRV:  { color: '#7b93ff',       label: 'BRV · repair' },
  Loss: { color: '#ff7070',       label: 'Loss · write-off' },
  scrap:{ color: '#aaa',          label: 'Scrap' },
};
const LINES = ['L1', 'L2', 'L3', 'L4', 'L5'];

function PileTable({ rows, color, showOldest }) {
  if (!rows.length) return <div style={{ padding: 28, textAlign: 'center', color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 13 }}>✓ Empty</div>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>
          <th style={thStyle}>Product</th><th style={thStyle}>Model</th><th style={thStyle}>Colour</th>
          <th style={{ ...thStyle, textAlign: 'right' }}>Count</th>
          {showOldest && <th style={{ ...thStyle, textAlign: 'right' }}>Oldest</th>}
        </tr></thead>
        <tbody>
          {rows.map((b, i) => (
            <tr key={`${b.product}-${b.model}-${b.color}-${i}`}>
              <td style={{ ...tdStyle, fontFamily: 'var(--cond)', fontWeight: 700 }}>{b.product || '—'}</td>
              <td style={tdStyle}>{b.model || '—'}</td>
              <td style={tdStyle}>{b.color || '—'}</td>
              <td style={{ ...tdStyle, fontWeight: 700, color, textAlign: 'right' }}>{b.count}</td>
              {showOldest && <td style={{ ...tdStyle, color: 'var(--t3)', textAlign: 'right' }}>{formatAge(b.oldest_at)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ReturnsPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();

  const [piles, setPiles] = useState({ UDR: [], CXR: [], BRV: [], Loss: [], scrap: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [reqOpen, setReqOpen] = useState(false);
  const [reqLine, setReqLine] = useState('L1');
  const [reqSel, setReqSel] = useState({});
  const [submitting, setSubmitting] = useState(false);

  useEscapeClose(reqOpen, () => { if (!submitting) setReqOpen(false); });

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true); setError(null);
    try {
      const d = await garageFetch('getReturnPilesV2', {}, session);
      setPiles({
        UDR:  Array.isArray(d?.UDR) ? d.UDR : [],
        CXR:  Array.isArray(d?.CXR) ? d.CXR : [],
        BRV:  Array.isArray(d?.BRV) ? d.BRV : [],
        Loss: Array.isArray(d?.Loss) ? d.Loss : [],
        scrap:Array.isArray(d?.scrap) ? d.scrap : [],
      });
    } catch (e) {
      setError(e.message || 'Failed to load return piles');
    } finally { setLoading(false); }
  }, [session]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!session) return;
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load, session]);

  const tot = (k) => piles[k].reduce((s, b) => s + (b.count || 0), 0);
  const repairBuckets = useMemo(() => [...piles.CXR, ...piles.BRV], [piles]);

  function toggleSel(b) {
    const key = `${b.product}|${b.model}|${b.color}`;
    setReqSel((prev) => {
      const n = { ...prev };
      if (n[key]) delete n[key]; else n[key] = { product: b.product, model: b.model, color: b.color, target_car_qty: b.count || 0 };
      return n;
    });
  }

  async function submitRequest() {
    const lines = Object.values(reqSel);
    setSubmitting(true);
    try {
      const res = await workerFetch('createRepairRun', { data: { line: reqLine, notes: 'Requested from Redline returns piles', lines } }, session);
      const r = res.data || res;
      showToast(`Repair run ${r.run_no} requested — Store issues units against it`, 'success');
      setReqOpen(false); setReqSel({});
    } catch (e) {
      showToast(e.message || 'Failed to request run', 'error');
    } finally { setSubmitting(false); }
  }

  if (error) return <EmptyState message={`Failed to load: ${error}`} />;

  return (
    <div>
      <section style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontFamily: 'var(--cond)', fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t2)' }}>Return Piles</h2>
          <div style={{ display: 'flex', gap: 6 }}>
            <button style={btnSecondary} onClick={load} disabled={loading}>↻ Refresh</button>
            <button style={btnPrimary} onClick={() => setReqOpen(true)} disabled={!repairBuckets.length}>Request Repair Run →</button>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12 }}>
          <KpiCard label="UDR" value={tot('UDR')} color={tot('UDR') > 0 ? 'green' : undefined} />
          <KpiCard label="CXR" value={tot('CXR')} color={tot('CXR') > 0 ? 'yellow' : undefined} />
          <KpiCard label="BRV" value={tot('BRV')} color={tot('BRV') > 0 ? 'blue' : undefined} />
          <KpiCard label="Loss" value={tot('Loss')} color={tot('Loss') > 0 ? 'red' : undefined} />
          <KpiCard label="Scrap" value={tot('scrap')} />
        </div>
      </section>

      {loading ? (
        <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          {['UDR', 'CXR', 'BRV', 'Loss', 'scrap'].map((k) => (
            <Panel key={k} padding={0}
              header={<><span style={{ color: PILE_META[k].color }}>● </span>{PILE_META[k].label}</>}
              headerAction={<span>{tot(k)} units</span>}>
              <PileTable rows={piles[k]} color={PILE_META[k].color} showOldest={k !== 'scrap' && k !== 'Loss'} />
            </Panel>
          ))}
        </div>
      )}

      <div style={{ marginTop: 20, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', textAlign: 'center', letterSpacing: '0.04em' }}>
        Auto-refreshes every 60s. Store issues units (Garage → Returns). Repaired units re-pair at QC PASS.
      </div>

      {reqOpen && (
        <div onClick={() => !submitting && setReqOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', zIndex: 9000, padding: 24, overflowY: 'auto' }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: '#111', border: '1px solid #333', borderRadius: 6, padding: 20, color: '#eee', minWidth: 520, maxWidth: 620, width: '100%' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <h3 style={{ margin: 0, fontFamily: 'var(--cond)', fontSize: 16, color: 'var(--orange)', textTransform: 'uppercase', letterSpacing: '.06em' }}>Request Repair Run</h3>
              <button style={btnSecondary} onClick={() => setReqOpen(false)} disabled={submitting}>✕</button>
            </div>
            <div style={{ fontSize: 11, color: 'var(--t3)', marginBottom: 12 }}>Creates an empty repair run with these target lines. Store then physically issues (scans out) the units against it on the Garage → Issue Repair tab.</div>
            <div style={{ marginBottom: 12 }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', display: 'block', marginBottom: 4 }}>Line</span>
              <select value={reqLine} onChange={(e) => setReqLine(e.target.value)} style={selectStyle} disabled={submitting}>
                {LINES.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </div>
            <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 4 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr><th style={thStyle}></th><th style={thStyle}>Disp</th><th style={thStyle}>Product</th><th style={thStyle}>Colour</th><th style={{ ...thStyle, textAlign: 'right' }}>Count</th></tr></thead>
                <tbody>
                  {repairBuckets.map((b, i) => {
                    const key = `${b.product}|${b.model}|${b.color}`;
                    const disp = piles.CXR.includes(b) ? 'CXR' : 'BRV';
                    return (
                      <tr key={`${key}-${i}`} onClick={() => toggleSel(b)} style={{ cursor: 'pointer', background: reqSel[key] ? 'rgba(245,158,11,.12)' : 'transparent' }}>
                        <td style={tdStyle}><input type="checkbox" readOnly checked={!!reqSel[key]} /></td>
                        <td style={{ ...tdStyle, color: disp === 'CXR' ? '#f2cd1a' : '#7b93ff' }}>{disp}</td>
                        <td style={{ ...tdStyle, fontFamily: 'var(--cond)', fontWeight: 700 }}>{[b.product, b.model].filter(Boolean).join(' ')}</td>
                        <td style={tdStyle}>{b.color || '—'}</td>
                        <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700, color: 'var(--orange)' }}>{b.count}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 14 }}>
              <button style={btnSecondary} onClick={() => setReqOpen(false)} disabled={submitting}>Cancel</button>
              <button style={{ ...btnPrimary, opacity: submitting ? 0.6 : 1 }} onClick={submitRequest} disabled={submitting}>{submitting ? 'Requesting…' : 'Create Run'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
