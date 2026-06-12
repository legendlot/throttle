'use client';
/* ════════════════════════════════════════════════════════════
   DISPATCH › PIPELINE — Pit Wall v2 reskin of the open-inventory
   pipeline (prototype: redesign-reference/app/dispatch.jsx).
   Same data + API (getDispatchPipeline): product × stage matrix
   with expandable variants and per-channel allocation columns.
   Prototype funnel/units-list/shipped-bars need status counts,
   a units feed and shipped-today data that this payload doesn't
   carry — skipped (no new API calls).
   ════════════════════════════════════════════════════════════ */
import { Fragment, useState, useEffect, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner } from '@throttle/ui';
import { RotateCw } from 'lucide-react';
import { useRefreshState } from '../layout.js';
import { Icon, Panel, btnGhost, istToday } from '../../../components/kit/index.js';

// '—' for empty/zero cells — keeps the matrix scannable.
function fmtCell(n) { return n != null && n > 0 ? Number(n).toLocaleString('en-IN') : '—'; }

const numTd = (n, color, bold) => ({
  padding: '9px 14px', textAlign: 'right', fontSize: 12.5,
  fontWeight: bold ? 700 : 600, whiteSpace: 'nowrap',
  color: n > 0 ? (color || 'var(--t1)') : 'var(--t4)',
});

export default function DispatchPipelinePage() {
  const { session } = useAuth();
  const { setRefreshing, setLastRefreshed } = useRefreshState();
  const [data,     setData]     = useState(null);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState(null);
  const [expanded, setExpanded] = useState(new Set());

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true); setError(null); setRefreshing(true);
    try {
      const d = await garageFetch('getDispatchPipeline', {}, session);
      setData(d || { products: [], channels: [] });
    } catch (e) {
      setError(e.message || 'Failed to load pipeline');
    } finally {
      setLoading(false);
      setRefreshing(false);
      setLastRefreshed(new Date());
    }
  }, [session, setRefreshing, setLastRefreshed]);

  useEffect(() => { load(); }, [load]);

  function toggleProduct(product) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(product)) next.delete(product); else next.add(product);
      return next;
    });
  }

  const thStyle = {
    padding: '11px 14px', textAlign: 'left', whiteSpace: 'nowrap',
    borderBottom: '1px solid var(--border)', background: 'var(--surface)',
    position: 'sticky', top: 0, zIndex: 1,
  };
  const numTh = { ...thStyle, textAlign: 'right' };

  const products = data?.products || [];
  const channels = data?.channels || [];

  // Column totals across all products.
  const totals = {
    with_production:    products.reduce((s, p) => s + (p.totals?.with_production    || 0), 0),
    unallocated_retail: products.reduce((s, p) => s + (p.totals?.unallocated_retail || 0), 0),
    unallocated_ecom:   products.reduce((s, p) => s + (p.totals?.unallocated_ecom   || 0), 0),
    channels: channels.reduce((acc, ch) => {
      acc[ch] = products.reduce((s, p) => s + (p.totals?.channels?.[ch] || 0), 0);
      return acc;
    }, {}),
  };
  const grandAlloc = Object.values(totals.channels).reduce((s, v) => s + v, 0);

  return (
    <div style={{ maxWidth: 1240, margin: '0 auto', fontFamily: 'var(--font-ui)' }}>
      {/* controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface)',
          border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '6px 11px', color: 'var(--t2)' }}>
          <Icon name="clock" size={14} />
          <span className="num" style={{ fontSize: 12.5, color: 'var(--t1)', whiteSpace: 'nowrap' }}>{istToday()}</span>
        </div>
        <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t3)' }}>
          All open inventory · production → dispatch → channel
        </span>
        <div style={{ flex: 1 }} />
        <button style={btnGhost} onClick={load} disabled={loading}>
          <RotateCw size={14} strokeWidth={1.75} /> Refresh
        </button>
      </div>

      {error && (
        <div style={{ background: 'var(--bad-bg)', border: '1px solid var(--bad-bd)', borderRadius: 'var(--r-sm)',
          padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 9,
          fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--bad-fg)', marginBottom: 16 }}>
          <Icon name="alert" size={15} /> {error}
        </div>
      )}

      <Panel title="Open inventory" icon="layers" pad={0}
        action={<span className="num" style={{ fontSize: 11, color: 'var(--t3)' }}>{products.length} products</span>}>
        {loading && !data ? (
          <div style={{ padding: '40px 0', display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        ) : products.length === 0 ? (
          <div style={{ padding: '44px 0', textAlign: 'center' }}>
            <div style={{ display: 'inline-grid', placeItems: 'center', width: 44, height: 44, borderRadius: '50%',
              background: 'var(--surface-2)', color: 'var(--t3)', border: '1px solid var(--border-2)', marginBottom: 12 }}>
              <Icon name="layers" size={20} />
            </div>
            <div style={{ fontFamily: 'var(--font-ui)', fontSize: 14, fontWeight: 600, color: 'var(--t1)' }}>No units in pipeline</div>
            <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t3)', marginTop: 3 }}>
              Packed units appear here as they move toward dispatch.
            </div>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
              <thead>
                <tr>
                  <th className="eyebrow" style={{ ...thStyle, minWidth: 220 }}>Product / Variant</th>
                  <th className="eyebrow" style={numTh}>With Production</th>
                  <th className="eyebrow" style={numTh}>Unalloc (R)</th>
                  <th className="eyebrow" style={numTh}>Unalloc (E)</th>
                  <th className="eyebrow" style={numTh}>Unalloc (Total)</th>
                  <th className="eyebrow" style={numTh}>Total Allocated</th>
                  {channels.map(ch => (
                    <th key={ch} className="eyebrow" style={numTh}>{ch}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {/* column totals row */}
                <tr style={{ background: 'var(--bg-2)', borderBottom: '2px solid var(--border-2)' }}>
                  <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>
                    <span className="label" style={{ fontSize: 11, color: 'var(--t2)' }}>All products</span>
                  </td>
                  <td className="num" style={numTd(totals.with_production, 'var(--t1)', true)}>{fmtCell(totals.with_production)}</td>
                  <td className="num" style={numTd(totals.unallocated_retail, 'var(--yellow)', true)}>{fmtCell(totals.unallocated_retail)}</td>
                  <td className="num" style={numTd(totals.unallocated_ecom, 'var(--yellow)', true)}>{fmtCell(totals.unallocated_ecom)}</td>
                  <td className="num" style={numTd(totals.unallocated_retail + totals.unallocated_ecom, 'var(--yellow)', true)}>{fmtCell(totals.unallocated_retail + totals.unallocated_ecom)}</td>
                  <td className="num" style={numTd(grandAlloc, 'var(--ok-fg)', true)}>{fmtCell(grandAlloc)}</td>
                  {channels.map(ch => (
                    <td key={ch} className="num" style={numTd(totals.channels[ch], 'var(--info-fg)', true)}>{fmtCell(totals.channels[ch])}</td>
                  ))}
                </tr>
                {products.map(p => {
                  const isOpen = expanded.has(p.product);
                  const totalAlloc = Object.values(p.totals?.channels || {}).reduce((s, v) => s + (v || 0), 0);
                  const variants = p.variants || [];
                  return (
                    <Fragment key={p.product}>
                      <tr
                        onClick={() => toggleProduct(p.product)}
                        className="dp-row"
                        style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)',
                          transition: 'background var(--fast) var(--ease)' }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-2)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                      >
                        <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ color: 'var(--t4)', display: 'flex',
                              transform: isOpen ? 'rotate(0)' : 'rotate(-90deg)', transition: 'transform var(--fast) var(--ease)' }}>
                              <Icon name="chevD" size={13} />
                            </span>
                            <span style={{ fontFamily: 'var(--font-ui)', fontSize: 13.5, fontWeight: 600, color: 'var(--t1)' }}>{p.product}</span>
                          </span>
                        </td>
                        <td className="num" style={numTd(p.totals?.with_production, 'var(--t1)')}>{fmtCell(p.totals?.with_production)}</td>
                        <td className="num" style={numTd(p.totals?.unallocated_retail, 'var(--yellow)')}>{fmtCell(p.totals?.unallocated_retail)}</td>
                        <td className="num" style={numTd(p.totals?.unallocated_ecom, 'var(--yellow)')}>{fmtCell(p.totals?.unallocated_ecom)}</td>
                        <td className="num" style={numTd((p.totals?.unallocated_retail || 0) + (p.totals?.unallocated_ecom || 0), 'var(--yellow)')}>{fmtCell((p.totals?.unallocated_retail || 0) + (p.totals?.unallocated_ecom || 0))}</td>
                        <td className="num" style={numTd(totalAlloc, 'var(--ok-fg)')}>{fmtCell(totalAlloc)}</td>
                        {channels.map(ch => (
                          <td key={ch} className="num" style={numTd(p.totals?.channels?.[ch], 'var(--info-fg)')}>{fmtCell(p.totals?.channels?.[ch])}</td>
                        ))}
                      </tr>

                      {isOpen && variants.map((v, i) => {
                        const vTotal = Object.values(v.channels || {}).reduce((s, x) => s + (x || 0), 0);
                        return (
                          <tr key={`${p.product}-v-${i}`} style={{ background: 'var(--bg-2)', borderBottom: '1px solid var(--border)' }}>
                            <td className="num" style={{ padding: '7px 14px 7px 43px', fontSize: 11.5, color: 'var(--t2)', whiteSpace: 'nowrap' }}>
                              {[v.model, v.color].filter(Boolean).join(' ') || '—'}
                            </td>
                            <td className="num" style={numTd(v.with_production, 'var(--t1)')}>{fmtCell(v.with_production)}</td>
                            <td className="num" style={numTd(v.unallocated_retail, 'var(--yellow)')}>{fmtCell(v.unallocated_retail)}</td>
                            <td className="num" style={numTd(v.unallocated_ecom, 'var(--yellow)')}>{fmtCell(v.unallocated_ecom)}</td>
                            <td className="num" style={numTd((v.unallocated_retail || 0) + (v.unallocated_ecom || 0), 'var(--yellow)')}>{fmtCell((v.unallocated_retail || 0) + (v.unallocated_ecom || 0))}</td>
                            <td className="num" style={numTd(vTotal, 'var(--ok-fg)')}>{fmtCell(vTotal)}</td>
                            {channels.map(ch => (
                              <td key={ch} className="num" style={numTd(v.channels?.[ch], 'var(--info-fg)')}>{fmtCell(v.channels?.[ch])}</td>
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
