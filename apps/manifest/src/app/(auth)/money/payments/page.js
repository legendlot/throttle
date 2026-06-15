'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { useToast } from '@throttle/ui';
import {
  panelStyle, panelHeaderStyle, panelBodyStyle, pageH1, pageSub, tableThStyle, tableTdStyle,
  inputStyle, labelStyle, btnPrimary, fmtINR, fmtDate,
} from '../../../../lib/manifestui.js';

export default function PaymentsPage() {
  const { session, perms } = useAuth();
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [show, setShow] = useState(false);
  const [f, setF] = useState({ amount_inr: '', paid_date: '', method: 'bank', fx_rate_used: '', note: '' });
  const canRecord = perms?.payment_record;

  async function load() { const d = await garageFetch('getPayments', {}, session); setRows(d || []); setLoading(false); }
  useEffect(() => { if (session) load(); }, [session]);

  async function create() {
    if (!f.amount_inr) { toast.error('Amount required'); return; }
    const r = await workerFetch('recordPayment', { data: { ...f, amount_inr: Number(f.amount_inr), fx_rate_used: f.fx_rate_used ? Number(f.fx_rate_used) : null, paid_date: f.paid_date || null } }, session);
    if (r.ok) { toast.success(`${r.data.payment_no} recorded`); setShow(false); setF({ amount_inr: '', paid_date: '', method: 'bank', fx_rate_used: '', note: '' }); load(); }
    else toast.error(r.error);
  }
  async function remove(id) {
    if (!confirm('Delete this payment?')) return;
    const r = await workerFetch('deletePayment', { data: { id } }, session);
    if (r.ok) load(); else toast.error(r.error);
  }

  const total = rows.reduce((s, p) => s + Number(p.amount_inr || 0), 0);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <div><h1 style={pageH1}>Payments → SF</h1><div style={pageSub}>LOT → Solve Factory · pool credits · total {fmtINR(total)}</div></div>
        {canRecord && <button style={btnPrimary} onClick={() => setShow(s => !s)}>{show ? 'Close' : '+ Record payment'}</button>}
      </div>

      {show && (
        <div style={panelStyle}>
          <div style={panelHeaderStyle}><span>Record payment to SF</span></div>
          <div style={{ ...panelBodyStyle, display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
            <div><label style={labelStyle}>Amount (INR)</label><input type="number" style={{ ...inputStyle, width: '100%' }} value={f.amount_inr} onChange={e => setF(s => ({ ...s, amount_inr: e.target.value }))} /></div>
            <div><label style={labelStyle}>Paid date</label><input type="date" style={{ ...inputStyle, width: '100%' }} value={f.paid_date} onChange={e => setF(s => ({ ...s, paid_date: e.target.value }))} /></div>
            <div><label style={labelStyle}>Method</label><input style={{ ...inputStyle, width: '100%' }} value={f.method} onChange={e => setF(s => ({ ...s, method: e.target.value }))} /></div>
            <div><label style={labelStyle}>Est. rate used (¥→₹)</label><input type="number" style={{ ...inputStyle, width: '100%' }} value={f.fx_rate_used} onChange={e => setF(s => ({ ...s, fx_rate_used: e.target.value }))} /></div>
            <div style={{ gridColumn: '1 / 4' }}><label style={labelStyle}>Note</label><input style={{ ...inputStyle, width: '100%' }} value={f.note} onChange={e => setF(s => ({ ...s, note: e.target.value }))} /></div>
            <div><button style={{ ...btnPrimary, marginTop: 18 }} onClick={create}>Record</button></div>
          </div>
        </div>
      )}

      <div style={panelStyle}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={tableThStyle}>No.</th><th style={tableThStyle}>Date</th><th style={{ ...tableThStyle, textAlign: 'right' }}>Amount</th>
              <th style={tableThStyle}>Method</th><th style={tableThStyle}>Rate</th><th style={tableThStyle}>Note</th><th style={tableThStyle}>By</th><th style={tableThStyle}></th>
            </tr></thead>
            <tbody>
              {loading && <tr><td style={tableTdStyle} colSpan={8}>Loading…</td></tr>}
              {!loading && rows.length === 0 && <tr><td style={{ ...tableTdStyle, color: 'var(--t3)' }} colSpan={8}>No payments</td></tr>}
              {rows.map(p => (
                <tr key={p.id}>
                  <td style={{ ...tableTdStyle, color: 'var(--yellow)' }}>{p.payment_no}</td>
                  <td style={tableTdStyle}>{fmtDate(p.paid_date)}</td>
                  <td style={{ ...tableTdStyle, textAlign: 'right', color: 'var(--green)' }}>{fmtINR(p.amount_inr)}</td>
                  <td style={tableTdStyle}>{p.method || '—'}</td>
                  <td style={tableTdStyle}>{p.fx_rate_used ? Number(p.fx_rate_used).toFixed(3) : '—'}</td>
                  <td style={tableTdStyle}>{p.note || '—'}</td>
                  <td style={tableTdStyle}>{p.recorded_by_name || '—'}</td>
                  <td style={tableTdStyle}>{canRecord && <button style={{ background: 'none', border: 'none', color: '#ff7070', cursor: 'pointer' }} onClick={() => remove(p.id)}>×</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
