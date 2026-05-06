'use client';
import { Fragment, useState, useEffect, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, EmptyState } from '@throttle/ui';

// ── Helpers ───────────────────────────────────────────────────
function fmt(n) { return n != null && n > 0 ? Number(n).toLocaleString('en-IN') : '—'; }

function numCell(n, color) {
  return {
    padding: '6px 12px',
    textAlign: 'right',
    fontFamily: 'var(--mono)',
    fontSize: 12,
    color: n > 0 ? color : 'var(--t3)',
    whiteSpace: 'nowrap',
  };
}

// ── Pipeline Page ─────────────────────────────────────────────
export default function DispatchPipelinePage() {
  const { session } = useAuth();
  const [data,     setData]     = useState(null);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState(null);
  const [expanded, setExpanded] = useState(new Set());

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true); setError(null);
    try {
      const d = await garageFetch('getDispatchPipeline', {}, session);
      setData(d || { products: [], channels: [] });
    } catch (e) {
      setError(e.message || 'Failed to load pipeline');
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => { load(); }, [load]);

  function toggleProduct(product) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(product)) next.delete(product); else next.add(product);
      return next;
    });
  }

  // ── Style constants ───────────────────────────────────────
  const btnStyle = { padding: '4px 10px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--t2)', fontSize: 11, cursor: 'pointer', fontFamily: 'var(--mono)', letterSpacing: '0.04em' };
  const sectionLabel = { fontFamily: 'var(--cond)', fontSize: 10, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'var(--t3)' };

  const thStyle = {
    padding: '8px 12px',
    fontSize: 10,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'var(--t3)',
    borderBottom: '1px solid var(--border)',
    whiteSpace: 'nowrap',
    fontWeight: 600,
    textAlign: 'left',
    background: 'var(--surface)',
    position: 'sticky', top: 0, zIndex: 1,
  };
  const numTh = { ...thStyle, textAlign: 'right' };

  const products = data?.products || [];
  const channels = data?.channels || [];

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <div style={sectionLabel}>Dispatch Pipeline — All Open Inventory</div>
        <div style={{ flex: 1 }} />
        <button style={btnStyle} onClick={load} disabled={loading}>↺ Refresh</button>
      </div>

      {error && (
        <div style={{ background: 'rgba(222,42,42,.1)', border: '1px solid rgba(222,42,42,.25)', borderRadius: 4, padding: '10px 14px', fontSize: 12, color: 'var(--red)', marginBottom: 14 }}>
          {error}
        </div>
      )}

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden' }}>
        {loading && !data ? (
          <div style={{ padding: '40px 0', display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        ) : products.length === 0 ? (
          <EmptyState icon="📊" message="No units in pipeline" />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
              <thead>
                <tr>
                  <th style={{ ...thStyle, minWidth: 220 }}>Product / Variant</th>
                  <th style={numTh}>With Production</th>
                  <th style={numTh}>Unallocated</th>
                  <th style={numTh}>Total Allocated</th>
                  {channels.map(ch => (
                    <th key={ch} style={numTh}>{ch}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {products.map(p => {
                  const isOpen = expanded.has(p.product);
                  const totalAlloc = Object.values(p.totals?.channels || {}).reduce((s, v) => s + (v || 0), 0);
                  const variants = p.variants || [];
                  return (
                    <Fragment key={p.product}>
                      <tr
                        onClick={() => toggleProduct(p.product)}
                        style={{ background: 'var(--surface2)', cursor: 'pointer', borderBottom: '1px solid var(--border)' }}
                      >
                        <td style={{ padding: '8px 12px', fontSize: 12, fontWeight: 700, color: 'var(--t1)', whiteSpace: 'nowrap' }}>
                          <span style={{ color: 'var(--t3)', marginRight: 6, fontFamily: 'var(--mono)' }}>{isOpen ? '▼' : '▶'}</span>
                          {p.product}
                        </td>
                        <td style={numCell(p.totals?.with_production, 'var(--t1)')}>{fmt(p.totals?.with_production)}</td>
                        <td style={numCell(p.totals?.unallocated, 'var(--yellow)')}>{fmt(p.totals?.unallocated)}</td>
                        <td style={numCell(totalAlloc, 'var(--green)')}>{fmt(totalAlloc)}</td>
                        {channels.map(ch => (
                          <td key={ch} style={numCell(p.totals?.channels?.[ch], 'var(--blue)')}>{fmt(p.totals?.channels?.[ch])}</td>
                        ))}
                      </tr>

                      {isOpen && variants.map((v, i) => {
                        const vTotal = Object.values(v.channels || {}).reduce((s, x) => s + (x || 0), 0);
                        return (
                          <tr key={`${p.product}-v-${i}`} style={{ background: 'var(--surface3)' }}>
                            <td style={{ padding: '6px 12px 6px 44px', fontSize: 11, color: 'var(--t2)', whiteSpace: 'nowrap' }}>
                              {[v.model, v.color].filter(Boolean).join(' ') || '—'}
                            </td>
                            <td style={numCell(v.with_production, 'var(--t1)')}>{fmt(v.with_production)}</td>
                            <td style={numCell(v.unallocated, 'var(--yellow)')}>{fmt(v.unallocated)}</td>
                            <td style={numCell(vTotal, 'var(--green)')}>{fmt(vTotal)}</td>
                            {channels.map(ch => (
                              <td key={ch} style={numCell(v.channels?.[ch], 'var(--blue)')}>{fmt(v.channels?.[ch])}</td>
                            ))}
                          </tr>
                        );
                      })}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
