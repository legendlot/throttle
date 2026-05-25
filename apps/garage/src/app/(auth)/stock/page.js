'use client';
import { useState, useEffect, useMemo } from 'react';
import { useAuth, hasPermission } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { EmptyState, Spinner, Combobox } from '@throttle/ui';
import { useProducts } from '../../../hooks/useProducts.js';

const btnBase = {
  padding: '6px 14px', borderRadius: 4, cursor: 'pointer',
  fontFamily: 'var(--mono)', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1,
  border: '1px solid var(--border)',
};
const btnPrimary   = { ...btnBase, background: 'var(--yellow)', color: '#000', borderColor: 'var(--yellow)' };
const btnSecondary = { ...btnBase, background: 'var(--surface)', color: 'var(--t2)' };

const inputStyle = {
  background: 'var(--surface)', color: 'var(--t1)', border: '1px solid var(--border)',
  borderRadius: 4, padding: '6px 10px', fontFamily: 'var(--mono)', fontSize: 12, minWidth: 140,
};

const tableTdStyle = { padding: '9px 10px', fontSize: 12, borderBottom: '1px solid rgba(42,42,42,.6)', whiteSpace: 'nowrap' };
const tableThStyle = {
  padding: '8px 10px', fontSize: 10, textAlign: 'left', color: 'var(--t3)',
  textTransform: 'uppercase', letterSpacing: '0.08em', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
};

function Badge({ label, tone }) {
  // Use state-bg + state-fg (PATTERN-054). Previous `${color}22` interpolation
  // was broken — it produced `var(--red)22`, not a valid color, so the background
  // never rendered. Now uses pre-defined state-bg / state-fg pairs.
  const bg = tone === 'red' ? 'var(--state-error-bg)' : 'var(--state-success-bg)';
  const fg = tone === 'red' ? 'var(--state-error-fg)' : 'var(--state-success-fg)';
  return (
    <span style={{
      padding: '2px 6px', borderRadius: 3, fontFamily: 'var(--mono)',
      fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5,
      background: bg, color: fg,
    }}>{label}</span>
  );
}

function downloadCsv(rows, filename, showCost) {
  const headers = [
    'Part Code', 'Product', 'Part Name', 'Category', 'Type',
    'Opening', 'Received', 'Issued', 'Returned', 'Closing',
    ...(showCost ? ['Unit Cost'] : []),
    'Reorder Point', 'Location', 'Status',
  ];
  const lines = [
    headers,
    ...rows.map(r => {
      const closing = Number(r.closing_stock) || 0;
      const reorder = Number(r.reorder_level) || 0;
      const isLow = reorder > 0 && closing <= reorder;
      return [
        r.part_code, r.product, r.part_name, r.category, r.part_type,
        r.opening_stock ?? 0, r.total_received ?? 0, r.total_issued ?? 0, r.returned ?? 0, closing,
        ...(showCost ? [r.unit_cost ?? ''] : []),
        r.reorder_level ?? 0, r.location, isLow ? 'Reorder' : 'OK',
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

export default function StockPage() {
  const { session, perms } = useAuth();
  const { PRODUCTS: CATALOGUE_PRODUCTS } = useProducts();
  const [tab, setTab] = useState('components');

  const [stockData, setStockData] = useState([]);
  const [stockLoading, setStockLoading] = useState(true);
  const [stockError, setStockError] = useState(null);

  const [fbuData, setFbuData] = useState([]);
  const [fbuLoading, setFbuLoading] = useState(true);

  const [search, setSearch] = useState('');
  const [productFilter, setProductFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [fbuSearch, setFbuSearch] = useState('');

  const showCost = hasPermission(perms, 'reports_finance');

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
    loadStock();
    loadFbu();
  }, [session]);

  // Categories + types are still derived from stockData (only what exists in
  // the ledger today is filterable). Products are pulled from the canonical
  // product_master catalogue so all registered products show — including ones
  // that don't yet have any BOM / stock rows. Falls back to stockData-derived
  // list while the catalogue is loading.
  const stockProducts = useMemo(() => [...new Set(stockData.map(r => r.product).filter(Boolean))].sort(), [stockData]);
  const products      = useMemo(() => {
    const fromCatalogue = (CATALOGUE_PRODUCTS && CATALOGUE_PRODUCTS.length) ? CATALOGUE_PRODUCTS : stockProducts;
    // Union with anything in stockData that isn't in the catalogue (defensive — never lose visibility).
    return [...new Set([...fromCatalogue, ...stockProducts])].sort();
  }, [CATALOGUE_PRODUCTS, stockProducts]);
  const categories = useMemo(() => [...new Set(stockData.map(r => r.category).filter(Boolean))].sort(), [stockData]);
  const types      = useMemo(() => [...new Set(stockData.map(r => r.part_type).filter(Boolean))].sort(), [stockData]);

  // Multi-token search: split the query on whitespace, treat each token as a
  // sub-filter that must match at least one of part_code / part_name / product
  // / category / part_type. Lets users type "Flare metal" or "Shadow packaging"
  // and get the intuitive result. Single-token queries match the same fields.
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
        // Common (UNV/HW) — RULE-003 says product='' for cross-product parts.
        if (r.product && r.product !== '') return false;
      } else if (productFilter && r.product !== productFilter) {
        return false;
      }
      if (categoryFilter && r.category !== categoryFilter) return false;
      if (typeFilter     && r.part_type !== typeFilter)    return false;
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

  const filteredFbu = useMemo(() => {
    const f = fbuSearch.toLowerCase();
    if (!f) return fbuData;
    return fbuData.filter(r =>
      (r.product || '').toLowerCase().includes(f) ||
      (r.variant || '').toLowerCase().includes(f) ||
      (r.color   || '').toLowerCase().includes(f)
    );
  }, [fbuData, fbuSearch]);

  function clearFilters() {
    setSearch('');
    setProductFilter('');
    setCategoryFilter('');
    setTypeFilter('');
    setStatusFilter('');
  }

  function handleDownloadCsv() {
    const today = new Date().toISOString().slice(0, 10);
    const slug = productFilter
      ? productFilter.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      : 'all';
    downloadCsv(filteredStock, `stock-ledger-${slug}-${today}.csv`, showCost);
  }

  return (
    <div style={{ padding: '16px 24px', color: 'var(--t1)' }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontFamily: 'var(--cond)', fontSize: 28, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.03em', margin: 0 }}>
          Stock Ledger
        </h1>
        <p style={{ color: 'var(--t3)', fontSize: 12, margin: '4px 0 0', fontFamily: 'var(--mono)' }}>
          Live inventory position per part code
        </p>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button style={tab === 'components' ? btnPrimary : btnSecondary} onClick={() => setTab('components')}>
          Components
        </button>
        <button style={tab === 'fbu' ? btnPrimary : btnSecondary} onClick={() => setTab('fbu')}>
          FBU Units
        </button>
      </div>

      {tab === 'components' ? (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            <input
              style={{ ...inputStyle, minWidth: 260 }}
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search — try “Flare metal” or “Shadow packaging”"
            />
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
            <select style={inputStyle} value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}>
              <option value="">All Categories</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select style={inputStyle} value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
              <option value="">All Types</option>
              {types.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <select style={inputStyle} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
              <option value="">All Status</option>
              <option value="low">Low / Reorder</option>
              <option value="ok">OK</option>
            </select>
            <button style={btnSecondary} onClick={clearFilters}>Clear</button>
            <button style={btnSecondary} onClick={handleDownloadCsv} disabled={filteredStock.length === 0}>Download CSV</button>
          </div>

          {stockLoading ? (
            <div style={{ padding: 32, textAlign: 'center' }}><Spinner /></div>
          ) : stockError ? (
            <EmptyState message={stockError} />
          ) : filteredStock.length === 0 ? (
            <EmptyState message="No stock rows match the current filters" />
          ) : (
            <div style={{ overflowX: 'auto', background: 'var(--surface)', borderRadius: 6 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={tableThStyle}>Part Code</th>
                    <th style={tableThStyle}>Product</th>
                    <th style={tableThStyle}>Part Name</th>
                    <th style={tableThStyle}>Category</th>
                    <th style={tableThStyle}>Type</th>
                    <th style={tableThStyle}>Opening</th>
                    <th style={tableThStyle}>Received</th>
                    <th style={tableThStyle}>Issued</th>
                    <th style={tableThStyle}>Returned</th>
                    <th style={tableThStyle}>Closing</th>
                    {showCost && <th style={tableThStyle}>Unit Cost</th>}
                    <th style={tableThStyle}>Reorder</th>
                    <th style={tableThStyle}>Location</th>
                    <th style={tableThStyle}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredStock.map((r, i) => {
                    const closing = Number(r.closing_stock) || 0;
                    const reorder = Number(r.reorder_level) || 0;
                    const isLow = reorder > 0 && closing <= reorder;
                    return (
                      <tr key={r.part_code || i}>
                        <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontSize: 11 }}>{r.part_code || '—'}</td>
                        <td style={tableTdStyle}>{r.product || '—'}</td>
                        <td style={tableTdStyle}>{r.part_name || '—'}</td>
                        <td style={tableTdStyle}>{r.category || '—'}</td>
                        <td style={tableTdStyle}>{r.part_type || '—'}</td>
                        <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{r.opening_stock ?? 0}</td>
                        <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--state-success-fg)' }}>{r.total_received ?? 0}</td>
                        <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: '#f87171' }}>{r.total_issued ?? 0}</td>
                        <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--state-info-fg)' }}>{r.returned ?? 0}</td>
                        <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontWeight: 700, color: isLow ? 'var(--red)' : undefined }}>
                          {closing}
                        </td>
                        {showCost && (
                          <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>
                            {r.unit_cost !== undefined && r.unit_cost !== null
                              ? '₹' + Number(r.unit_cost).toLocaleString('en-IN')
                              : '—'}
                          </td>
                        )}
                        <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--t3)' }}>{r.reorder_level ?? 0}</td>
                        <td style={{ ...tableTdStyle, fontSize: 11, color: 'var(--t3)' }}>{r.location || '—'}</td>
                        <td style={tableTdStyle}>
                          {isLow ? <Badge label="Reorder" tone="red" /> : <Badge label="OK" tone="green" />}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        <>
          <div style={{ marginBottom: 12 }}>
            <input
              style={inputStyle}
              value={fbuSearch}
              onChange={e => setFbuSearch(e.target.value)}
              placeholder="Filter..."
            />
          </div>

          {fbuLoading ? (
            <div style={{ padding: 32, textAlign: 'center' }}><Spinner /></div>
          ) : filteredFbu.length === 0 ? (
            <EmptyState message="No FBU stock on hand" />
          ) : (
            <div style={{ overflowX: 'auto', background: 'var(--surface)', borderRadius: 6 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={tableThStyle}>Product</th>
                    <th style={tableThStyle}>Variant</th>
                    <th style={tableThStyle}>Colour</th>
                    <th style={tableThStyle}>On Hand</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredFbu.map((r, i) => {
                    const qty = Number(r.qty_on_hand) || 0;
                    return (
                      <tr key={i}>
                        <td style={tableTdStyle}>{r.product || '—'}</td>
                        <td style={tableTdStyle}>{r.variant || '—'}</td>
                        <td style={tableTdStyle}>{r.color || '—'}</td>
                        <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontWeight: 700, color: qty > 0 ? 'var(--green)' : 'var(--t3)' }}>
                          {qty}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
