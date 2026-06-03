'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import {
  panelStyle, panelHeaderStyle, tableThStyle, tableTdStyle, selectStyle, inputStyle,
  btnPrimary, btnSecondary, pageH1, pageSub, StatusBadge, fmtDate,
} from '@/lib/snorkelui';
import { orderStatusLabel, ORDER_STATUS_TONES, fulfilmentMeta, paymentMeta, inr, fyLabel, csvCell } from '@/lib/sales';

const tileStyle = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, padding: '10px 14px', minWidth: 120 };
const tileNum   = { fontFamily: 'var(--cond)', fontSize: 22, fontWeight: 900, lineHeight: 1 };
const tileLbl   = { fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: 4 };

export default function SalesOrdersPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const [rows, setRows] = useState([]);
  const [channels, setChannels] = useState([]);
  const [filters, setFilters] = useState({ status: '', channel_key: '', fulfilment: '', overdue: false });
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  const canManage = !!perms?.sales_order_manage;

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const params = {};
      if (filters.status) params.status = filters.status;
      if (filters.channel_key) params.channel_key = filters.channel_key;
      const data = await garageFetch('getSalesOrders', params, session);
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      showToast(e.message || 'Failed to load orders', 'error');
    } finally { setLoading(false); }
  }, [session, filters.status, filters.channel_key, showToast]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!session) return;
    garageFetch('getSalesChannels', {}, session).then(d => setChannels(Array.isArray(d) ? d : [])).catch(() => {});
  }, [session]);

  if (perms && !perms.sales_view && !perms.sales_order_manage && !perms.sales_partner_manage) {
    return <div style={{ padding: 24, color: 'var(--t3)' }}>Access restricted.</div>;
  }

  let filtered = rows;
  if (filters.fulfilment) filtered = filtered.filter(r => r.fulfilment_status === filters.fulfilment);
  if (filters.overdue) filtered = filtered.filter(r => r.overdue);
  if (search.trim()) {
    const tokens = search.toLowerCase().split(/\s+/).filter(Boolean);
    filtered = filtered.filter(r => {
      const fields = [r.order_no, r.partner_name, r.invoice_no, r.channel_key].map(v => (v || '').toString().toLowerCase());
      return tokens.every(t => fields.some(f => f.includes(t)));
    });
  }

  const thisFy = fyLabel(new Date().toISOString().slice(0, 10));
  const kpi = {
    open: rows.filter(r => r.status === 'confirmed' && r.fulfilment_status !== 'fulfilled').length,
    toDispatch: rows.filter(r => r.status === 'confirmed' && (r.fulfilment_status === 'pending' || r.fulfilment_status === 'in_progress'))
      .reduce((s, r) => s + Number(r.grand_total || 0), 0),
    overdue: rows.filter(r => r.overdue).reduce((s, r) => s + Number(r.balance || 0), 0),
    fySales: rows.filter(r => r.status !== 'cancelled' && r.invoice_date && fyLabel(r.invoice_date) === thisFy)
      .reduce((s, r) => s + Number(r.grand_total || 0), 0),
  };

  function exportCsv() {
    const cols = ['Order', 'Date', 'Partner', 'Channel', 'Status', 'Fulfilment', 'Invoice', 'Grand Total', 'Received', 'Balance', 'Due', 'Overdue', 'Payment'];
    const lines = [cols.join(',')];
    for (const o of filtered) lines.push([o.order_no, o.order_date, o.partner_name, o.channel_key,
      orderStatusLabel(o.status), fulfilmentMeta(o.fulfilment_status).label, o.invoice_no, o.grand_total,
      o.amount_received, o.balance, o.due_date, o.overdue ? 'Yes' : 'No', o.payment_status].map(csvCell).join(','));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `lot-sales-orders-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{ color: 'var(--t1)' }}>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={pageH1}>Sales Orders</h1>
          <p style={pageSub}>Offline channel orders (GT / MT) — capture, dispatch handoff, collections.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={btnSecondary} onClick={exportCsv} disabled={!filtered.length}>↓ Export CSV</button>
          {canManage && <button style={btnPrimary} onClick={() => router.push('/sales/orders/new')}>+ New Order</button>}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={tileStyle}><div style={tileNum}>{kpi.open}</div><div style={tileLbl}>Open orders</div></div>
        <div style={tileStyle}><div style={{ ...tileNum, color: '#7b93ff' }}>{inr(kpi.toDispatch)}</div><div style={tileLbl}>Value to dispatch</div></div>
        <div style={{ ...tileStyle, cursor: 'pointer', borderColor: filters.overdue ? 'var(--yellow)' : 'var(--border)' }} onClick={() => setFilters(f => ({ ...f, overdue: !f.overdue }))} title="Click to filter overdue">
          <div style={{ ...tileNum, color: '#ff7070' }}>{inr(kpi.overdue)}</div><div style={tileLbl}>Overdue ⚠</div>
        </div>
        <div style={tileStyle}><div style={{ ...tileNum, color: '#4ade80' }}>{inr(kpi.fySales)}</div><div style={tileLbl}>FY {thisFy} sales</div></div>
      </div>

      <div style={panelStyle}>
        <div style={panelHeaderStyle}>
          <span>Orders {(search.trim() || filters.fulfilment || filters.overdue) && <span style={{ color: 'var(--t3)', fontFamily: 'var(--mono)', fontWeight: 400, fontSize: 11 }}>· {filtered.length} of {rows.length}</span>}</span>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <input type="text" data-search-primary placeholder="Search order / partner / invoice · /" value={search} onChange={e => setSearch(e.target.value)} style={{ ...inputStyle, fontFamily: 'var(--mono)', minWidth: 200 }} />
            <select value={filters.status} onChange={e => setFilters(f => ({ ...f, status: e.target.value }))} style={selectStyle}>
              <option value="">All Statuses</option>
              <option value="draft">Draft</option><option value="confirmed">Confirmed</option><option value="cancelled">Cancelled</option>
            </select>
            <select value={filters.fulfilment} onChange={e => setFilters(f => ({ ...f, fulfilment: e.target.value }))} style={selectStyle}>
              <option value="">All Fulfilment</option>
              <option value="not_dispatched">Not dispatched</option><option value="pending">Pending</option>
              <option value="in_progress">In progress</option><option value="fulfilled">Fulfilled</option>
            </select>
            <select value={filters.channel_key} onChange={e => setFilters(f => ({ ...f, channel_key: e.target.value }))} style={selectStyle}>
              <option value="">All Channels</option>
              {channels.map(c => <option key={c.channel_key} value={c.channel_key}>{c.label}</option>)}
            </select>
            <button style={btnSecondary} onClick={load} disabled={loading}>↻ Refresh</button>
          </div>
        </div>
        <div style={{ overflowX: 'auto' }}>
          {loading ? (
            <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>No orders match the filter</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={tableThStyle}>Order</th>
                <th style={tableThStyle}>Date</th>
                <th style={tableThStyle}>Partner</th>
                <th style={tableThStyle}>Channel</th>
                <th style={tableThStyle}>Status</th>
                <th style={tableThStyle}>Fulfilment</th>
                <th style={{ ...tableThStyle, textAlign: 'right' }}>Total</th>
                <th style={{ ...tableThStyle, textAlign: 'right' }}>Balance</th>
                <th style={tableThStyle}>Due</th>
                <th style={tableThStyle}>Payment</th>
              </tr></thead>
              <tbody>
                {filtered.map(o => {
                  const fm = fulfilmentMeta(o.fulfilment_status);
                  const pm = paymentMeta(o.payment_status);
                  return (
                    <tr key={o.id} style={{ cursor: 'pointer' }} onClick={() => router.push(`/sales/orders/detail?id=${encodeURIComponent(o.id)}`)}>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{o.order_no}</td>
                      <td style={tableTdStyle}>{fmtDate(o.order_date)}</td>
                      <td style={tableTdStyle}>{o.partner_name || '—'}</td>
                      <td style={tableTdStyle}>{o.channel_key || '—'}</td>
                      <td style={tableTdStyle}><StatusBadge label={orderStatusLabel(o.status)} tone={ORDER_STATUS_TONES[o.status] || 'gray'} /></td>
                      <td style={tableTdStyle}><StatusBadge label={fm.label} tone={fm.tone} /></td>
                      <td style={{ ...tableTdStyle, textAlign: 'right', fontFamily: 'var(--mono)' }}>{inr(o.grand_total)}</td>
                      <td style={{ ...tableTdStyle, textAlign: 'right', fontFamily: 'var(--mono)', color: Number(o.balance) > 0 ? '#ff7070' : 'var(--t3)' }}>{inr(o.balance)}</td>
                      <td style={tableTdStyle}>{o.due_date ? <span style={{ color: o.overdue ? '#ff7070' : 'var(--t2)' }}>{fmtDate(o.due_date)}{o.overdue ? ' ⚠' : ''}</span> : <span style={{ color: 'var(--t3)' }}>—</span>}</td>
                      <td style={tableTdStyle}><StatusBadge label={pm.label} tone={pm.tone} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
