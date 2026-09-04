'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { Plus, Download } from 'lucide-react';
import { PageHead, Kpi, Panel, Badge, Btn, EmptyState } from '@/components/ui.js';
import { fmtDateShort, inrCompact } from '@/components/format.js';
import { orderStatusLabel, ORDER_STATUS_TONES, fulfilmentMeta, paymentMeta, inr, fyLabel, csvCell } from '@/lib/sales';
import { todayStr } from '@throttle/domain';

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
    return <div style={{ padding: 24, color: 'var(--text-3)' }}>Access restricted.</div>;
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

  const thisFy = fyLabel(todayStr());
  const kpi = {
    open: rows.filter(r => r.status === 'confirmed' && !['fulfilled', 'fully_fulfilled'].includes(r.fulfilment_status)).length,
    toDispatch: rows.filter(r => r.status === 'confirmed' && ['pending', 'in_progress', 'awaiting_acceptance', 'in_fulfilment'].includes(r.fulfilment_status)).reduce((s, r) => s + Number(r.grand_total || 0), 0),
    overdue: rows.filter(r => r.overdue).reduce((s, r) => s + Number(r.balance || 0), 0),
    fySales: rows.filter(r => r.status !== 'cancelled' && r.invoice_date && fyLabel(r.invoice_date) === thisFy).reduce((s, r) => s + Number(r.grand_total || 0), 0),
  };

  function exportCsv() {
    const cols = ['Order', 'Date', 'Partner', 'Channel', 'Status', 'Fulfilment', 'Invoice', 'Grand Total',
      'Fulfilled Value', 'Shortfall', 'Received', 'Balance', 'Due', 'Overdue', 'Payment'];
    const lines = [cols.join(',')];
    for (const o of filtered) lines.push([o.order_no, o.order_date, o.partner_name, o.channel_key,
      orderStatusLabel(o.status), fulfilmentMeta(o.fulfilment_status).label, o.invoice_no, o.grand_total,
      // Match the UI exactly: a cancelled order shows no fulfilment figures on screen, so
      // it must not carry them in the export either (S344 hostile review).
      o.status === 'cancelled' ? '' : o.fulfilled_value,
      o.status === 'cancelled' ? '' : o.shortfall_value,
      o.amount_received, o.balance, o.due_date, o.overdue ? 'Yes' : 'No', o.payment_status].map(csvCell).join(','));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `lot-sales-orders-${todayStr()}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  const filtersActive = search.trim() || filters.fulfilment || filters.overdue;

  return (
    <div className="pg">
      <PageHead title="Sales Orders" sub="Offline channel orders (GT / MT). Capture, dispatch handoff, collections."
        actions={<>
          <Btn onClick={exportCsv} disabled={!filtered.length}><Download size={14} /> Export</Btn>
          {canManage && <Btn kind="primary" onClick={() => router.push('/sales/orders/new')}><Plus size={14} /> New order</Btn>}
        </>} />

      <div className="kpi-row">
        <Kpi label="Open orders" value={kpi.open} sub="confirmed · unfulfilled" tone="yellow" />
        <Kpi label="To Dispatch" value={kpi.toDispatch} sub="pending + in progress" tone="blue" format={(v) => inrCompact(v)} />
        <Kpi label="Overdue" value={kpi.overdue} sub="click to filter" tone="red" format={(v) => inrCompact(v)} onClick={() => setFilters(f => ({ ...f, overdue: !f.overdue }))} />
        <Kpi label={`FY ${thisFy} Sales`} value={kpi.fySales} sub="all channels" tone="green" format={(v) => inrCompact(v)} />
      </div>

      <Panel title="Orders" count={filtersActive ? `${filtered.length} of ${rows.length}` : rows.length}
        action={
          <div className="filters">
            {filters.overdue && <button className="chip-clear" onClick={() => setFilters(f => ({ ...f, overdue: false }))}>Overdue ✕</button>}
            <input className="sel" data-search-primary type="text" placeholder="Search order / partner · /" value={search} onChange={e => setSearch(e.target.value)} style={{ minWidth: 180 }} />
            <select value={filters.status} onChange={e => setFilters(f => ({ ...f, status: e.target.value }))} className="sel">
              <option value="">All statuses</option><option value="draft">Draft</option><option value="confirmed">Confirmed</option><option value="cancelled">Cancelled</option>
            </select>
            <select value={filters.fulfilment} onChange={e => setFilters(f => ({ ...f, fulfilment: e.target.value }))} className="sel">
              <option value="">All fulfilment</option><option value="not_dispatched">Not dispatched</option><option value="pending">Pending</option><option value="in_progress">In progress</option><option value="fulfilled">Fulfilled</option>
            </select>
            <select value={filters.channel_key} onChange={e => setFilters(f => ({ ...f, channel_key: e.target.value }))} className="sel">
              <option value="">All channels</option>
              {channels.map(c => <option key={c.channel_key} value={c.channel_key}>{c.label}</option>)}
            </select>
          </div>
        }>
        {loading ? <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          : filtered.length === 0 ? <EmptyState icon="package-search" title="No orders match the filter" hint="Clear a filter to see all channel orders." />
          : (
            <table className="dt">
              <thead><tr>
                <th>Order</th><th>Date</th><th>Partner</th><th>Ch</th><th>Status</th><th>Fulfilment</th>
                <th className="num">Total</th><th className="num">Fulfilled</th><th className="num">Balance</th><th>Due</th><th>Payment</th>
              </tr></thead>
              <tbody>
                {filtered.map(o => {
                  const fm = fulfilmentMeta(o.fulfilment_status);
                  const pm = paymentMeta(o.payment_status);
                  return (
                    <tr key={o.id} className="row-click" onClick={() => router.push(`/sales/orders/detail?id=${encodeURIComponent(o.id)}`)}>
                      <td className="mono accent">{o.order_no}</td>
                      <td className="mono">{fmtDateShort(o.order_date)}</td>
                      <td>{o.partner_name || '—'}</td>
                      <td><Badge label={o.channel_key || '—'} tone="blue" /></td>
                      <td><Badge label={orderStatusLabel(o.status)} tone={ORDER_STATUS_TONES[o.status] || 'gray'} /></td>
                      <td><Badge label={fm.label} tone={fm.tone} dot /></td>
                      <td className="num mono">{inr(o.grand_total)}</td>
                      {/* Fulfilment value in ₹, and the shortfall beneath it (Ram, #bugs
                          2026-09-04). Units never told you whether a short shipment mattered:
                          3 missing remotes and 3 missing cars read identically. Shown only
                          where a shortfall is meaningful — a cancelled order has no gap to
                          chase, and repeating the total on every fulfilled row is noise. */}
                      <td className="num mono">
                        {o.fulfilled_value == null || o.status === 'cancelled' ? (
                          <span style={{ color: 'var(--text-3)' }}>—</span>
                        ) : (
                          <>
                            <div>{inr(o.fulfilled_value)}</div>
                            {/* ⚠️ Red is for SHIPPED SHORT, not "not shipped yet" (S344
                                hostile review). Painting the full order value red on every
                                draft and unaccepted order would put ~400 of 532 rows in red
                                and the colour would stop meaning anything — the fulfilment
                                badge already says nothing has gone. */}
                            {Number(o.shortfall_value) > 0 && !o.nothing_dispatched && (
                              <div style={{ fontSize: 11, color: 'var(--red-fg)' }}>
                                −{inr(o.shortfall_value)}
                              </div>
                            )}
                          </>
                        )}
                      </td>
                      <td className="num mono" style={{ color: Number(o.balance) > 0 ? 'var(--red-fg)' : 'var(--text-3)' }}>{inr(o.balance)}</td>
                      <td className="mono" style={{ color: o.overdue ? 'var(--red-fg)' : 'var(--text-2)' }}>{o.due_date ? fmtDateShort(o.due_date) + (o.overdue ? ' ⚠' : '') : '—'}</td>
                      <td><Badge label={pm.label} tone={pm.tone} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
      </Panel>
    </div>
  );
}
