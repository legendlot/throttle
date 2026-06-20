'use client';
import { useState, useEffect, useMemo } from 'react';
import { useAuth, hasPermission } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { EmptyState, Spinner, Combobox, Panel, Chip, StatusBadge, ProductTag } from '@throttle/ui';
import { Search, Download } from 'lucide-react';
import { useProducts } from '../../../hooks/useProducts.js';

// Stock Ledger — restyled to the S128 visual system. All filter / tab / CSV /
// common-parts logic is unchanged; only the chrome (type roles, chips, panel,
// status badges, product tags, mono-only numbers) changed.

const th = { padding: '9px 12px', fontFamily: 'var(--font-display)', fontSize: 10.5, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const td = { padding: '11px 12px', fontSize: 13.5, color: 'var(--t2)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', fontFamily: 'var(--font-ui)' };
const tdNum = { ...td, fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', textAlign: 'right' };
const selectStyle = { background: 'var(--surface)', color: 'var(--t1)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '8px 11px', fontFamily: 'var(--font-ui)', fontSize: 13, minWidth: 140 };
const searchInput = { background: 'transparent', border: 'none', outline: 'none', color: 'var(--t1)', fontFamily: 'var(--font-ui)', fontSize: 13, width: '100%' };
const btnSec = { display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--surface-2)', color: 'var(--t2)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '8px 13px', fontFamily: 'var(--font-display)', fontSize: 12, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', cursor: 'pointer', whiteSpace: 'nowrap' };

function downloadCsv(rows, filename, showCost, supplyMap = {}) {
  const headers = [
    'Part Code', 'Product', 'Part Name', 'Category', 'Type',
    'Opening', 'Received', 'Issued', 'Returned', 'Closing',
    ...(showCost ? ['Unit Cost'] : []),
    'Reorder Point', 'Location', 'Status', 'Supply',
  ];
  const lines = [
    headers,
    ...rows.map(r => {
      const closing = Number(r.closing_stock) || 0;
      const reorder = Number(r.reorder_level) || 0;
      const isLow = reorder > 0 && closing <= reorder;
      const sv = supplyView(r, supplyMap[r.part_code]);
      return [
        r.part_code, r.product, r.part_name, r.category, r.part_type,
        r.opening_stock ?? 0, r.total_received ?? 0, r.total_issued ?? 0, r.returned ?? 0, closing,
        ...(showCost ? [r.unit_cost ?? ''] : []),
        r.reorder_level ?? 0, r.location, isLow ? 'Reorder' : 'OK',
        sv ? sv.title : '',
      ];
    }),
  ];
  const csv = lines.map(l => l.map(v =>
    v == null ? '' : `"${String(v).replace(/"/g, '""')}"`
  ).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// Sentinel for the "Common (UNV/HW)" filter option — cross-product parts have
// `product=''` (RULE-003) so a normal product-equality filter can't pick them.
const COMMON_PRODUCT_KEY = '__common__';

// Per-column sort accessors for the Components ledger. Number accessors sort
// numerically; everything else sorts as a numeric-aware string.
const STOCK_SORT = {
  part:           r => r.part_code || '',
  product:        r => r.product || '',
  category:       r => r.category || '',
  opening_stock:  r => Number(r.opening_stock)  || 0,
  total_received: r => Number(r.total_received) || 0,
  total_issued:   r => Number(r.total_issued)   || 0,
  returned:       r => Number(r.returned)       || 0,
  closing_stock:  r => Number(r.closing_stock)  || 0,
  unit_cost:      r => Number(r.unit_cost)      || 0,
  reorder_level:  r => Number(r.reorder_level)  || 0,
  location:       r => r.location || '',
  status:         r => { const c = Number(r.closing_stock) || 0, ro = Number(r.reorder_level) || 0; return ro > 0 && c <= ro ? 1 : 0; },
};

// Supply tag for a ledger row (getSupplyStatus). Answers "is this part being acted
// on?" — on order / in transit / landed / mis-coded-on-a-dead-code / not-ordered.
const fmtN = (n) => Number(n).toLocaleString('en-IN');
const SUPPLY_TONE = {
  ordered: { fg: 'var(--info-fg)', bg: 'var(--info-bg)', bd: 'var(--info-bd)' },
  moving:  { fg: 'var(--ok-fg)',   bg: 'var(--ok-bg)',   bd: 'var(--ok-bd)' },
  warn:    { fg: 'var(--warn-fg)', bg: 'var(--warn-bg)', bd: 'var(--warn-bd)' },
  bad:     { fg: 'var(--bad-fg)',  bg: 'var(--bad-bg)',  bd: 'var(--bad-bd)' },
};
function supplyView(row, sup) {
  const closing = Number(row.closing_stock) || 0;
  const reorder = Number(row.reorder_level) || 0;
  const isLow = (reorder > 0 && closing <= reorder) || closing < 0;
  if (sup && sup.on_order > 0) {
    const moving = sup.stage === 'In transit' || sup.stage === 'Arrived';
    let label = `${sup.stage} · ${fmtN(sup.on_order)}`;
    let title = `${fmtN(sup.on_order)} on order${sup.source ? ' (' + sup.source + ')' : ''}${sup.eta ? ' · ETA ' + sup.eta : ''}`;
    if (sup.dead_inbound > 0) { label += ' ⚠'; title += ` · plus ${fmtN(sup.dead_inbound)} on dead code ${sup.dead_codes.join(', ')}`; }
    return { label, title, tone: moving ? 'moving' : 'ordered' };
  }
  if (sup && sup.landed > 0) return { label: `Landed · ${fmtN(sup.landed)}`, title: `${fmtN(sup.landed)} landed, awaiting GRN`, tone: 'ordered' };
  if (sup && sup.dead_inbound > 0) return { label: `⚠ ${fmtN(sup.dead_inbound)} on ${sup.dead_codes[0]}`, title: `${fmtN(sup.dead_inbound)} on order on dead code ${sup.dead_codes.join(', ')} — won't replenish ${row.part_code}`, tone: 'warn' };
  if (sup && sup.is_dead) return { label: `→ ${sup.superseded_by}`, title: `Deprecated — superseded by ${sup.superseded_by}`, tone: 'dead' };
  if (isLow) return { label: 'Not ordered', title: 'Low/negative stock and nothing on order', tone: 'bad' };
  return null;
}
function SupplyTag({ row, sup }) {
  const v = supplyView(row, sup);
  if (!v) return <span style={{ color: 'var(--t4)', fontSize: 12 }}>—</span>;
  if (v.tone === 'dead') return <span title={v.title} style={{ fontSize: 11, color: 'var(--t4)', fontFamily: 'var(--font-mono)' }}>{v.label}</span>;
  const t = SUPPLY_TONE[v.tone];
  return <span title={v.title} style={{ display: 'inline-flex', alignItems: 'center', fontSize: 11, fontWeight: 600, color: t.fg, background: t.bg, border: `1px solid ${t.bd}`, borderRadius: 6, padding: '2px 7px', whiteSpace: 'nowrap' }}>{v.label}</span>;
}

export default function StockPage() {
  const { session, perms } = useAuth();
  const { PRODUCTS: CATALOGUE_PRODUCTS } = useProducts();
  const [tab, setTab] = useState('components');

  const [stockData, setStockData] = useState([]);
  const [stockLoading, setStockLoading] = useState(true);
  const [stockError, setStockError] = useState(null);

  const [fbuData, setFbuData] = useState([]);
  const [fbuLoading, setFbuLoading] = useState(true);

  const [supplyMap, setSupplyMap] = useState({});   // part_code → inbound/supply facts

  const [search, setSearch] = useState('');
  const [productFilter, setProductFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [fbuSearch, setFbuSearch] = useState('');
  const [sort, setSort] = useState({ key: 'part', dir: 'asc' });

  const showCost = hasPermission(perms, 'reports_finance');

  function toggleSort(key) {
    setSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' });
  }

  useEffect(() => {
    if (!session) return;
    async function loadStock() {
      setStockLoading(true);
      setStockError(null);
      try {
        const data = await garageFetch('getStock', {}, session);
        setStockData(data || []);
      } catch (e) {
        setStockError(e.message);
      } finally {
        setStockLoading(false);
      }
    }
    async function loadFbu() {
      setFbuLoading(true);
      try {
        const data = await garageFetch('getFbuStock', {}, session);
        setFbuData(data || []);
      } catch (e) {
        setFbuData([]);
      } finally {
        setFbuLoading(false);
      }
    }
    async function loadSupply() {
      try {
        const data = await garageFetch('getSupplyStatus', {}, session);
        setSupplyMap(data || {});
      } catch (e) { setSupplyMap({}); }
    }
    loadStock();
    loadFbu();
    loadSupply();
  }, [session]);

  const stockProducts = useMemo(() => [...new Set(stockData.map(r => r.product).filter(Boolean))].sort(), [stockData]);
  const products = useMemo(() => {
    const fromCatalogue = (CATALOGUE_PRODUCTS && CATALOGUE_PRODUCTS.length) ? CATALOGUE_PRODUCTS : stockProducts;
    return [...new Set([...fromCatalogue, ...stockProducts])].sort();
  }, [CATALOGUE_PRODUCTS, stockProducts]);
  const categories = useMemo(() => [...new Set(stockData.map(r => r.category).filter(Boolean))].sort(), [stockData]);
  const types = useMemo(() => [...new Set(stockData.map(r => r.part_type).filter(Boolean))].sort(), [stockData]);

  const filteredStock = useMemo(() => {
    const tokens = (search || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
    return stockData.filter(r => {
      if (tokens.length) {
        const fields = [r.part_code, r.part_name, r.product, r.category, r.part_type]
          .map((v) => (v || '').toLowerCase());
        for (const t of tokens) {
          if (!fields.some((f) => f.includes(t))) return false;
        }
      }
      if (productFilter === COMMON_PRODUCT_KEY) {
        if (r.product && r.product !== '') return false;
      } else if (productFilter && r.product !== productFilter) {
        return false;
      }
      if (categoryFilter && r.category !== categoryFilter) return false;
      if (typeFilter && r.part_type !== typeFilter) return false;
      if (statusFilter === 'low') {
        const closing = Number(r.closing_stock) || 0;
        const reorder = Number(r.reorder_level) || 0;
        if (!(reorder > 0 && closing <= reorder)) return false;
      }
      if (statusFilter === 'ok') {
        const closing = Number(r.closing_stock) || 0;
        const reorder = Number(r.reorder_level) || 0;
        if (reorder > 0 && closing <= reorder) return false;
      }
      return true;
    });
  }, [stockData, search, productFilter, categoryFilter, typeFilter, statusFilter]);

  const sortedStock = useMemo(() => {
    const acc = STOCK_SORT[sort.key] || STOCK_SORT.part;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...filteredStock].sort((a, b) => {
      const va = acc(a), vb = acc(b);
      let cmp;
      if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb;
      else cmp = String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' });
      // stable tiebreak on part_code so equal values keep a deterministic order
      if (cmp === 0) cmp = String(a.part_code || '').localeCompare(String(b.part_code || ''), undefined, { numeric: true });
      return cmp * dir;
    });
  }, [filteredStock, sort]);

  const filteredFbu = useMemo(() => {
    const f = fbuSearch.toLowerCase();
    if (!f) return fbuData;
    return fbuData.filter(r =>
      (r.product || '').toLowerCase().includes(f) ||
      (r.variant || '').toLowerCase().includes(f) ||
      (r.color || '').toLowerCase().includes(f)
    );
  }, [fbuData, fbuSearch]);

  function clearFilters() {
    setSearch(''); setProductFilter(''); setCategoryFilter(''); setTypeFilter(''); setStatusFilter('');
  }

  function handleDownloadCsv() {
    const today = new Date().toISOString().slice(0, 10);
    const slug = productFilter
      ? productFilter.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      : 'all';
    downloadCsv(sortedStock, `stock-ledger-${slug}-${today}.csv`, showCost, supplyMap);
  }

  const lowCount = useMemo(() => stockData.filter(r => {
    const c = Number(r.closing_stock) || 0, ro = Number(r.reorder_level) || 0;
    return ro > 0 && c <= ro;
  }).length, [stockData]);

  function SortableTh({ colKey, align, children }) {
    const active = sort.key === colKey;
    return (
      <th
        style={{ ...th, ...(align === 'right' ? { textAlign: 'right' } : {}), cursor: 'pointer', userSelect: 'none' }}
        onClick={() => toggleSort(colKey)}
        title="Sort by this column"
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, justifyContent: align === 'right' ? 'flex-end' : 'flex-start', color: active ? 'var(--t1)' : undefined }}>
          {children}
          <span style={{ fontSize: 9, opacity: active ? 1 : 0.3 }}>{active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
        </span>
      </th>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, marginBottom: 18, flexWrap: 'wrap' }}>
        <div>
          <div className="eyebrow" style={{ marginBottom: 5 }}>Inventory</div>
          <h1 className="title" style={{ fontSize: 27, lineHeight: 1, margin: 0 }}>Stock Ledger</h1>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <span className="num" style={{ fontSize: 12, color: 'var(--t3)' }}>{stockData.length} parts · {lowCount} at reorder</span>
          {tab === 'components' && <button style={btnSec} onClick={handleDownloadCsv} disabled={filteredStock.length === 0}><Download size={14} strokeWidth={1.75} />Export</button>}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 7, marginBottom: 14 }}>
        <Chip active={tab === 'components'} onClick={() => setTab('components')}>Components</Chip>
        <Chip active={tab === 'fbu'} onClick={() => setTab('fbu')}>FBU Units</Chip>
      </div>

      {tab === 'components' ? (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '7px 11px', minWidth: 280 }}>
              <Search size={15} strokeWidth={1.75} style={{ color: 'var(--t4)' }} />
              <input data-search-primary style={searchInput} value={search} onChange={e => setSearch(e.target.value)} placeholder="Search — try “Flare metal” or “Shadow packaging” · /" />
            </div>
            <div style={{ minWidth: 200 }}>
              <Combobox
                value={productFilter}
                options={[
                  { value: COMMON_PRODUCT_KEY, label: 'Common (UNV/HW)', hint: 'cross-product' },
                  ...products.map((p) => ({ value: p, label: p })),
                ]}
                onChange={(v) => setProductFilter(v)}
                placeholder="All products"
              />
            </div>
            <select style={selectStyle} value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
              <option value="">All Types</option>
              {types.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <select style={selectStyle} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
              <option value="">All Status</option>
              <option value="low">Low / Reorder</option>
              <option value="ok">OK</option>
            </select>
            <button style={btnSec} onClick={clearFilters}>Clear</button>
          </div>

          {/* category filter chips */}
          {categories.length > 0 && (
            <div style={{ display: 'flex', gap: 7, marginBottom: 14, flexWrap: 'wrap' }}>
              <Chip pill active={!categoryFilter} onClick={() => setCategoryFilter('')} count={stockData.length}>All</Chip>
              {categories.map(c => (
                <Chip key={c} pill active={categoryFilter === c} onClick={() => setCategoryFilter(c)} count={stockData.filter(r => r.category === c).length}>{c}</Chip>
              ))}
            </div>
          )}

          {stockLoading ? (
            <div style={{ padding: 40, textAlign: 'center' }}><Spinner /></div>
          ) : stockError ? (
            <EmptyState message={stockError} />
          ) : filteredStock.length === 0 ? (
            <EmptyState message="No stock rows match the current filters" />
          ) : (
            <Panel padding={0}>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <SortableTh colKey="part">Part</SortableTh>
                      <SortableTh colKey="product">Product</SortableTh>
                      <SortableTh colKey="category">Category</SortableTh>
                      <SortableTh colKey="opening_stock" align="right">Open</SortableTh>
                      <SortableTh colKey="total_received" align="right">Recv</SortableTh>
                      <SortableTh colKey="total_issued" align="right">Iss</SortableTh>
                      <SortableTh colKey="returned" align="right">Ret</SortableTh>
                      <SortableTh colKey="closing_stock" align="right">Close</SortableTh>
                      {showCost && <SortableTh colKey="unit_cost" align="right">Cost</SortableTh>}
                      <SortableTh colKey="reorder_level" align="right">Reorder</SortableTh>
                      <SortableTh colKey="location">Loc</SortableTh>
                      <SortableTh colKey="status">Status</SortableTh>
                      <th style={th}>Supply</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedStock.map((r, i) => {
                      const closing = Number(r.closing_stock) || 0;
                      const reorder = Number(r.reorder_level) || 0;
                      const recv = Number(r.total_received) || 0;
                      const ret = Number(r.returned) || 0;
                      const isLow = reorder > 0 && closing <= reorder;
                      return (
                        <tr key={r.part_code || i} className="g-row">
                          <td style={td}>
                            <div style={{ fontWeight: 600, color: 'var(--t1)' }}>{r.part_name || '—'}</div>
                            <div className="num" style={{ fontSize: 11.5, color: 'var(--t3)' }}>{r.part_code || '—'}</div>
                          </td>
                          <td style={td}>{r.product ? <ProductTag name={r.product} /> : <span style={{ color: 'var(--t4)', fontSize: 12 }}>Common</span>}</td>
                          <td style={td}><span style={{ fontSize: 12, color: 'var(--t3)' }}>{r.category || '—'}</span></td>
                          <td style={tdNum}>{r.opening_stock ?? 0}</td>
                          <td style={{ ...tdNum, color: recv ? 'var(--ok-fg)' : 'var(--t4)' }}>{recv ? '+' + recv : '—'}</td>
                          <td style={{ ...tdNum, color: 'var(--t2)' }}>{r.total_issued ?? 0}</td>
                          <td style={{ ...tdNum, color: ret ? 'var(--info-fg)' : 'var(--t4)' }}>{ret || '—'}</td>
                          <td style={{ ...tdNum, fontWeight: 600, color: isLow ? 'var(--bad-fg)' : 'var(--t1)' }}>{closing}</td>
                          {showCost && <td style={tdNum}>{r.unit_cost != null ? '₹' + Number(r.unit_cost).toLocaleString('en-IN') : '—'}</td>}
                          <td style={{ ...tdNum, color: 'var(--t3)' }}>{r.reorder_level ?? 0}</td>
                          <td style={td}><span className="num" style={{ fontSize: 11.5, color: 'var(--t3)' }}>{r.location || '—'}</span></td>
                          <td style={td}>{isLow ? <StatusBadge variant="error">Reorder</StatusBadge> : <StatusBadge variant="success">OK</StatusBadge>}</td>
                          <td style={td}><SupplyTag row={r} sup={supplyMap[r.part_code]} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}
        </>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '7px 11px', minWidth: 240, maxWidth: 320, marginBottom: 14 }}>
            <Search size={15} strokeWidth={1.75} style={{ color: 'var(--t4)' }} />
            <input style={searchInput} value={fbuSearch} onChange={e => setFbuSearch(e.target.value)} placeholder="Filter FBU units…" />
          </div>

          {fbuLoading ? (
            <div style={{ padding: 40, textAlign: 'center' }}><Spinner /></div>
          ) : filteredFbu.length === 0 ? (
            <EmptyState message="No FBU stock on hand" />
          ) : (
            <Panel padding={0}>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={th}>Product</th>
                      <th style={th}>Variant</th>
                      <th style={th}>Colour</th>
                      <th style={{ ...th, textAlign: 'right' }}>On Hand</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredFbu.map((r, i) => {
                      const qty = Number(r.qty_on_hand) || 0;
                      return (
                        <tr key={i} className="g-row">
                          <td style={td}>{r.product ? <ProductTag name={r.product} /> : '—'}</td>
                          <td style={td}>{r.variant || '—'}</td>
                          <td style={td}>{r.color || '—'}</td>
                          <td style={{ ...tdNum, fontWeight: 600, color: qty > 0 ? 'var(--ok-fg)' : 'var(--t4)' }}>{qty}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
