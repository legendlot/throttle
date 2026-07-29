'use client';
import { useEffect, useState, useCallback, useRef, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import {
  panelStyle, panelHeaderStyle, panelBodyStyle, tableThStyle, tableTdStyle, inputStyle, selectStyle, labelStyle,
  btnPrimary, btnSecondary, btnDanger, pageH1, pageSub, StatusBadge, fmtDate,
} from '@/lib/snorkelui';
import { orderStatusLabel, ORDER_STATUS_TONES, fulfilmentMeta, paymentMeta, PAYMENT_MODES, inr, creditReasonLabel, cnStatusLabel, CN_STATUS_TONES } from '@/lib/sales';
import OrderForm from '../OrderForm';

// Normalized courier stage (from courierops tracking_status) → label + colour for the SO timeline.
const STAGE_LABEL = {
  manifested: 'Manifested', picked_up: 'Picked up', in_transit: 'In transit', out_for_delivery: 'Out for delivery',
  part_delivered: 'Partially delivered', delivered: 'Delivered', undelivered: 'Undelivered', not_picked: 'Not picked',
  rto_in_transit: 'RTO in transit', rto_delivered: 'RTO delivered', cancelled: 'Cancelled', lost: 'Lost', unknown: 'Unknown',
};
const STAGE_COLOR = {
  delivered: 'var(--green-fg, #2faa5a)', out_for_delivery: '#d98a00', part_delivered: '#d98a00', in_transit: '#6af',
  picked_up: '#6af', undelivered: '#e2574c', not_picked: '#e2574c', rto_in_transit: '#d98a00', rto_delivered: '#9aa',
  cancelled: '#e2574c', lost: '#e2574c', manifested: '#6af', unknown: '#9aa',
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
  // Metadata-only edit for CONFIRMED un-invoiced orders (S229): date / PO ref / expected dispatch / notes.
  const [metaEdit, setMetaEdit] = useState(null);   // null | { order_date, partner_po_ref, expected_dispatch_date, notes }
  const [lineEdit, setLineEdit] = useState(null);   // null | [{ id, product, model, color, hsn_code, qty, rate, discount_pct, gst_pct }]
  const [creditNotes, setCreditNotes] = useState([]);

  const canManage = !!perms?.sales_order_manage;
  const canConfirm = !!perms?.sales_order_confirm;
  const canPay = !!perms?.sales_payment_manage;
  const canCN = !!perms?.sales_credit_note;

  // A tab switch or token refresh hands us a NEW session OBJECT with the same user.
  // Keying `load` on it re-ran the fetch, which flipped `loading` and unmounted an
  // open edit form mid-typing (Vinayram, 2026-07-29). Hold the live session in a ref
  // so every fetch still uses a current token, and key the load on the stable user id.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const userId = session?.user?.id ?? null;

  const load = useCallback(async () => {
    const s = sessionRef.current;
    if (!s || !id) return;
    setLoading(true);
    try {
      const o = await garageFetch('getSalesOrder', { id }, s);
      setData(o || null);
      if (o?.invoice_generated) {
        const cns = await garageFetch('getCreditNotes', { order_id: id }, s).catch(() => []);
        setCreditNotes(Array.isArray(cns) ? cns : []);
      } else setCreditNotes([]);
    } catch (e) { showToast(e.message || 'Failed to load order', 'error'); }
    finally { setLoading(false); }
  }, [userId, id, showToast]);

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
  // Never swap an open edit surface for the spinner — a background refetch must not
  // discard what the user is typing (full edit form, or the inline meta/line editors).
  if (loading && !editing && !metaEdit && !lineEdit) return <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>;
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

  // Editing items on a CONFIRMED order (Ram, 2026-07-27) — requirements change after a
  // partner PO lands but before it ships. The worker owns the safety envelope: HSN and
  // pricing stay open until invoicing, while model/colour/qty are refused once anything
  // is packed and otherwise propagated to the dispatch manifest in the same call.
  function startLineEdit() {
    setLineEdit(lines.map(l => ({
      id: l.id, product: l.product || '', model: l.model || '', color: l.color || '',
      hsn_code: l.hsn_code || '', qty: l.qty ?? 0, rate: l.rate ?? 0,
      discount_pct: l.discount_pct ?? 0, gst_pct: l.gst_pct ?? 0,
    })));
  }
  function setLineField(id, field, value) {
    setLineEdit(prev => prev.map(l => (l.id === id ? { ...l, [field]: value } : l)));
  }
  async function saveLineEdit() {
    if (lineEdit.some(l => !String(l.model || '').trim() && !String(l.color || '').trim() && !l.hsn_code)) {
      // not fatal — just avoids silently blanking a variant the manifest matches on
    }
    if (lineEdit.some(l => !(Math.round(Number(l.qty)) > 0))) { showToast('Every line needs a quantity above zero', 'error'); return; }
    setBusy(true);
    try {
      const res = await workerFetch('updateSalesOrder', { data: { id, lines: lineEdit } }, session);
      if (!res.ok) throw new Error(res.error || 'Update failed');
      const hs = res.data?.hsn_synced || [];
      showToast(hs.length ? `Items updated — HSN ${hs[0].to} saved to ${hs.map(h => h.product).join(', ')} for future orders`
              : res.data?.manifest_synced ? 'Items updated — dispatch manifest updated too'
              : res.data?.dispatch_synced ? 'Items updated — dispatch request updated too'
              : 'Items updated', 'success');
      setLineEdit(null);
      await load();
    } catch (e) { showToast(e.message || 'Update failed', 'error'); }
    finally { setBusy(false); }
  }

  async function startEdit() { await loadFormMasters(); setEditing(true); }
  function startMetaEdit() {
    setMetaEdit({
      order_date: o.order_date || '',
      partner_po_ref: o.partner_po_ref || '',
      expected_dispatch_date: o.expected_dispatch_date || '',
      notes: o.notes || '',
    });
  }
  async function saveMetaEdit() {
    if (!metaEdit?.order_date) { showToast('Order date is required', 'error'); return; }
    setBusy(true);
    try {
      const res = await workerFetch('updateSalesOrder', { data: {
        id,
        order_date: metaEdit.order_date,
        partner_po_ref: metaEdit.partner_po_ref,
        expected_dispatch_date: metaEdit.expected_dispatch_date,
        notes: metaEdit.notes,
      } }, session);
      if (!res.ok) throw new Error(res.error || 'Update failed');
      showToast('Order details updated', 'success');
      setMetaEdit(null);
      await load();
    } catch (e) { showToast(e.message || 'Update failed', 'error'); }
    finally { setBusy(false); }
  }
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
          {isConfirmed && canManage && !o.invoice_generated && <button style={btnSecondary} onClick={startMetaEdit} disabled={busy}>Edit details</button>}
          {isDraft && canConfirm && <button style={btnPrimary} onClick={confirm} disabled={busy}>Confirm → Dispatch</button>}
          {isConfirmed && canManage && !o.invoice_generated && <button style={btnPrimary} onClick={genInvoice} disabled={busy}>Generate Invoice</button>}
          {o.invoice_generated && <button style={btnSecondary} onClick={() => router.push(`/sales/orders/invoice?id=${encodeURIComponent(id)}`)}>🖶 Invoice</button>}
          {(isDraft || isConfirmed) && canManage && <button style={btnDanger} onClick={cancel} disabled={busy}>Cancel</button>}
        </div>
      </div>

      {/* Metadata-only edit (confirmed, un-invoiced): date / PO ref / expected dispatch / notes */}
      {metaEdit && (
        <div style={{ ...panelStyle, marginBottom: 14 }}>
          <div style={panelHeaderStyle}>Edit details</div>
          <div style={{ ...panelBodyStyle, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, alignItems: 'end' }}>
            <div>
              <div style={labelStyle}>Order date *</div>
              <input type="date" style={inputStyle} value={metaEdit.order_date}
                onChange={e => setMetaEdit(m => ({ ...m, order_date: e.target.value }))} />
            </div>
            <div>
              <div style={labelStyle}>Partner PO ref</div>
              <input style={inputStyle} value={metaEdit.partner_po_ref} placeholder="e.g. Blinkit PO no."
                onChange={e => setMetaEdit(m => ({ ...m, partner_po_ref: e.target.value }))} />
            </div>
            <div>
              <div style={labelStyle}>Expected dispatch</div>
              <input type="date" style={inputStyle} value={metaEdit.expected_dispatch_date}
                onChange={e => setMetaEdit(m => ({ ...m, expected_dispatch_date: e.target.value }))} />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button style={btnPrimary} onClick={saveMetaEdit} disabled={busy}>Save</button>
              <button style={btnSecondary} onClick={() => setMetaEdit(null)} disabled={busy}>Cancel</button>
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <div style={labelStyle}>Notes</div>
              <input style={inputStyle} value={metaEdit.notes}
                onChange={e => setMetaEdit(m => ({ ...m, notes: e.target.value }))} />
            </div>
          </div>
          <div style={{ padding: '0 16px 12px', fontSize: 12, color: 'var(--t3)' }}>
            Channel, warehouse and credit terms are locked after confirmation. Items can still be edited — see Lines below.
          </div>
        </div>
      )}

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
        <div style={{ ...panelHeaderStyle, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>Lines ({lines.length})</span>
          {isConfirmed && canManage && !o.invoice_generated && (
            lineEdit ? (
              <span style={{ display: 'flex', gap: 8 }}>
                <button style={btnPrimary} onClick={saveLineEdit} disabled={busy}>Save items</button>
                <button style={btnSecondary} onClick={() => setLineEdit(null)} disabled={busy}>Cancel</button>
              </span>
            ) : (
              <button style={btnSecondary} onClick={startLineEdit} disabled={busy}>Edit items</button>
            )
          )}
        </div>
        {lineEdit && (
          <div style={{ ...panelBodyStyle, paddingTop: 0, paddingBottom: 0 }}>
            <p style={pageSub}>
              HSN and pricing can be changed right up to invoicing. Model, colour and quantity
              can only change while nothing has been packed — if dispatch has already packed
              against this order, save will be refused and tell you so.
            </p>
            <p style={{ ...pageSub, marginTop: 4 }}>
              HSN is pre-filled from the product master — <b>please check it</b>. If you correct
              it here, the product master is updated too, so every future order for that product
              picks up the corrected code.
            </p>
          </div>
        )}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
            <thead><tr>
              {['#', 'Product', 'Model', 'Colour', 'HSN', 'Qty', 'Rate', 'Disc%', 'GST%', 'Taxable', 'Total'].map((h, i) => (
                <th key={i} style={{ ...tableThStyle, textAlign: ['Qty', 'Rate', 'Disc%', 'GST%', 'Taxable', 'Total'].includes(h) ? 'right' : 'left' }}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {(lineEdit || lines).map((l, i) => {
                if (!lineEdit) return (
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
                );
                const cell = (field, opts = {}) => (
                  <input
                    value={l[field] ?? ''}
                    onChange={e => setLineField(l.id, field, e.target.value)}
                    type={opts.numeric ? 'number' : 'text'}
                    style={{ width: '100%', minWidth: opts.numeric ? 64 : 88, background: 'var(--bg-1)',
                      border: '1px solid var(--border)', borderRadius: 4, padding: '4px 6px',
                      color: 'var(--t1)', fontSize: 12,
                      fontFamily: opts.numeric || field === 'hsn_code' ? 'var(--mono)' : 'inherit',
                      textAlign: opts.numeric ? 'right' : 'left' }} />
                );
                // Taxable/total are derived server-side by computeSalesLine — showing a
                // half-recomputed figure mid-edit would just be a second source of truth.
                return (
                  <tr key={l.id}>
                    <td style={{ ...tableTdStyle, color: 'var(--t3)' }}>{i + 1}</td>
                    <td style={tableTdStyle}>{l.product || '—'}</td>
                    <td style={tableTdStyle}>{cell('model')}</td>
                    <td style={tableTdStyle}>{cell('color')}</td>
                    <td style={tableTdStyle}>{cell('hsn_code')}</td>
                    <td style={tableTdStyle}>{cell('qty', { numeric: true })}</td>
                    <td style={tableTdStyle}>{cell('rate', { numeric: true })}</td>
                    <td style={tableTdStyle}>{cell('discount_pct', { numeric: true })}</td>
                    <td style={tableTdStyle}>{cell('gst_pct', { numeric: true })}</td>
                    <td style={{ ...tableTdStyle, textAlign: 'right', color: 'var(--t3)' }}>—</td>
                    <td style={{ ...tableTdStyle, textAlign: 'right', color: 'var(--t3)' }}>—</td>
                  </tr>
                );
              })}
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

      {/* Credit notes (invoiced orders only) */}
      {o.invoice_generated && (
        <div style={panelStyle}>
          <div style={panelHeaderStyle}>
            <span>Credit notes · net due after credits <b style={{ color: 'var(--yellow)' }}>{inr(+(Number(o.grand_total) - Number(o.credit_total || 0) - Number(o.amount_received)).toFixed(2))}</b>{Number(o.credit_total) > 0 ? <span style={{ color: 'var(--t3)' }}> · {inr(o.credit_total)} credited</span> : null}</span>
            {canCN && o.status !== 'cancelled' && <button style={btnSecondary} onClick={() => router.push(`/sales/credit-notes/new?order=${encodeURIComponent(id)}`)}>+ Raise credit note</button>}
          </div>
          <div style={{ overflowX: 'auto' }}>
            {creditNotes.length === 0 ? (
              <div style={{ padding: 18, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>No credit notes</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={tableThStyle}>CN No</th><th style={tableThStyle}>Status</th><th style={tableThStyle}>Date</th>
                  <th style={tableThStyle}>Reason</th><th style={{ ...tableThStyle, textAlign: 'right' }}>Total</th>
                </tr></thead>
                <tbody>
                  {creditNotes.map(c => (
                    <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => router.push(`/sales/credit-notes/detail?id=${encodeURIComponent(c.id)}`)}>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{c.cn_no || '(draft)'}</td>
                      <td style={tableTdStyle}><StatusBadge label={cnStatusLabel(c.status)} tone={CN_STATUS_TONES[c.status] || 'gray'} /></td>
                      <td style={tableTdStyle}>{fmtDate(c.cn_date)}</td>
                      <td style={tableTdStyle}>{creditReasonLabel(c.reason)}</td>
                      <td style={{ ...tableTdStyle, textAlign: 'right', fontFamily: 'var(--mono)' }}>{inr(c.grand_total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function OrderDetailPage() {
  return <Suspense fallback={<div style={{ padding: 24 }}><Spinner /></div>}><OrderDetailInner /></Suspense>;
}
