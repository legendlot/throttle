'use client';
import { Fragment, useState, useEffect, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, EmptyState, Panel } from '@throttle/ui';

// ── Helpers ───────────────────────────────────────────────────
function fmt(n) { return n != null && n > 0 ? Number(n).toLocaleString('en-IN') : '—'; }

function numCell(n, color) {
  return {
    padding: '8px 14px',
    textAlign: 'right',
    fontFamily: 'var(--mono)',
    fontSize: 13,
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
  const refreshBtnStyle = {
    padding: '7px 12px', background: 'transparent', border: '1px solid var(--border)',
    borderRadius: 3, color: 'var(--t2)', fontFamily: 'var(--mono)', fontSize: 12,
    cursor: 'pointer', letterSpacing: '0.04em',
  };
  const sectionLabel = {
    margin: 0, fontFamily: 'var(--cond)', fontSize: 12, fontWeight: 700,
    letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t2)',
  };

  const thStyle = {
    padding: '10px 14px',
    fontFamily: 'var(--mono)',
    fontSize: 11,
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
        <h2 style={sectionLabel}>Dispatch Pipeline — All Open Inventory</h2>
        <div style={{ flex: 1 }} />
        <button style={refreshBtnStyle} onClick={load} disabled={loading}>↺ Refresh</button>
      </div>

      {error && (
        <div style={{ background: 'rgba(222,42,42,.1)', border: '1px solid rgba(222,42,42,.3)', borderRadius: 4, padding: '12px 14px', fontFamily: 'var(--mono)', fontSize: 13, color: '#ff7070', marginBottom: 16 }}>
          ⚠ {error}
        </div>
      )}

      <Panel padding={0}>
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
                  <th style={numTh}>Unalloc (R)</th>
                  <th style={numTh}>Unalloc (E)</th>
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
                        <td style={{ padding: '10px 14px', fontFamily: 'var(--cond)', fontSize: 14, fontWeight: 700, color: 'var(--t1)', whiteSpace: 'nowrap', letterSpacing: '0.04em' }}>
                          <span style={{ color: 'var(--t3)', marginRight: 8, fontFamily: 'var(--mono)' }}>{isOpen ? '▼' : '▶'}</span>
                          {p.product}
                        </td>
                        <td style={numCell(p.totals?.with_production, 'var(--t1)')}>{fmt(p.totals?.with_production)}</td>
                        <td style={numCell(p.totals?.unallocated_retail, 'var(--yellow)')}>{fmt(p.totals?.unallocated_retail)}</td>
                        <td style={numCell(p.totals?.unallocated_ecom, 'var(--yellow)')}>{fmt(p.totals?.unallocated_ecom)}</td>
                        <td style={numCell(totalAlloc, 'var(--green)')}>{fmt(totalAlloc)}</td>
                        {channels.map(ch => (
                          <td key={ch} style={numCell(p.totals?.channels?.[ch], 'var(--blue)')}>{fmt(p.totals?.channels?.[ch])}</td>
                        ))}
                      </tr>

                      {isOpen && variants.map((v, i) => {
                        const vTotal = Object.values(v.channels || {}).reduce((s, x) => s + (x || 0), 0);
                        return (
                          <tr key={`${p.product}-v-${i}`} style={{ background: 'var(--surface3)' }}>
                            <td style={{ padding: '8px 14px 8px 44px', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t2)', whiteSpace: 'nowrap' }}>
                              {[v.model, v.color].filter(Boolean).join(' ') || '—'}
                            </td>
                            <td style={numCell(v.with_production, 'var(--t1)')}>{fmt(v.with_production)}</td>
                            <td style={numCell(v.unallocated_retail, 'var(--yellow)')}>{fmt(v.unallocated_retail)}</td>
                            <td style={numCell(v.unallocated_ecom, 'var(--yellow)')}>{fmt(v.unallocated_ecom)}</td>
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
      </Panel>
    </div>
  );
}
