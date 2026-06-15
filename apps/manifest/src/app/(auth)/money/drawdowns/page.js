'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { useToast } from '@throttle/ui';
import {
  panelStyle, panelHeaderStyle, panelBodyStyle, pageH1, pageSub, tableThStyle, tableTdStyle,
  inputStyle, selectStyle, labelStyle, btnPrimary, btnSecondary, StatusBadge,
  DRAWDOWN_PHASES, fmtINR, fmtDate, titleCase,
} from '../../../../lib/manifestui.js';

const DD_TONE = { requested: 'yellow', partially_paid: 'blue', paid: 'green', settled: 'green', cancelled: 'gray' };
const DD_STATUSES = ['requested', 'partially_paid', 'paid', 'settled', 'cancelled'];

export default function DrawdownsPage() {
  const { session, perms } = useAuth();
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [show, setShow] = useState(false);
  const [f, setF] = useState({ phase: 'goods_advance', est_amount_inr: '', order_id: '', note: '' });

  async function load() { const d = await garageFetch('getDrawdowns', {}, session); setRows(d || []); setLoading(false); }
  useEffect(() => { if (session) { load(); garageFetch('getOrders', {}, session).then(d => setOrders(d || [])).catch(() => {}); } }, [session]);

  const canRaise = perms?.drawdown_manage || perms?.sf_drawdown_raise;
  const canManage = perms?.drawdown_manage;

  async function create() {
    if (!f.est_amount_inr) { toast.error('Amount required'); return; }
    const r = await workerFetch('createDrawdown', { data: { ...f, est_amount_inr: Number(f.est_amount_inr), order_id: f.order_id || null, scope: f.order_id ? 'order' : 'general' } }, session);
    if (r.ok) { toast.success(`${r.data.drawdown_no} raised`); setShow(false); setF({ phase: 'goods_advance', est_amount_inr: '', order_id: '', note: '' }); load(); }
    else toast.error(r.error);
  }
  async function setStatus(id, status) {
    const r = await workerFetch('setDrawdownStatus', { data: { id, status } }, session);
    if (r.ok) load(); else toast.error(r.error);
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <div><h1 style={pageH1}>Draw-downs</h1><div style={pageSub}>SF money requests · estimated INR at the day's rate</div></div>
        {canRaise && <button style={btnPrimary} onClick={() => setShow(s => !s)}>{show ? 'Close' : '+ Raise draw-down'}</button>}
      </div>

      {show && (
        <div style={panelStyle}>
          <div style={panelHeaderStyle}><span>New draw-down request</span></div>
          <div style={{ ...panelBodyStyle, display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
            <div><label style={labelStyle}>Phase</label><select style={{ ...selectStyle, width: '100%' }} value={f.phase} onChange={e => setF(s => ({ ...s, phase: e.target.value }))}>{DRAWDOWN_PHASES.map(p => <option key={p} value={p}>{titleCase(p)}</option>)}</select></div>
            <div><label style={labelStyle}>Est. amount (INR)</label><input type="number" style={{ ...inputStyle, width: '100%' }} value={f.est_amount_inr} onChange={e => setF(s => ({ ...s, est_amount_inr: e.target.value }))} /></div>
            <div><label style={labelStyle}>Against order (optional)</label><select style={{ ...selectStyle, width: '100%' }} value={f.order_id} onChange={e => setF(s => ({ ...s, order_id: e.target.value }))}><option value="">— general / pool —</option>{orders.map(o => <option key={o.id} value={o.id}>{o.order_no}</option>)}</select></div>
            <div><label style={labelStyle}>Note</label><input style={{ ...inputStyle, width: '100%' }} value={f.note} onChange={e => setF(s => ({ ...s, note: e.target.value }))} /></div>
            <div><button style={btnPrimary} onClick={create}>Raise</button></div>
          </div>
        </div>
      )}

      <div style={panelStyle}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={tableThStyle}>No.</th><th style={tableThStyle}>Phase</th><th style={tableThStyle}>Order</th>
              <th style={{ ...tableThStyle, textAlign: 'right' }}>Est. INR</th><th style={tableThStyle}>Rate</th>
              <th style={tableThStyle}>Requested by</th><th style={tableThStyle}>Date</th><th style={tableThStyle}>Status</th>
            </tr></thead>
            <tbody>
              {loading && <tr><td style={tableTdStyle} colSpan={8}>Loading…</td></tr>}
              {!loading && rows.length === 0 && <tr><td style={{ ...tableTdStyle, color: 'var(--t3)' }} colSpan={8}>No draw-downs</td></tr>}
              {rows.map(d => (
                <tr key={d.id}>
                  <td style={{ ...tableTdStyle, color: 'var(--yellow)' }}>{d.drawdown_no}</td>
                  <td style={tableTdStyle}>{titleCase(d.phase)}</td>
                  <td style={tableTdStyle}>{d.order_id ? (orders.find(o => o.id === d.order_id)?.order_no || `#${d.order_id}`) : '—'}</td>
                  <td style={{ ...tableTdStyle, textAlign: 'right' }}>{fmtINR(d.est_amount_inr)}</td>
                  <td style={tableTdStyle}>{d.est_fx_rate ? Number(d.est_fx_rate).toFixed(3) : '—'}</td>
                  <td style={tableTdStyle}>{d.requested_by_name || '—'}</td>
                  <td style={tableTdStyle}>{fmtDate(d.requested_at)}</td>
                  <td style={tableTdStyle}>
                    {canManage ? (
                      <select style={{ ...selectStyle, padding: '3px 6px' }} value={d.status} onChange={e => setStatus(d.id, e.target.value)}>
                        {DD_STATUSES.map(s => <option key={s} value={s}>{titleCase(s)}</option>)}
                      </select>
                    ) : <StatusBadge label={titleCase(d.status)} tone={DD_TONE[d.status] || 'gray'} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
