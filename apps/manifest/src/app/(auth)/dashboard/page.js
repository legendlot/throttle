'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import {
  panelStyle, panelHeaderStyle, panelBodyStyle, pageH1, pageSub, tableThStyle, tableTdStyle,
  StatusBadge, ORDER_STATUS_TONE, SHIPMENT_STATUS_TONE, fmtINR, fmtDate, titleCase,
} from '../../../lib/manifestui.js';

function Tile({ label, value, sub, tone }) {
  return (
    <div style={{ ...panelStyle, marginBottom: 0, flex: 1, minWidth: 180 }}>
      <div style={{ padding: '14px 16px' }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--t3)' }}>{label}</div>
        <div style={{ fontFamily: 'var(--cond)', fontSize: 26, fontWeight: 900, marginTop: 6, color: tone || 'var(--t1)' }}>{value}</div>
        {sub && <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', marginTop: 4 }}>{sub}</div>}
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const { session } = useAuth();
  const router = useRouter();
  const [due, setDue] = useState(null);
  const [orders, setOrders] = useState([]);
  const [shipments, setShipments] = useState([]);
  const [activity, setActivity] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!session) return;
    (async () => {
      try {
        const [d, o, s, a] = await Promise.all([
          garageFetch('getMoneyDue', {}, session).catch(() => null),
          garageFetch('getOrders', {}, session).catch(() => []),
          garageFetch('getShipments', {}, session).catch(() => []),
          garageFetch('getActivity', {}, session).catch(() => []),
        ]);
        setDue(d); setOrders(o || []); setShipments(s || []); setActivity(a || []);
      } finally { setLoading(false); }
    })();
  }, [session]);

  const openOrders = orders.filter(o => !['closed', 'cancelled'].includes(o.status));
  const inTransit  = shipments.filter(s => ['loaded', 'in_transit', 'arrived', 'customs', 'local_transit'].includes(s.status));
  const balance = due ? Number(due.actual_balance) : 0;
  const owes = balance < 0;

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h1 style={pageH1}>Dashboard</h1>
        <div style={pageSub}>LOT ↔ Solve Factory · China import operations</div>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <Tile
          label="Running account"
          value={due ? fmtINR(Math.abs(balance)) : '—'}
          sub={due ? (owes ? 'LOT owes SF' : 'SF holds LOT funds (advance)') : ''}
          tone={owes ? 'var(--red)' : 'var(--green)'}
        />
        <Tile label="Open draw-downs" value={due ? fmtINR(due.open_drawdowns) : '—'} sub="requested / part-paid" tone="var(--yellow)" />
        <Tile label="Estimated costs pending" value={due ? fmtINR(due.estimate_charges) : '—'} sub="not yet finalised" />
        <Tile label="Open orders" value={openOrders.length} sub={`${orders.length} total`} />
        <Tile label="Shipments in transit" value={inTransit.length} sub={`${shipments.length} total`} tone="var(--blue)" />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16 }}>
        <div style={panelStyle}>
          <div style={panelHeaderStyle}><span>Open Orders</span></div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={tableThStyle}>Order</th><th style={tableThStyle}>Vendor</th>
                <th style={tableThStyle}>Category</th><th style={tableThStyle}>Status</th>
              </tr></thead>
              <tbody>
                {loading && <tr><td style={tableTdStyle} colSpan={4}>Loading…</td></tr>}
                {!loading && openOrders.length === 0 && <tr><td style={{ ...tableTdStyle, color: 'var(--t3)' }} colSpan={4}>No open orders</td></tr>}
                {openOrders.slice(0, 12).map(o => (
                  <tr key={o.id} style={{ cursor: 'pointer' }} onClick={() => router.push(`/orders/detail?id=${o.id}`)}>
                    <td style={{ ...tableTdStyle, color: 'var(--yellow)' }}>{o.order_no}</td>
                    <td style={tableTdStyle}>{o.vendor_name || '—'}</td>
                    <td style={tableTdStyle}>{titleCase(o.category)}</td>
                    <td style={tableTdStyle}><StatusBadge label={titleCase(o.status)} tone={ORDER_STATUS_TONE[o.status] || 'gray'} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div style={panelStyle}>
          <div style={panelHeaderStyle}><span>Recent Activity</span></div>
          <div style={{ ...panelBodyStyle, maxHeight: 360, overflowY: 'auto' }}>
            {loading && <div style={{ color: 'var(--t3)', fontSize: 12 }}>Loading…</div>}
            {!loading && activity.length === 0 && <div style={{ color: 'var(--t3)', fontSize: 12 }}>No activity yet</div>}
            {activity.slice(0, 20).map(a => (
              <div key={a.id} style={{ padding: '6px 0', borderBottom: '1px solid rgba(42,42,42,.6)', fontSize: 11 }}>
                <span style={{ color: 'var(--t2)' }}>{titleCase(a.event)}</span>
                {a.detail && <span style={{ color: 'var(--t3)' }}> · {a.detail}</span>}
                <div style={{ color: 'var(--t4, #666)', fontSize: 9, fontFamily: 'var(--mono)' }}>
                  {a.actor_name || '—'} · {fmtDate(a.created_at)}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {inTransit.length > 0 && (
        <div style={{ ...panelStyle, marginTop: 16 }}>
          <div style={panelHeaderStyle}><span>Shipments in Transit</span></div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={tableThStyle}>Shipment</th><th style={tableThStyle}>Mode</th><th style={tableThStyle}>BL / AWB</th>
                <th style={tableThStyle}>ETA</th><th style={tableThStyle}>Status</th>
              </tr></thead>
              <tbody>
                {inTransit.map(s => (
                  <tr key={s.id} style={{ cursor: 'pointer' }} onClick={() => router.push(`/shipments/detail?id=${s.id}`)}>
                    <td style={{ ...tableTdStyle, color: 'var(--yellow)' }}>{s.shipment_no}</td>
                    <td style={tableTdStyle}>{titleCase(s.mode || '—')}</td>
                    <td style={tableTdStyle}>{s.bl_awb_no || '—'}</td>
                    <td style={tableTdStyle}>{fmtDate(s.eta)}</td>
                    <td style={tableTdStyle}><StatusBadge label={titleCase(s.status)} tone={SHIPMENT_STATUS_TONE[s.status] || 'gray'} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
