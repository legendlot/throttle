'use client';
import { useEffect, useState, useCallback, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import {
  panelStyle, panelHeaderStyle, panelBodyStyle, tableThStyle, tableTdStyle, inputStyle, selectStyle, labelStyle,
  btnPrimary, btnSecondary, btnDanger, pageH1, pageSub, StatusBadge, fmtDate,
} from '@/lib/snorkelui';
import { orderStatusLabel, ORDER_STATUS_TONES, fulfilmentMeta, paymentMeta, PAYMENT_MODES, inr } from '@/lib/sales';
import OrderForm from '../OrderForm';

// Normalized courier stage (from courierops tracking_status) → label + colour for the SO timeline.
const STAGE_LABEL = {
  manifested: 'Manifested', in_transit: 'In transit', out_for_delivery: 'Out for delivery',
  delivered: 'Delivered', undelivered: 'Undelivered', rto_in_transit: 'RTO in transit',
  rto_delivered: 'RTO delivered', cancelled: 'Cancelled', lost: 'Lost', unknown: 'Unknown',
};
const STAGE_COLOR = {
  delivered: 'var(--green-fg, #2faa5a)', out_for_delivery: '#d98a00', in_transit: '#6af',
  undelivered: '#e2574c', rto_in_transit: '#d98a00', rto_delivered: '#9aa', cancelled: '#e2574c',
  lost: '#e2574c', manifested: '#6af', unknown: '#9aa',
};

function Stat({ label, value, color }) {
  return (<div><div style={labelStyle}>{label}</div><div style={{ fontSize: 13, color: color || 'var(--t1)' }}>{value ?? <span style={{ color: 'var(--t3)' }}>—</span>}</div></div>);
}

function OrderDetailInner() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const sp = useSearchParams();
  const id = sp.get('id');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [partners, setPartners] = useState([]);
  const [channels, setChannels] = useState([]);
  const [pay, setPay] = useState({ open: false, amount: '', received_date: new Date().toISOString().slice(0, 10), mode: 'bank', reference: '', note: '' });

  const canManage = !!perms?.sales_order_manage;
  const canConfirm = !!perms?.sales_order_confirm;
  const canPay = !!perms?.sales_payment_manage;

  const load = useCallback(async () => {
    if (!session || !id) return;
    setLoading(true);
    try {
      const o = await garageFetch('getSalesOrder', { id }, session);
      setData(o || null);
    } catch (e) { showToast(e.message || 'Failed to load order', 'error'); }
    finally { setLoading(false); }
  }, [session, id, showToast]);

  useEffect(() => { load(); }, [load]);

  async function loadFormMasters() {
    const [p, c] = await Promise.all([
      garageFetch('getSalesPartners', { active: '1' }, session),
      garageFetch('getSalesChannels', {}, session),
    ]);
    setPartners(Array.isArray(p) ? p : []);
    setChannels(Array.isArray(c) ? c : []);
  }

  if (perms && !perms.sales_view && !perms.sales_order_manage && !perms.sales_partner_manage) {
    return <div style={{ padding: 24, color: 'var(--t3)' }}>Access restricted.</div>;
  }
  if (loading) return <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>;
  if (!data) return <div style={{ padding: 24, color: 'var(--t3)' }}>Order not found.</div>;

  const o = data;
  const lines = o.lines || [];
  const payments = o.payments || [];
  const fm = fulfilmentMeta(o.fulfilment_status);
  const pm = paymentMeta(o.payment_status);
  const isDraft = o.status === 'draft';
  const isConfirmed = o.status === 'confirmed';

  async function act(action, body, okMsg) {
    setBusy(true);
    try {
      const res = await workerFetch(action, body, session);
      if (!res.ok) throw new Error(res.error || 'Action failed');
      showToast(okMsg, 'success');
      await load();
      return res;
    } catch (e) { showToast(e.message || 'Action failed', 'error'); }
    finally { setBusy(false); }
  }

  async function confirm() {
    if (!window.confirm('Confirm this order? It will be handed off to the dispatch team (a shipment is created) and lines lock for editing.')) return;
    await act('confirmOrder', { data: { id } }, 'Order confirmed — sent to dispatch');
  }
  async function genInvoice() {
    if (!window.confirm('Generate the GST tax invoice? The invoice number is permanent.')) return;
    const res = await act('generateInvoice', { data: { id } }, 'Invoice generated');
    if (res?.ok) router.push(`/sales/orders/invoice?id=${encodeURIComponent(id)}`);
  }
  async function cancel() {
    const reason = window.prompt('Cancel this order — reason?');
    if (!reason) return;
    await act('cancelOrder', { data: { id, reason } }, 'Order cancelled');
  }
  async function recordPayment() {
    if (!(Number(pay.amount) > 0)) { showToast('Enter an amount', 'error'); return; }
    const res = await act('recordSalesPayment', { data: { order_id: id, amount: pay.amount, received_date: pay.received_date, mode: pay.mode, reference: pay.reference, note: pay.note } }, 'Payment recorded');
    if (res?.ok) setPay({ open: false, amount: '', received_date: new Date().toISOString().slice(0, 10), mode: 'bank', reference: '', note: '' });
  }
  async function delPayment(pid) {
    if (!window.confirm('Delete this receipt?')) return;
    await act('deleteSalesPayment', { data: { id: pid } }, 'Receipt deleted');
  }

  async function createPartner(d) {
    const res = await workerFetch('createSalesPartner', { data: d }, session);
    if (!res.ok) throw new Error(res.error || 'Create failed');
    const np = { ...d, id: res.data.id, partner_code: res.data.partner_code };
    setPartners(prev => [np, ...prev]);
    showToast(`Partner ${np.partner_code} created`, 'success');
    return np;
  }

  async function startEdit() { await loadFormMasters(); setEditing(true); }
  async function saveEdit(d) {
    setBusy(true);
    try {
      const res = await workerFetch('updateSalesOrder', { data: { id, ...d } }, session);
      if (!res.ok) throw new Error(res.error || 'Update failed');
      showToast('Order updated', 'success');
      setEditing(false);
      await load();
    } catch (e) { showToast(e.message || 'Update failed', 'error'); }
    finally { setBusy(false); }
  }

  if (editing) {
    return (
      <div style={{ color: 'var(--t1)' }}>
        <div style={{ marginBottom: 16 }}><h1 style={pageH1}>Edit {o.order_no}</h1></div>
        <OrderForm partners={partners} channels={channels} saving={busy}
          initial={{ partner_id: o.partner_id, channel_key: o.channel_key, order_date: o.order_date, credit_days: o.credit_days, partner_po_ref: o.partner_po_ref, expected_dispatch_date: o.expected_dispatch_date, destination_warehouse: o.destination_warehouse, notes: o.notes, lines }}
          onSubmit={saveEdit} onCancel={() => setEditing(false)} onCreatePartner={perms?.sales_partner_manage ? createPartner : null} />
      </div>
    );
  }

  const grid = { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 };

  return (
    <div style={{ color: 'var(--t1)' }}>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={pageH1}>{o.order_no}</h1>
          <p style={pageSub}>{o.partner?.name} · {o.channel_key || '—'} · {fmtDate(o.order_date)}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <StatusBadge label={orderStatusLabel(o.status)} tone={ORDER_STATUS_TONES[o.status] || 'gray'} />
          <button style={btnSecondary} onClick={() => router.push('/sales/orders')}>← Back</button>
          {isDraft && canManage && <button style={btnSecondary} onClick={startEdit} disabled={busy}>Edit</button>}
          {isDraft && canConfirm && <button style={btnPrimary} onClick={confirm} disabled={busy}>Confirm → Dispatch</button>}
          {isConfirmed && canManage && !o.invoice_generated && <button style={btnPrimary} onClick={genInvoice} disabled={busy}>Generate Invoice</button>}
          {o.invoice_generated && <button style={btnSecondary} onClick={() => router.push(`/sales/orders/invoice?id=${encodeURIComponent(id)}`)}>🖶 Invoice</button>}
          {(isDraft || isConfirmed) && canManage && <button style={btnDanger} onClick={cancel} disabled={busy}>Cancel</button>}
        </div>
      </div>

      {/* Fulfilment + invoice + payment summary */}
      <div style={panelStyle}>
        <div style={panelHeaderStyle}>
          <span>Status</span>
          <div style={{ display: 'flex', gap: 6 }}><StatusBadge label={`Fulfilment: ${fm.label}`} tone={fm.tone} /><StatusBadge label={`Payment: ${pm.label}`} tone={pm.tone} /></div>
        </div>
        <div style={panelBodyStyle}>
          <div style={grid}>
            <Stat label="Warehouse" value={o.destination_warehouse} />
            <Stat label="Dispatch date" value={o.dispatch_date ? fmtDate(o.dispatch_date) : null} />
            <Stat label="Delivery date" value={o.delivery_date ? fmtDate(o.delivery_date) : null} />
            <Stat label="Due date" value={o.due_date ? fmtDate(o.due_date) : null} color={o.overdue ? '#ff7070' : undefined} />
            <Stat label="Invoice" value={o.invoice_no} />
            <Stat label="Invoice date" value={o.invoice_date ? fmtDate(o.invoice_date) : null} />
            <Stat label="Place of supply" value={o.place_of_supply} />
            <Stat label="Partner PO ref" value={o.partner_po_ref} />
          </div>
          {Array.isArray(o.shipments) && o.shipments.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-3)', marginBottom: 8 }}>Shipments &amp; tracking</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {o.shipments.map(s => (
                  <div key={s.id}>
                    <div style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '8px 12px', fontFamily: 'var(--mono)', fontSize: 12.5, color: 'var(--text-1)', display: 'flex', flexWrap: 'wrap', gap: 14 }}>
                      <span><b>{s.shipment_no}</b> · {s.status}</span>
                      {s.courier_partner && <span>{s.courier_partner}</span>}
                      {s.tracking_number && <span>AWB {s.tracking_number}</span>}
                      {s.tracking_link && <a href={s.tracking_link} target="_blank" rel="noreferrer" style={{ color: '#6af' }}>track ↗</a>}
                      {s.expected_delivery_date && <span>ETA {fmtDate(s.expected_delivery_date)}</span>}
                      {s.delivery_date && <span>delivered {fmtDate(s.delivery_date)}</span>}
                      {s.tracking_status && (
                        <span style={{ padding: '1px 7px', borderRadius: 4, fontSize: 11, fontWeight: 600,
                          color: '#fff', background: STAGE_COLOR[s.tracking_status] || '#9aa' }}>
                          {STAGE_LABEL[s.tracking_status] || s.tracking_status}
                        </span>
                      )}
                    </div>
                    {Array.isArray(s.tracking_checkpoints) && s.tracking_checkpoints.length > 0 && (
                      <div style={{ margin: '6px 0 4px 4px', borderLeft: '1px solid var(--border, #2a2a2a)', paddingLeft: 12 }}>
                        {s.tracking_checkpoints.map((c, i) => (
                          <div key={i} style={{ marginBottom: 7 }}>
                            <div style={{ fontSize: 12, color: 'var(--text-1, #eee)' }}>{c.label || STAGE_LABEL[c.stage] || c.stage}</div>
                            <div style={{ fontSize: 10.5, color: 'var(--text-3, #999)' }}>
                              {(c.location || '—')}{c.timestamp ? ` · ${fmtDate(c.timestamp)}` : ''}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          {isConfirmed && o.fulfilment_status === 'awaiting_acceptance' && (
            <p style={{ ...pageSub, marginTop: 12 }}>Sent to Depot for fulfilment — awaiting the dispatch team to accept. Tracking + status update here automatically.</p>
          )}
        </div>
      </div>

      {/* Lines */}
      <div style={panelStyle}>
        <div style={panelHeaderStyle}><span>Lines ({lines.length})</span></div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
            <thead><tr>
              {['#', 'Product', 'Model', 'Colour', 'HSN', 'Qty', 'Rate', 'Disc%', 'GST%', 'Taxable', 'Total'].map((h, i) => (
                <th key={i} style={{ ...tableThStyle, textAlign: ['Qty', 'Rate', 'Disc%', 'GST%', 'Taxable', 'Total'].includes(h) ? 'right' : 'left' }}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={l.id || i}>
                  <td style={{ ...tableTdStyle, color: 'var(--t3)' }}>{i + 1}</td>
                  <td style={tableTdStyle}>{l.product || '—'}{l.sku ? <span style={{ color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 11 }}> · {l.sku}</span> : ''}</td>
                  <td style={tableTdStyle}>{l.model || '—'}</td>
                  <td style={tableTdStyle}>{l.color || '—'}</td>
                  <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{l.hsn_code || '—'}</td>
                  <td style={{ ...tableTdStyle, textAlign: 'right', fontFamily: 'var(--mono)' }}>{l.qty}</td>
                  <td style={{ ...tableTdStyle, textAlign: 'right', fontFamily: 'var(--mono)' }}>{Number(l.rate).toLocaleString('en-IN')}</td>
                  <td style={{ ...tableTdStyle, textAlign: 'right', fontFamily: 'var(--mono)' }}>{Number(l.discount_pct) || 0}</td>
                  <td style={{ ...tableTdStyle, textAlign: 'right', fontFamily: 'var(--mono)' }}>{Number(l.gst_pct) || 0}</td>
                  <td style={{ ...tableTdStyle, textAlign: 'right', fontFamily: 'var(--mono)' }}>{Number(l.taxable_value).toLocaleString('en-IN')}</td>
                  <td style={{ ...tableTdStyle, textAlign: 'right', fontFamily: 'var(--mono)' }}>{Number(l.line_total).toLocaleString('en-IN')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ ...panelBodyStyle, display: 'flex', justifyContent: 'flex-end', gap: 24, fontSize: 13 }}>
          <span style={{ color: 'var(--t3)' }}>Subtotal <b style={{ color: 'var(--t1)' }}>{inr(o.subtotal)}</b></span>
          <span style={{ color: 'var(--t3)' }}>GST <b style={{ color: 'var(--t1)' }}>{inr(o.tax_total)}</b></span>
          <span style={{ color: 'var(--t3)' }}>Grand total <b style={{ color: 'var(--yellow)' }}>{inr(o.grand_total)}</b></span>
        </div>
      </div>

      {/* Payments */}
      <div style={panelStyle}>
        <div style={panelHeaderStyle}>
          <span>Collections · balance <b style={{ color: Number(o.balance) > 0 ? '#ff7070' : '#4ade80' }}>{inr(o.balance)}</b> of {inr(o.grand_total)}</span>
          {canPay && o.status !== 'cancelled' && <button style={btnSecondary} onClick={() => setPay(p => ({ ...p, open: !p.open }))}>{pay.open ? 'Close' : '+ Record receipt'}</button>}
        </div>
        {pay.open && (
          <div style={{ ...panelBodyStyle, display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', borderBottom: '1px solid var(--border)' }}>
            <div><label style={labelStyle}>Amount</label><input type="number" style={{ ...inputStyle, width: 120 }} value={pay.amount} onChange={e => setPay(p => ({ ...p, amount: e.target.value }))} /></div>
            <div><label style={labelStyle}>Date</label><input type="date" style={inputStyle} value={pay.received_date} onChange={e => setPay(p => ({ ...p, received_date: e.target.value }))} /></div>
            <div><label style={labelStyle}>Mode</label><select style={selectStyle} value={pay.mode} onChange={e => setPay(p => ({ ...p, mode: e.target.value }))}>{PAYMENT_MODES.map(m => <option key={m} value={m}>{m}</option>)}</select></div>
            <div><label style={labelStyle}>Reference</label><input style={{ ...inputStyle, width: 140 }} value={pay.reference} onChange={e => setPay(p => ({ ...p, reference: e.target.value }))} placeholder="UTR / cheque" /></div>
            <div style={{ flex: 1, minWidth: 120 }}><label style={labelStyle}>Note</label><input style={{ ...inputStyle, width: '100%' }} value={pay.note} onChange={e => setPay(p => ({ ...p, note: e.target.value }))} /></div>
            <button style={btnPrimary} onClick={recordPayment} disabled={busy}>Save</button>
          </div>
        )}
        <div style={{ overflowX: 'auto' }}>
          {payments.length === 0 ? (
            <div style={{ padding: 18, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>No receipts yet</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={tableThStyle}>Date</th><th style={{ ...tableThStyle, textAlign: 'right' }}>Amount</th>
                <th style={tableThStyle}>Mode</th><th style={tableThStyle}>Reference</th><th style={tableThStyle}>By</th><th style={tableThStyle}></th>
              </tr></thead>
              <tbody>
                {payments.map(p => (
                  <tr key={p.id}>
                    <td style={tableTdStyle}>{fmtDate(p.received_date)}</td>
                    <td style={{ ...tableTdStyle, textAlign: 'right', fontFamily: 'var(--mono)' }}>{inr(p.amount)}</td>
                    <td style={tableTdStyle}>{p.mode}</td>
                    <td style={tableTdStyle}>{p.reference || '—'}{p.note ? <span style={{ color: 'var(--t3)' }}> · {p.note}</span> : ''}</td>
                    <td style={{ ...tableTdStyle, color: 'var(--t3)' }}>{p.recorded_by_name || '—'}</td>
                    <td style={tableTdStyle}>{canPay && <button style={{ ...btnSecondary, padding: '3px 8px', color: '#ff7070' }} onClick={() => delPayment(p.id)}>×</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

export default function OrderDetailPage() {
  return <Suspense fallback={<div style={{ padding: 24 }}><Spinner /></div>}><OrderDetailInner /></Suspense>;
}
