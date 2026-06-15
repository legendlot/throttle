'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { useToast } from '@throttle/ui';
import {
  panelStyle, panelHeaderStyle, panelBodyStyle, pageH1, pageSub, tableThStyle, tableTdStyle,
  inputStyle, selectStyle, labelStyle, btnPrimary, fmtINR, fmtRMB, fmtDate,
} from '../../../../lib/manifestui.js';

export default function VendorPaymentsPage() {
  const { session, perms } = useAuth();
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [show, setShow] = useState(false);
  const [f, setF] = useState({ vendor_code: '', order_id: '', amount_rmb: '', amount_inr_debited: '', payment_date: '', note: '' });
  const canRecord = perms?.sf_vendor_payment_record || perms?.payment_record;

  async function load() { const d = await garageFetch('getVendorPayments', {}, session); setRows(d || []); setLoading(false); }
  useEffect(() => { if (session) { load(); garageFetch('getVendors', {}, session).then(d => setVendors(d || [])).catch(() => {}); garageFetch('getOrders', {}, session).then(d => setOrders(d || [])).catch(() => {}); } }, [session]);

  const liveRate = f.amount_rmb && f.amount_inr_debited ? (Number(f.amount_inr_debited) / Number(f.amount_rmb)).toFixed(4) : null;

  async function create() {
    if (!f.amount_rmb || !f.amount_inr_debited) { toast.error('RMB and INR amounts required'); return; }
    const vendor = vendors.find(v => v.vendor_code === f.vendor_code);
    const r = await workerFetch('recordVendorPayment', { data: { ...f, vendor_name: vendor?.vendor_name || null, order_id: f.order_id || null, amount_rmb: Number(f.amount_rmb), amount_inr_debited: Number(f.amount_inr_debited), payment_date: f.payment_date || null } }, session);
    if (r.ok) { toast.success(`${r.data.vp_no} recorded`); setShow(false); setF({ vendor_code: '', order_id: '', amount_rmb: '', amount_inr_debited: '', payment_date: '', note: '' }); load(); }
    else toast.error(r.error);
  }
  async function remove(id) {
    if (!confirm('Delete this vendor payment?')) return;
    const r = await workerFetch('deleteVendorPayment', { data: { id } }, session);
    if (r.ok) load(); else toast.error(r.error);
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <div><h1 style={pageH1}>Vendor Payments</h1><div style={pageSub}>SF → China vendor · the actual bank rate is the true cost basis</div></div>
        {canRecord && <button style={btnPrimary} onClick={() => setShow(s => !s)}>{show ? 'Close' : '+ Record vendor payment'}</button>}
      </div>

      {show && (
        <div style={panelStyle}>
          <div style={panelHeaderStyle}><span>Record SF → vendor payment</span></div>
          <div style={{ ...panelBodyStyle, display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
            <div><label style={labelStyle}>Vendor</label><select style={{ ...selectStyle, width: '100%' }} value={f.vendor_code} onChange={e => setF(s => ({ ...s, vendor_code: e.target.value }))}><option value="">—</option>{vendors.map(v => <option key={v.vendor_code} value={v.vendor_code}>{v.vendor_name}</option>)}</select></div>
            <div><label style={labelStyle}>Against order</label><select style={{ ...selectStyle, width: '100%' }} value={f.order_id} onChange={e => setF(s => ({ ...s, order_id: e.target.value }))}><option value="">— general —</option>{orders.map(o => <option key={o.id} value={o.id}>{o.order_no}</option>)}</select></div>
            <div><label style={labelStyle}>Amount (RMB)</label><input type="number" style={{ ...inputStyle, width: '100%' }} value={f.amount_rmb} onChange={e => setF(s => ({ ...s, amount_rmb: e.target.value }))} /></div>
            <div><label style={labelStyle}>INR debited (actual)</label><input type="number" style={{ ...inputStyle, width: '100%' }} value={f.amount_inr_debited} onChange={e => setF(s => ({ ...s, amount_inr_debited: e.target.value }))} /></div>
            <div><label style={labelStyle}>Payment date</label><input type="date" style={{ ...inputStyle, width: '100%' }} value={f.payment_date} onChange={e => setF(s => ({ ...s, payment_date: e.target.value }))} /></div>
            <div style={{ gridColumn: '2 / 4' }}><label style={labelStyle}>Note</label><input style={{ ...inputStyle, width: '100%' }} value={f.note} onChange={e => setF(s => ({ ...s, note: e.target.value }))} /></div>
            <div style={{ alignSelf: 'end' }}>{liveRate && <div style={{ fontSize: 11, color: 'var(--t2)', marginBottom: 6 }}>Bank rate ¥→₹ <strong>{liveRate}</strong></div>}<button style={btnPrimary} onClick={create}>Record</button></div>
          </div>
        </div>
      )}

      <div style={panelStyle}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={tableThStyle}>No.</th><th style={tableThStyle}>Vendor</th><th style={tableThStyle}>Order</th>
              <th style={{ ...tableThStyle, textAlign: 'right' }}>RMB</th><th style={{ ...tableThStyle, textAlign: 'right' }}>INR debited</th>
              <th style={tableThStyle}>Bank rate</th><th style={tableThStyle}>Date</th><th style={tableThStyle}>By</th><th style={tableThStyle}></th>
            </tr></thead>
            <tbody>
              {loading && <tr><td style={tableTdStyle} colSpan={9}>Loading…</td></tr>}
              {!loading && rows.length === 0 && <tr><td style={{ ...tableTdStyle, color: 'var(--t3)' }} colSpan={9}>No vendor payments</td></tr>}
              {rows.map(v => (
                <tr key={v.id}>
                  <td style={{ ...tableTdStyle, color: 'var(--yellow)' }}>{v.vp_no}</td>
                  <td style={tableTdStyle}>{v.vendor_name || v.vendor_code || '—'}</td>
                  <td style={tableTdStyle}>{v.order_id ? (orders.find(o => o.id === v.order_id)?.order_no || `#${v.order_id}`) : '—'}</td>
                  <td style={{ ...tableTdStyle, textAlign: 'right' }}>{fmtRMB(v.amount_rmb)}</td>
                  <td style={{ ...tableTdStyle, textAlign: 'right', color: 'var(--red)' }}>{fmtINR(v.amount_inr_debited)}</td>
                  <td style={tableTdStyle}>{v.actual_bank_rate ? Number(v.actual_bank_rate).toFixed(4) : '—'}</td>
                  <td style={tableTdStyle}>{fmtDate(v.payment_date)}</td>
                  <td style={tableTdStyle}>{v.recorded_by_name || '—'}</td>
                  <td style={tableTdStyle}>{canRecord && <button style={{ background: 'none', border: 'none', color: '#ff7070', cursor: 'pointer' }} onClick={() => remove(v.id)}>×</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
