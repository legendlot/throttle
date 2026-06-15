'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import {
  panelStyle, pageH1, pageSub, tableThStyle, tableTdStyle, inputStyle, selectStyle, btnPrimary,
  StatusBadge, ORDER_STATUS_TONE, ORDER_STATUSES, ORDER_CATEGORIES, fmtDate, fmtRMB, titleCase,
} from '../../../lib/manifestui.js';

export default function OrdersPage() {
  const { session, perms } = useAuth();
  const router = useRouter();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [cat, setCat] = useState('');

  useEffect(() => {
    if (!session) return;
    garageFetch('getOrders', {}, session).then(d => setOrders(d || [])).finally(() => setLoading(false));
  }, [session]);

  const rows = useMemo(() => orders.filter(o => {
    if (status && o.status !== status) return false;
    if (cat && o.category !== cat) return false;
    if (q) {
      const hay = `${o.order_no} ${o.title || ''} ${o.vendor_name || ''}`.toLowerCase();
      if (!hay.includes(q.toLowerCase())) return false;
    }
    return true;
  }), [orders, q, status, cat]);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <div><h1 style={pageH1}>China Orders</h1><div style={pageSub}>{orders.length} orders · captured from intent → delivery</div></div>
        {perms?.order_manage && <button style={btnPrimary} onClick={() => router.push('/orders/new')}>+ New Order</button>}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <input style={{ ...inputStyle, minWidth: 220 }} placeholder="Search order / vendor / title…" value={q} onChange={e => setQ(e.target.value)} />
        <select style={selectStyle} value={status} onChange={e => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {ORDER_STATUSES.map(s => <option key={s} value={s}>{titleCase(s)}</option>)}
        </select>
        <select style={selectStyle} value={cat} onChange={e => setCat(e.target.value)}>
          <option value="">All categories</option>
          {ORDER_CATEGORIES.map(c => <option key={c} value={c}>{titleCase(c)}</option>)}
        </select>
      </div>

      <div style={panelStyle}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={tableThStyle}>Order</th><th style={tableThStyle}>Title</th><th style={tableThStyle}>Vendor</th>
              <th style={tableThStyle}>Category</th><th style={tableThStyle}>Value (RMB)</th>
              <th style={tableThStyle}>Snorkel PO</th><th style={tableThStyle}>Status</th><th style={tableThStyle}>Created</th>
            </tr></thead>
            <tbody>
              {loading && <tr><td style={tableTdStyle} colSpan={8}>Loading…</td></tr>}
              {!loading && rows.length === 0 && <tr><td style={{ ...tableTdStyle, color: 'var(--t3)' }} colSpan={8}>No orders</td></tr>}
              {rows.map(o => (
                <tr key={o.id} style={{ cursor: 'pointer' }} onClick={() => router.push(`/orders/detail?id=${o.id}`)}>
                  <td style={{ ...tableTdStyle, color: 'var(--yellow)' }}>{o.order_no}</td>
                  <td style={tableTdStyle}>{o.title || '—'}</td>
                  <td style={tableTdStyle}>{o.vendor_name || '—'}</td>
                  <td style={tableTdStyle}>{titleCase(o.category)}</td>
                  <td style={tableTdStyle}>{o.est_value_rmb != null ? fmtRMB(o.est_value_rmb) : '—'}</td>
                  <td style={tableTdStyle}>{o.linked_po_number ? <span style={{ color: 'var(--green)' }}>{o.linked_po_number}</span> : <span style={{ color: 'var(--t3)' }}>—</span>}</td>
                  <td style={tableTdStyle}><StatusBadge label={titleCase(o.status)} tone={ORDER_STATUS_TONE[o.status] || 'gray'} /></td>
                  <td style={tableTdStyle}>{fmtDate(o.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
