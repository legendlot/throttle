'use client';
/* ════════════════════════════════════════════════════════════
   PRODUCTS — read-only product / EAN directory. Surfaces
   public.product_master so anyone with a Depot login can look up
   a product's EAN / SKU / internal code (no cost or stock data).
   Data: getProductDirectory (lotopsproxy GET, session-only auth).
   ════════════════════════════════════════════════════════════ */
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { Copy, Download } from 'lucide-react';
import { useRefreshState } from '../layout.js';
import { Icon, Panel, FilterChip, ToneBadge, fmt, btnGhost, inputStyle } from '../../../components/kit/index.js';
import { todayStr } from '@throttle/domain';

const TYPE_TABS = [
  { value: '',       label: 'All'     },
  { value: 'car',    label: 'Cars'    },
  { value: 'remote', label: 'Remotes' },
];

const thStyle = { padding: '0 14px 9px', whiteSpace: 'nowrap' };
const tdBase  = { padding: '11px 14px', borderTop: '1px solid var(--border)', whiteSpace: 'nowrap', verticalAlign: 'middle' };

function compType(r) {
  return String(r.component_type || '').toLowerCase() === 'remote' ? 'remote' : 'car';
}

export default function ProductsPage() {
  const { session } = useAuth();
  const { showToast } = useToast();
  const { setRefreshing, setLastRefreshed } = useRefreshState();
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ]             = useState('');
  const [typeF, setTypeF]     = useState('');
  const [activeOnly, setActiveOnly] = useState(true);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true); setRefreshing(true);
    try {
      const data = await garageFetch('getProductDirectory', {}, session);
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      showToast('Failed to load products: ' + (e.message || e), 'error');
      setRows([]);
    }
    setLoading(false); setRefreshing(false); setLastRefreshed(new Date());
  }, [session, showToast, setRefreshing, setLastRefreshed]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter(r => {
      if (activeOnly && r.is_active === false) return false;
      if (typeF && compType(r) !== typeF) return false;
      if (!needle) return true;
      return [r.product, r.model, r.color, r.ean, r.sku, r.product_code]
        .some(v => v && String(v).toLowerCase().includes(needle));
    });
  }, [rows, q, typeF, activeOnly]);

  const typeCounts = useMemo(() => {
    const base = rows.filter(r => !activeOnly || r.is_active !== false);
    return {
      '':      base.length,
      car:     base.filter(r => compType(r) === 'car').length,
      remote:  base.filter(r => compType(r) === 'remote').length,
    };
  }, [rows, activeOnly]);

  const copyEan = useCallback((ean) => {
    if (!ean) return;
    navigator.clipboard?.writeText(String(ean))
      .then(() => showToast('EAN copied: ' + ean, 'success'))
      .catch(() => showToast('Copy failed', 'error'));
  }, [showToast]);

  const exportCsv = useCallback(() => {
    const head = ['Product', 'Variant', 'Color', 'EAN', 'SKU', 'Code', 'Type', 'Active'];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [head.join(',')];
    for (const r of filtered) {
      lines.push([
        r.product, r.model, r.color, r.ean, r.sku, r.product_code,
        compType(r) === 'remote' ? 'Remote' : 'Car',
        r.is_active === false ? 'Inactive' : 'Active',
      ].map(esc).join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `product-ean-directory-${todayStr()}.csv`;
    a.click(); URL.revokeObjectURL(url);
  }, [filtered]);

  return (
    <div style={{ fontFamily: 'var(--font-ui)' }}>
      {/* header / controls */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <span style={{ fontSize: 12.5, color: 'var(--t3)' }}>
          Product EAN / SKU directory · read-only · <span className="num">{filtered.length}</span> shown
        </span>
        <button onClick={exportCsv} disabled={!filtered.length} style={{ ...btnGhost, opacity: filtered.length ? 1 : 0.5 }}>
          <Download size={15} strokeWidth={1.75} /> Export CSV
        </button>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16, alignItems: 'center' }}>
        {TYPE_TABS.map(t => (
          <FilterChip key={t.value} active={typeF === t.value} onClick={() => setTypeF(t.value)} count={typeCounts[t.value]}>
            {t.label}
          </FilterChip>
        ))}
        <FilterChip active={activeOnly} onClick={() => setActiveOnly(a => !a)} dot>
          Active only
        </FilterChip>
        <div style={{ flex: 1 }} />
        <input data-search-primary type="search" placeholder="Search product, variant, EAN, SKU, code…  · /"
          value={q} onChange={(e) => setQ(e.target.value)}
          style={{ ...inputStyle, width: 300, padding: '7px 12px', fontSize: 13 }} />
      </div>

      {loading ? (
        <div style={{ padding: 48, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
      ) : filtered.length === 0 ? (
        <Panel pad={0}>
          <div style={{ padding: '48px 0', textAlign: 'center' }}>
            <div style={{ display: 'inline-grid', placeItems: 'center', width: 46, height: 46, borderRadius: '50%',
              background: 'var(--surface-2)', color: 'var(--t3)', border: '1px solid var(--border-2)', marginBottom: 12 }}>
              <Icon name="tag" size={22} /></div>
            <div style={{ fontSize: 14, color: 'var(--t1)', fontWeight: 600 }}>No products match these filters</div>
            <div style={{ fontSize: 12.5, color: 'var(--t3)', marginTop: 3 }}>Adjust the search or filters.</div>
          </div>
        </Panel>
      ) : (
        <Panel pad={0}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th className="eyebrow" style={{ ...thStyle, textAlign: 'left' }}>Product</th>
                  <th className="eyebrow" style={{ ...thStyle, textAlign: 'left' }}>Variant</th>
                  <th className="eyebrow" style={{ ...thStyle, textAlign: 'left' }}>Color</th>
                  <th className="eyebrow" style={{ ...thStyle, textAlign: 'left' }}>EAN</th>
                  <th className="eyebrow" style={{ ...thStyle, textAlign: 'left' }}>SKU</th>
                  <th className="eyebrow" style={{ ...thStyle, textAlign: 'left' }}>Code</th>
                  <th className="eyebrow" style={{ ...thStyle, textAlign: 'center' }}>Type</th>
                  <th className="eyebrow" style={{ ...thStyle, textAlign: 'center' }}>Active</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r, i) => (
                  <tr key={`${r.product_code || r.ean || i}-${i}`}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-2)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                    style={{ transition: 'background 100ms' }}>
                    <td style={{ ...tdBase, color: 'var(--t1)', fontWeight: 600 }}>{r.product || '—'}</td>
                    <td style={{ ...tdBase, color: 'var(--t2)' }}>{r.model || '—'}</td>
                    <td style={{ ...tdBase, color: 'var(--t2)' }}>{r.color || '—'}</td>
                    <td className="num" style={{ ...tdBase }}>
                      {r.ean
                        ? <button onClick={() => copyEan(r.ean)} title="Copy EAN"
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none',
                              cursor: 'pointer', color: 'var(--yellow)', fontWeight: 600, fontFamily: 'var(--font-mono)', fontSize: 13, padding: 0 }}>
                            {r.ean} <Copy size={12.5} strokeWidth={1.75} style={{ opacity: 0.6 }} />
                          </button>
                        : <span style={{ color: 'var(--t4)' }}>—</span>}
                    </td>
                    <td className="num" style={{ ...tdBase, color: 'var(--t2)' }}>{r.sku || '—'}</td>
                    <td className="num" style={{ ...tdBase, color: 'var(--t3)', fontSize: 12.5 }}>{r.product_code || '—'}</td>
                    <td style={{ ...tdBase, textAlign: 'center' }}>
                      <ToneBadge tone={compType(r) === 'remote' ? 'info' : 'mute'}>
                        {compType(r) === 'remote' ? 'Remote' : 'Car'}
                      </ToneBadge>
                    </td>
                    <td style={{ ...tdBase, textAlign: 'center' }}>
                      {r.is_active === false
                        ? <ToneBadge tone="bad">Inactive</ToneBadge>
                        : <ToneBadge tone="ok">Active</ToneBadge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}
