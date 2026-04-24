'use client';
import { useState, useEffect, useMemo } from 'react';
import { useAuth, hasPermission } from '@throttle/auth';
import { workerFetch } from '@throttle/db';
import { EmptyState, Spinner } from '@throttle/ui';

const btnBase = {
  padding: '6px 14px', borderRadius: 4, cursor: 'pointer',
  fontFamily: 'var(--mono)', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1,
  border: '1px solid var(--surface2)',
};
const btnPrimary   = { ...btnBase, background: 'var(--yellow)', color: '#000', borderColor: 'var(--yellow)' };
const btnSecondary = { ...btnBase, background: 'var(--surface)', color: 'var(--t2)' };

const inputStyle = {
  background: 'var(--surface)', color: 'var(--t1)', border: '1px solid var(--surface2)',
  borderRadius: 4, padding: '6px 10px', fontFamily: 'var(--mono)', fontSize: 12, minWidth: 140,
};

const tableTdStyle = { padding: '6px 10px', fontSize: 12, borderBottom: '1px solid var(--surface2)' };
const tableThStyle = {
  padding: '6px 10px', fontSize: 11, textAlign: 'left', color: 'var(--t3)',
  textTransform: 'uppercase', letterSpacing: 1, borderBottom: '1px solid var(--surface2)',
};

function Badge({ label, tone }) {
  const color = tone === 'red' ? 'var(--red)' : 'var(--green)';
  return (
    <span style={{
      padding: '2px 6px', borderRadius: 3, fontFamily: 'var(--mono)',
      fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5,
      background: `${color}22`, color,
    }}>{label}</span>
  );
}

export default function StockPage() {
  const { session, perms } = useAuth();
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
        const data = await workerFetch('getStock', {}, session);
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
        const data = await workerFetch('getFbuStock', {}, session);
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

  const products   = useMemo(() => [...new Set(stockData.map(r => r.product).filter(Boolean))].sort(), [stockData]);
  const categories = useMemo(() => [...new Set(stockData.map(r => r.category).filter(Boolean))].sort(), [stockData]);
  const types      = useMemo(() => [...new Set(stockData.map(r => r.part_type).filter(Boolean))].sort(), [stockData]);

  const filteredStock = useMemo(() => {
    return stockData.filter(r => {
      const s = search.toLowerCase();
      if (s && !(r.part_code || '').toLowerCase().includes(s) && !(r.part_name || '').toLowerCase().includes(s)) return false;
      if (productFilter  && r.product  !== productFilter)  return false;
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

  return (
    <div style={{ padding: '16px 24px', color: 'var(--t1)' }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontFamily: 'var(--mono)', fontSize: 24, fontWeight: 900, textTransform: 'uppercase', margin: 0 }}>
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
              style={inputStyle}
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search part code or name"
            />
            <select style={inputStyle} value={productFilter} onChange={e => setProductFilter(e.target.value)}>
              <option value="">All Products</option>
              {products.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
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
                        <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--green)' }}>{r.received ?? 0}</td>
                        <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: '#f87171' }}>{r.issued ?? 0}</td>
                        <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--blue)' }}>{r.returned ?? 0}</td>
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
