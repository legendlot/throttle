'use client';
import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';

const panelStyle       = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const panelHeaderStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)', gap: 8, flexWrap: 'wrap' };
const tableThStyle     = { padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const tableTdStyle     = { padding: '9px 10px', borderBottom: '1px solid rgba(42,42,42,.6)', fontSize: 12, whiteSpace: 'nowrap' };
const inputStyle       = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '8px 12px', fontSize: 13, color: 'var(--t1)', outline: 'none', fontFamily: 'var(--mono)' };
const btnPrimary       = { background: 'var(--yellow)', border: '1px solid var(--yellow)', borderRadius: 3, padding: '6px 12px', fontSize: 11, fontWeight: 700, color: '#000', cursor: 'pointer', fontFamily: 'var(--cond)', letterSpacing: '0.04em' };
const btnSecondary     = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 12px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)' };

export default function UdrIssuePage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();

  const [buckets, setBuckets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [scan, setScan] = useState('');
  const [feed, setFeed] = useState([]); // [{text, ok}]
  const scanRef = useRef(null);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const data = await garageFetch('getReturnsPickList', { kind: 'udr' }, session);
      setBuckets(Array.isArray(data?.buckets) ? data.buckets : []);
    } catch (e) {
      showToast(e.message || 'Failed to load UDR pick list', 'error');
      setBuckets([]);
    } finally {
      setLoading(false);
    }
  }, [session, showToast]);

  useEffect(() => { load(); }, [load]);

  const total = useMemo(() => buckets.reduce((s, b) => s + (b.count || 0), 0), [buckets]);

  function pushFeed(text, ok) { setFeed((f) => [{ text, ok, t: Date.now() }, ...f].slice(0, 12)); }

  async function issueScan(e) {
    e?.preventDefault();
    const v = scan.trim();
    if (!v) return;
    setScan('');
    setBusy(true);
    try {
      const res = await workerFetch('issueReturnUnit', { data: { issue_type: 'udr', scan: v } }, session);
      const r = res.data || res;
      pushFeed(`✓ Issued ${v} (${r.issued} unit)`, true);
      load();
    } catch (err) {
      pushFeed(`✗ ${v} — ${err.message || 'failed'}`, false);
    } finally {
      setBusy(false);
      scanRef.current?.focus();
    }
  }

  async function issueBucket(b) {
    const ids = (b.units || []).map((u) => u.return_unit_id).filter(Boolean);
    if (!ids.length) return;
    if (!confirm(`Issue all ${ids.length} UDR unit(s) of ${[b.product, b.model, b.color].filter(Boolean).join(' ')}?`)) return;
    setBusy(true);
    try {
      const res = await workerFetch('issueReturnUnit', { data: { issue_type: 'udr', return_unit_ids: ids } }, session);
      const r = res.data || res;
      pushFeed(`✓ Issued ${r.issued} × ${b.product || ''} ${b.color || ''}`, true);
      load();
    } catch (err) {
      pushFeed(`✗ ${err.message || 'failed'}`, false);
    } finally {
      setBusy(false);
    }
  }

  if (perms && !perms.returns) return <div style={{ padding: 24, color: 'var(--t3)' }}>Access restricted.</div>;

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.4fr)', gap: 16, alignItems: 'start' }}>
        {/* Scan-out */}
        <div style={panelStyle}>
          <div style={panelHeaderStyle}><span>Issue UDR — scan each unit out</span></div>
          <div style={{ padding: '12px 14px' }}>
            <div style={{ fontSize: 11, color: 'var(--t3)', marginBottom: 10 }}>Scan a UDR unit&apos;s box label or UPC to issue it to production. It then re-dispatches on its sealed box at PKG&nbsp;OUT.</div>
            <form onSubmit={issueScan}>
              <input ref={scanRef} autoFocus value={scan} onChange={(e) => setScan(e.target.value)} placeholder="Scan LOT-… or box label" style={{ ...inputStyle, width: '100%' }} disabled={busy} />
            </form>
            <div style={{ marginTop: 10, display: 'grid', gap: 4 }}>
              {feed.map((f) => (
                <div key={f.t} style={{ fontFamily: 'var(--mono)', fontSize: 11, color: f.ok ? '#4ade80' : '#ff7070' }}>{f.text}</div>
              ))}
            </div>
          </div>
        </div>

        {/* Pick list */}
        <div style={panelStyle}>
          <div style={panelHeaderStyle}>
            <span>UDR Pick List {total > 0 && <span style={{ color: 'var(--t3)', marginLeft: 6, fontSize: 11 }}>({total})</span>}</span>
            <button style={btnSecondary} onClick={load}>↻ Refresh</button>
          </div>
          <div style={{ overflowX: 'auto' }}>
            {loading ? (
              <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
            ) : buckets.length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>No UDR units waiting to be issued. Disposition returns as UDR on the Process tab to populate.</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={tableThStyle}>Product</th>
                  <th style={tableThStyle}>Model</th>
                  <th style={tableThStyle}>Colour</th>
                  <th style={tableThStyle}>Count</th>
                  <th style={{ ...tableThStyle, textAlign: 'right' }}></th>
                </tr></thead>
                <tbody>
                  {buckets.map((b, i) => (
                    <tr key={`${b.product}|${b.model}|${b.color}|${i}`}>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--cond)', fontWeight: 700 }}>{b.product || '—'}</td>
                      <td style={tableTdStyle}>{b.model || '—'}</td>
                      <td style={tableTdStyle}>{b.color || '—'}</td>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontWeight: 700, color: '#4ade80' }}>{b.count}</td>
                      <td style={{ ...tableTdStyle, textAlign: 'right' }}>
                        <button style={{ ...btnPrimary, opacity: busy ? 0.5 : 1 }} disabled={busy} onClick={() => issueBucket(b)}>Issue all →</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
