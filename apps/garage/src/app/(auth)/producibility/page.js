'use client';
import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, EmptyState } from '@throttle/ui';

// ─── helpers ────────────────────────────────────────────────────────────────

function fmtIST(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit', minute: '2-digit',
  });
}

function statusColor(n) {
  if (n === 0)   return '#ef4444';
  if (n < 100)   return '#f97316';
  if (n < 500)   return '#eab308';
  return '#22c55e';
}

function statusLabel(n) {
  if (n === 0)   return 'BLOCKED';
  if (n < 100)   return 'CRITICAL';
  if (n < 500)   return 'LOW';
  return 'HEALTHY';
}

const TAB_BTN = (active) => ({
  padding: '6px 16px',
  border: '1px solid var(--border)',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 600,
  background: active ? 'var(--accent)' : 'transparent',
  color:      active ? '#000'          : 'var(--fg)',
});

// ─── sub-views ───────────────────────────────────────────────────────────────

function SummaryView({ products, onSelectProduct }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
      {products.map(p => {
        const col = statusColor(p.producible);
        const bn  = p.variants[0]?.bottleneck;
        return (
          <div
            key={p.product}
            onClick={() => onSelectProduct(p.product)}
            style={{
              background: 'var(--surface)', border: `1px solid var(--border)`,
              borderRadius: 6, padding: '16px 18px', cursor: 'pointer',
              borderTop: `3px solid ${col}`,
              transition: 'opacity 0.15s',
            }}
            onMouseEnter={e => e.currentTarget.style.opacity = '0.85'}
            onMouseLeave={e => e.currentTarget.style.opacity = '1'}
          >
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, color: 'var(--fg-muted)', marginBottom: 6 }}>
              {p.product.toUpperCase()}
              {p.has_variants && <span style={{ marginLeft: 6, fontWeight: 400 }}>{p.variants.length} variants</span>}
            </div>
            <div style={{ fontSize: 40, fontWeight: 800, color: col, lineHeight: 1, marginBottom: 4 }}>
              {p.producible.toLocaleString()}
            </div>
            <div style={{ fontSize: 11, color: col, fontWeight: 700, marginBottom: 10 }}>
              {statusLabel(p.producible)}
            </div>
            {bn && (
              <div style={{ fontSize: 11, color: 'var(--fg-muted)', borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                <span style={{ fontFamily: 'monospace' }}>{bn.part_code}</span>
                <div style={{ marginTop: 2 }}>{bn.part_name}</div>
                <div style={{ marginTop: 2 }}>Stock: {bn.stock.toLocaleString()} · Need: {bn.qty_per_unit}/unit</div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function BreakdownView({ products }) {
  const [selectedProduct, setSelectedProduct] = useState(products[0]?.product || '');
  const product = products.find(p => p.product === selectedProduct);

  return (
    <div>
      {/* Product selector */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 20 }}>
        {products.map(p => (
          <button
            key={p.product}
            onClick={() => setSelectedProduct(p.product)}
            style={{
              padding: '4px 12px', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600,
              border: '1px solid var(--border)',
              background: p.product === selectedProduct ? 'var(--accent)' : 'transparent',
              color:      p.product === selectedProduct ? '#000'          : 'var(--fg)',
            }}
          >
            {p.product}
          </button>
        ))}
      </div>

      {product && (
        <>
          {/* Variant summary table */}
          {product.has_variants && (
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--fg-muted)', letterSpacing: 1, marginBottom: 8 }}>
                VARIANTS
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    {['Variant', 'Producible', 'Status', 'Bottleneck Part', 'Stock', 'Per Unit'].map(h => (
                      <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, fontSize: 11, color: 'var(--fg-muted)', letterSpacing: 0.5 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {product.variants.map(v => {
                    const col = statusColor(v.producible);
                    return (
                      <tr key={v.variant_model} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{ padding: '8px 10px', fontWeight: 600 }}>{v.variant_model}</td>
                        <td style={{ padding: '8px 10px', fontWeight: 800, color: col, fontFamily: 'monospace' }}>{v.producible.toLocaleString()}</td>
                        <td style={{ padding: '8px 10px' }}>
                          <span style={{ background: col + '22', color: col, padding: '2px 8px', borderRadius: 3, fontSize: 11, fontWeight: 700 }}>
                            {statusLabel(v.producible)}
                          </span>
                        </td>
                        <td style={{ padding: '8px 10px', fontFamily: 'monospace', fontSize: 12 }}>{v.bottleneck?.part_name || '—'}</td>
                        <td style={{ padding: '8px 10px', fontFamily: 'monospace' }}>{v.bottleneck ? v.bottleneck.stock.toLocaleString() : '—'}</td>
                        <td style={{ padding: '8px 10px', fontFamily: 'monospace' }}>{v.bottleneck?.qty_per_unit ?? '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Top constraints for first (or only) variant */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--fg-muted)', letterSpacing: 1, marginBottom: 8 }}>
              TOP CONSTRAINTS {product.has_variants ? `— ${product.variants[0]?.variant_model}` : ''}
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Part Code', 'Part Name', 'Category', 'Stock', 'Per Unit', 'Max Units'].map(h => (
                    <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, fontSize: 11, color: 'var(--fg-muted)', letterSpacing: 0.5 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(product.variants[0]?.top_constraints || []).map((c, i) => {
                  const col = statusColor(c.possible);
                  return (
                    <tr key={c.part_code} style={{ borderBottom: '1px solid var(--border)', background: i === 0 ? 'var(--surface)' : 'transparent' }}>
                      <td style={{ padding: '7px 10px', fontFamily: 'monospace', fontSize: 12 }}>{c.part_code}</td>
                      <td style={{ padding: '7px 10px' }}>{c.part_name}</td>
                      <td style={{ padding: '7px 10px', fontSize: 11, color: 'var(--fg-muted)' }}>{c.part_category || '—'}</td>
                      <td style={{ padding: '7px 10px', fontFamily: 'monospace' }}>{c.stock.toLocaleString()}</td>
                      <td style={{ padding: '7px 10px', fontFamily: 'monospace' }}>{c.qty_per_unit}</td>
                      <td style={{ padding: '7px 10px', fontFamily: 'monospace', fontWeight: 700, color: col }}>{c.possible.toLocaleString()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function BottlenecksView({ parts }) {
  if (!parts.length) return <div style={{ color: 'var(--fg-muted)', fontSize: 13 }}>No bottleneck data available.</div>;
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr style={{ borderBottom: '1px solid var(--border)' }}>
          {['Part Code', 'Part Name', 'Stock', 'Products Blocked', 'Blocked Products'].map(h => (
            <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, fontSize: 11, color: 'var(--fg-muted)', letterSpacing: 0.5 }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {parts.map(p => (
          <tr key={p.part_code} style={{ borderBottom: '1px solid var(--border)' }}>
            <td style={{ padding: '8px 10px', fontFamily: 'monospace', fontSize: 12 }}>{p.part_code}</td>
            <td style={{ padding: '8px 10px' }}>{p.part_name}</td>
            <td style={{ padding: '8px 10px', fontFamily: 'monospace', color: p.stock === 0 ? '#ef4444' : 'var(--fg)' }}>
              {p.stock.toLocaleString()}
            </td>
            <td style={{ padding: '8px 10px', fontFamily: 'monospace', fontWeight: 700 }}>{p.products_affected}</td>
            <td style={{ padding: '8px 10px', fontSize: 12, color: 'var(--fg-muted)' }}>
              {p.limited.map(l => l.product).join(', ')}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─── main page ───────────────────────────────────────────────────────────────

export default function ProducibilityPage() {
  const { session } = useAuth();
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [view, setView]       = useState('summary'); // 'summary' | 'breakdown' | 'bottlenecks'
  const [drillProduct, setDrillProduct] = useState(null);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setError(null);
    try {
      const d = await garageFetch('getProducibility', {}, session);
      setData(d);
    } catch (e) {
      setError('Failed to load producibility data.');
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => { load(); }, [load]);

  function handleSelectProduct(product) {
    setDrillProduct(product);
    setView('breakdown');
  }

  // KPI helpers
  const totalBuildable = data ? data.products.filter(p => p.producible > 0).length : 0;
  const totalUnits     = data ? data.products.reduce((s, p) => s + p.producible, 0) : 0;
  const mostCritical   = data ? [...data.products].sort((a, b) => a.producible - b.producible)[0] : null;

  // Pass selected product into breakdown as initial selection
  const breakdownProducts = data?.products
    ? drillProduct
      ? [data.products.find(p => p.product === drillProduct), ...data.products.filter(p => p.product !== drillProduct)].filter(Boolean)
      : data.products
    : [];

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1200 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>Producibility</h1>
          {data && (
            <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 3 }}>
              As of {fmtIST(data.generated_at)} IST
            </div>
          )}
        </div>
        <button
          onClick={load}
          disabled={loading}
          style={{ padding: '7px 16px', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', background: 'transparent', color: 'var(--fg)', fontSize: 13 }}
        >
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
      </div>

      {loading && !data && <div style={{ padding: 40, textAlign: 'center' }}><Spinner /></div>}
      {error   && <EmptyState title="Error" description={error} />}

      {data && (
        <>
          {/* KPI row */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 24 }}>
            {[
              { label: 'PRODUCTS WITH STOCK', value: `${totalBuildable} / ${data.products.length}` },
              { label: 'TOTAL BUILDABLE UNITS', value: totalUnits.toLocaleString() },
              { label: 'MOST CRITICAL', value: mostCritical ? `${mostCritical.product} — ${mostCritical.producible} units` : '—', color: mostCritical ? statusColor(mostCritical.producible) : undefined },
            ].map(k => (
              <div key={k.label} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '14px 18px' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--fg-muted)', letterSpacing: 1, marginBottom: 6 }}>{k.label}</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: k.color || 'var(--fg)' }}>{k.value}</div>
              </div>
            ))}
          </div>

          {/* View tabs */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 20 }}>
            {[['summary', 'Summary'], ['breakdown', 'By Product'], ['bottlenecks', 'Bottlenecks']].map(([v, label]) => (
              <button key={v} onClick={() => setView(v)} style={TAB_BTN(view === v)}>{label}</button>
            ))}
          </div>

          {/* Content */}
          {view === 'summary'     && <SummaryView    products={data.products}           onSelectProduct={handleSelectProduct} />}
          {view === 'breakdown'   && (
            <>
              <button
                onClick={() => { setView('summary'); setDrillProduct(null); }}
                style={{ background: 'transparent', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 13, padding: '0 0 16px 0', display: 'flex', alignItems: 'center', gap: 4 }}
              >
                ← All Products
              </button>
              <BreakdownView products={breakdownProducts} />
            </>
          )}
          {view === 'bottlenecks' && <BottlenecksView parts={data.bottleneck_parts} />}
        </>
      )}
    </div>
  );
}
