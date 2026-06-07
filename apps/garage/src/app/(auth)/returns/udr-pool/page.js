'use client';
import { useEffect, useState, useCallback, useMemo } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';

const panelStyle       = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const panelHeaderStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)', gap: 8, flexWrap: 'wrap' };
const tableThStyle     = { padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const tableTdStyle     = { padding: '9px 10px', borderBottom: '1px solid rgba(42,42,42,.6)', fontSize: 12, whiteSpace: 'nowrap' };
const btnSecondary     = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 12px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)' };

// Read-only UDR pool. Issuance is request-driven (Production raises a UDR request in
// Redline → it lands in the Issue Queue) and scan-only (the store fulfils at the
// Issue UDR scanner station). The store never issues UDRs from a desk button — RULE-RET-002.
export default function UdrPoolPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();

  const [buckets, setBuckets] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const data = await garageFetch('getReturnsPickList', { kind: 'udr' }, session);
      setBuckets(Array.isArray(data?.buckets) ? data.buckets : []);
    } catch (e) {
      showToast(e.message || 'Failed to load UDR pool', 'error');
      setBuckets([]);
    } finally {
      setLoading(false);
    }
  }, [session, showToast]);

  useEffect(() => { load(); }, [load]);

  const total = useMemo(() => buckets.reduce((s, b) => s + (b.count || 0), 0), [buckets]);

  if (perms && !perms.returns) return <div style={{ padding: 24, color: 'var(--t3)' }}>Access restricted.</div>;

  return (
    <div>
      <div style={{ ...panelStyle, padding: '12px 14px', fontSize: 12, color: 'var(--t2)', lineHeight: 1.5 }}>
        This is a <strong>read-only view</strong> of UDR units waiting to be issued. UDRs are issued
        <strong> by request only</strong>: Production raises a <strong>UDR request</strong> in Redline → it
        appears in the <strong>Issue Queue</strong> → the Store fulfils it by scanning each unit at the
        <strong> Issue UDR</strong> scanner station. There is no issue button here.
      </div>

      <div style={panelStyle}>
        <div style={panelHeaderStyle}>
          <span>UDR Pool {total > 0 && <span style={{ color: 'var(--t3)', marginLeft: 6, fontSize: 11 }}>({total} waiting)</span>}</span>
          <button style={btnSecondary} onClick={load}>↻ Refresh</button>
        </div>
        <div style={{ overflowX: 'auto' }}>
          {loading ? (
            <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : buckets.length === 0 ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>No UDR units waiting. Disposition returns as UDR on the Process tab to populate the pool.</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={tableThStyle}>Product</th>
                <th style={tableThStyle}>Model</th>
                <th style={tableThStyle}>Colour</th>
                <th style={tableThStyle}>In pool</th>
              </tr></thead>
              <tbody>
                {buckets.map((b, i) => (
                  <tr key={`${b.product}|${b.model}|${b.color}|${i}`}>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--cond)', fontWeight: 700 }}>{b.product || '—'}</td>
                    <td style={tableTdStyle}>{b.model || '—'}</td>
                    <td style={tableTdStyle}>{b.color || '—'}</td>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontWeight: 700, color: '#4ade80' }}>{b.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
