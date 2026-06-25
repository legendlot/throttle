'use client';
import { useEffect, useState, useMemo, useCallback, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, Combobox, useToast } from '@throttle/ui';
import {
  panelStyle, panelHeaderStyle, panelBodyStyle, inputStyle, selectStyle, labelStyle,
  btnPrimary, btnSecondary, tableThStyle, tableTdStyle,
} from '@/lib/snorkelui';
import { inr, CREDIT_NOTE_REASONS } from '@/lib/sales';

const num = (v) => Number(v) || 0;
function lineMath(l) {
  const qty = Math.round(num(l.qty)), rate = num(l.rate), gst = num(l.gst_pct);
  const taxable = +(qty * rate).toFixed(2);
  const gstAmt = +(taxable * gst / 100).toFixed(2);
  return { taxable, gstAmt, total: +(taxable + gstAmt).toFixed(2) };
}

function NewCreditNoteInner() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const sp = useSearchParams();
  const editId = sp.get('id');
  const preOrder = sp.get('order');

  const [orderId, setOrderId] = useState('');
  const [orderOpts, setOrderOpts] = useState([]);
  const [od, setOd] = useState(null);            // getOrderForCreditNote result
  const [lines, setLines] = useState([]);
  const [reason, setReason] = useState('under_supply');
  const [reasonNote, setReasonNote] = useState('');
  const [cnDate, setCnDate] = useState(new Date().toISOString().slice(0, 10));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const canManage = !!perms?.sales_credit_note;

  // Order picker options (invoiced, confirmed orders) — only when not editing/preselected.
  useEffect(() => {
    if (!session || editId) return;
    garageFetch('getSalesOrders', {}, session).then(d => {
      const opts = (Array.isArray(d) ? d : [])
        .filter(o => o.invoice_generated && o.status === 'confirmed')
        .map(o => ({ value: o.id, label: `${o.order_no} · ${o.partner_name || ''} · ${o.invoice_no}` }));
      setOrderOpts(opts);
    }).catch(() => {});
  }, [session, editId]);

  // Build editable lines from an order's invoice lines.
  const linesFromOrder = useCallback((oLines) => (oLines || []).map(l => ({
    order_line_id: l.id, product: l.product, model: l.model, color: l.color, sku: l.sku,
    hsn_code: l.hsn_code, description: l.description, gst_pct: num(l.gst_pct),
    orig_rate: num(l.rate), rate: num(l.rate), qty: 0, remaining_qty: num(l.remaining_qty), free: false,
  })), []);

  const loadOrder = useCallback(async (oid) => {
    const res = await garageFetch('getOrderForCreditNote', { order_id: oid }, session);
    setOd(res);
    return res;
  }, [session]);

  // Initial load: edit mode, preselected order, or empty picker.
  useEffect(() => {
    if (!session) return;
    (async () => {
      setLoading(true);
      try {
        if (editId) {
          const cn = await garageFetch('getCreditNote', { id: editId }, session);
          if (!cn?.cn) { showToast('Credit note not found', 'error'); return; }
          if (cn.cn.status !== 'draft') { showToast('Only draft credit notes can be edited', 'error'); router.replace(`/sales/credit-notes/detail?id=${editId}`); return; }
          setOrderId(cn.cn.order_id);
          setReason(cn.cn.reason); setReasonNote(cn.cn.reason_note || ''); setCnDate(cn.cn.cn_date);
          await loadOrder(cn.cn.order_id);
          setLines((cn.lines || []).map(l => ({
            order_line_id: l.order_line_id || null, product: l.product, model: l.model, color: l.color,
            sku: l.sku, hsn_code: l.hsn_code, description: l.description, gst_pct: num(l.gst_pct),
            orig_rate: num(l.rate), rate: num(l.rate), qty: num(l.qty),
            remaining_qty: null, free: !l.order_line_id,
          })));
        } else if (preOrder) {
          setOrderId(preOrder);
          const res = await loadOrder(preOrder);
          setLines(linesFromOrder(res?.lines));
        }
      } catch (e) { showToast(e.message || 'Failed to load', 'error'); }
      finally { setLoading(false); }
    })();
  }, [session, editId, preOrder, loadOrder, linesFromOrder, router, showToast]);

  async function pickOrder(oid) {
    setOrderId(oid);
    setLoading(true);
    try { const res = await loadOrder(oid); setLines(linesFromOrder(res?.lines)); }
    catch (e) { showToast(e.message || 'Failed to load order', 'error'); }
    finally { setLoading(false); }
  }

  const setLine = (i, k, v) => setLines(ls => ls.map((l, j) => j === i ? { ...l, [k]: v } : l));
  const addFreeLine = () => setLines(ls => [...ls, { order_line_id: null, product: '', model: '', color: '', sku: '', hsn_code: '', description: '', gst_pct: 18, orig_rate: 0, rate: 0, qty: 1, remaining_qty: null, free: true }]);
  const removeLine = (i) => setLines(ls => ls.filter((_, j) => j !== i));

  const totals = useMemo(() => lines.reduce((a, l) => {
    const m = lineMath(l); a.taxable += m.taxable; a.gst += m.gstAmt; a.total += m.total; return a;
  }, { taxable: 0, gst: 0, total: 0 }), [lines]);

  // Cap: remaining invoice value (excludes self in edit mode handled server-side; here add back self for UI).
  const remaining = od ? num(od.remaining_value) : 0;
  const overCap = !editId && totals.total > remaining + 0.005;
  const qtyViolation = lines.some(l => !l.free && l.remaining_qty != null && Math.round(num(l.qty)) > l.remaining_qty + 0.0001);
  const valid = orderId && totals.total > 0 && !overCap && !qtyViolation && reason;

  async function submit() {
    const payloadLines = lines
      .filter(l => Math.round(num(l.qty)) > 0 && num(l.rate) > 0)
      .map(l => ({ order_line_id: l.order_line_id || null, product: l.product || null, model: l.model || null,
        color: l.color || null, sku: l.sku || null, hsn_code: l.hsn_code || null, description: l.description || null,
        qty: Math.round(num(l.qty)), rate: num(l.rate), gst_pct: num(l.gst_pct) }));
    if (!payloadLines.length) { showToast('Add at least one credit line with qty and rate', 'error'); return; }
    setSaving(true);
    try {
      const body = { order_id: orderId, reason, reason_note: reasonNote.trim() || null, cn_date: cnDate, lines: payloadLines };
      const res = editId
        ? await workerFetch('updateCreditNote', { id: editId, ...body }, session)
        : await workerFetch('createCreditNote', body, session);
      if (res?.ok) { showToast('Saved', 'success'); router.push(`/sales/credit-notes/detail?id=${editId || res.data.id}`); }
      else showToast(res?.error || 'Save failed', 'error');
    } catch (e) { showToast(e.message || 'Save failed', 'error'); }
    finally { setSaving(false); }
  }

  if (perms && !canManage) return <div style={{ padding: 24, color: 'var(--text-3)' }}>You do not have permission to raise credit notes.</div>;
  if (loading) return <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div>;

  const cell = { ...inputStyle, width: '100%', padding: '4px 6px' };
  const numCell = { ...cell, textAlign: 'right' };

  return (
    <div className="pg">
      <h2 style={{ margin: '4px 0 12px' }}>{editId ? 'Edit credit note' : 'New credit note'}</h2>

      <div style={panelStyle}>
        <div style={panelHeaderStyle}><span>Against invoice</span></div>
        <div style={panelBodyStyle}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
            <div>
              <label style={labelStyle}>Invoiced order *</label>
              {editId || preOrder ? (
                <div style={{ fontSize: 13, color: 'var(--t1)' }}>
                  {od ? `${od.order.order_no} · ${od.partner?.name || ''} · ${od.order.invoice_no}` : '—'}
                </div>
              ) : (
                <Combobox value={orderId} options={orderOpts} onChange={pickOrder}
                  placeholder="Search invoiced order…" emptyLabel="No invoiced orders" />
              )}
            </div>
            <div>
              <label style={labelStyle}>Reason *</label>
              <select style={{ ...selectStyle, width: '100%' }} value={reason} onChange={e => setReason(e.target.value)}>
                {CREDIT_NOTE_REASONS.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Credit note date</label>
              <input type="date" style={{ ...inputStyle, width: '100%' }} value={cnDate} onChange={e => setCnDate(e.target.value)} />
            </div>
            {od && (
              <div style={{ gridColumn: '1 / -1', fontSize: 12, color: 'var(--t2)' }}>
                Invoice {od.order.invoice_no} · {od.partner?.name}{od.partner?.state ? ` · ${od.partner.state}` : ''}
                {' · '}Remaining creditable: <b style={{ color: overCap ? 'var(--red-fg)' : 'var(--t1)' }}>{inr(remaining)}</b>
              </div>
            )}
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={labelStyle}>Note</label>
              <input style={{ ...inputStyle, width: '100%' }} value={reasonNote} onChange={e => setReasonNote(e.target.value)} placeholder="Optional — context for this credit" />
            </div>
          </div>
        </div>
      </div>

      {orderId && (
        <div style={panelStyle}>
          <div style={panelHeaderStyle}>
            <span>Credit lines</span>
            <button style={btnSecondary} onClick={addFreeLine}>+ Free-form line</button>
          </div>
          <div style={{ padding: '0 16px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', minWidth: 980 }}>
              <colgroup>{[230, 70, 80, 80, 70, 90, 90, 44].map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>
              <thead><tr>
                {['Item', 'Remaining', 'HSN', 'Credit qty', 'Rate', 'GST%', 'Taxable', ''].map((h, i) => (
                  <th key={i} style={{ ...tableThStyle, textAlign: ['Remaining', 'Credit qty', 'Rate', 'GST%', 'Taxable'].includes(h) ? 'right' : 'left' }}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {lines.map((l, i) => {
                  const m = lineMath(l);
                  const over = !l.free && l.remaining_qty != null && Math.round(num(l.qty)) > l.remaining_qty + 0.0001;
                  return (
                    <tr key={i}>
                      <td style={tableTdStyle}>
                        {l.free
                          ? <input style={cell} value={l.description || ''} onChange={e => setLine(i, 'description', e.target.value)} placeholder="Description (e.g. transit damage)" />
                          : <span>{[l.product, l.model, l.color].filter(Boolean).join(' ') || l.description || '—'}</span>}
                      </td>
                      <td style={{ ...tableTdStyle, textAlign: 'right', color: 'var(--t3)' }}>{l.free ? '—' : (l.remaining_qty != null ? l.remaining_qty : '—')}</td>
                      <td style={tableTdStyle}><input style={{ ...cell, fontFamily: 'var(--mono)' }} value={l.hsn_code || ''} onChange={e => setLine(i, 'hsn_code', e.target.value)} placeholder="9503" /></td>
                      <td style={tableTdStyle}><input type="number" style={{ ...numCell, color: over ? 'var(--red-fg)' : undefined }} value={l.qty} onChange={e => setLine(i, 'qty', e.target.value)} /></td>
                      <td style={tableTdStyle}><input type="number" style={numCell} value={l.rate} onChange={e => setLine(i, 'rate', e.target.value)} title={l.free ? '' : `Original rate ${l.orig_rate} — lower for a price-drop credit`} /></td>
                      <td style={tableTdStyle}><input type="number" style={numCell} value={l.gst_pct} onChange={e => setLine(i, 'gst_pct', e.target.value)} /></td>
                      <td style={{ ...tableTdStyle, textAlign: 'right', fontFamily: 'var(--mono)' }}>{m.taxable.toLocaleString('en-IN')}</td>
                      <td style={tableTdStyle}>{l.free && <button style={{ ...btnSecondary, padding: '3px 8px', color: '#ff7070' }} onClick={() => removeLine(i)}>×</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ ...panelBodyStyle, display: 'flex', justifyContent: 'flex-end', gap: 24, fontSize: 13 }}>
            <span style={{ color: 'var(--t3)' }}>Taxable <b style={{ color: 'var(--t1)' }}>{inr(totals.taxable)}</b></span>
            <span style={{ color: 'var(--t3)' }}>GST <b style={{ color: 'var(--t1)' }}>{inr(totals.gst)}</b></span>
            <span style={{ color: 'var(--t3)' }}>Total credit <b style={{ color: overCap ? 'var(--red-fg)' : 'var(--yellow)' }}>{inr(totals.total)}</b></span>
          </div>
          {overCap && <div style={{ padding: '0 16px 12px', color: 'var(--red-fg)', fontSize: 12 }}>Total credit exceeds the remaining invoice value ({inr(remaining)}).</div>}
          {qtyViolation && <div style={{ padding: '0 16px 12px', color: 'var(--red-fg)', fontSize: 12 }}>A credit qty exceeds the remaining invoiced qty for its line.</div>}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button style={btnPrimary} onClick={submit} disabled={saving || !valid}>{saving ? 'Saving…' : 'Save draft'}</button>
        <button style={btnSecondary} onClick={() => router.back()} disabled={saving}>Cancel</button>
      </div>
    </div>
  );
}

export default function NewCreditNotePage() {
  return <Suspense fallback={<div style={{ padding: 40 }}><Spinner /></div>}><NewCreditNoteInner /></Suspense>;
}
