'use client';
import { useState, useMemo } from 'react';
import { useProducts } from '@/hooks/useProducts';
import {
  panelStyle, panelHeaderStyle, panelBodyStyle, inputStyle, selectStyle, labelStyle,
  btnPrimary, btnSecondary, tableThStyle, tableTdStyle,
} from '@/lib/snorkelui';
import { inr } from '@/lib/sales';

function Field({ label, children, span }) {
  return (<div style={{ gridColumn: span ? '1 / -1' : 'auto' }}><label style={labelStyle}>{label}</label>{children}</div>);
}

const blankLine = () => ({ product: '', model: '', color: '', sku: '', hsn_code: '', description: '', qty: 1, rate: 0, discount_pct: 0, gst_pct: 18 });

export function lineMath(l) {
  const qty = Math.round(Number(l.qty) || 0);
  const rate = Number(l.rate) || 0;
  const disc = Number(l.discount_pct) || 0;
  const gst = Number(l.gst_pct) || 0;
  const taxable = +(qty * rate * (1 - disc / 100)).toFixed(2);
  const gstAmt = +(taxable * gst / 100).toFixed(2);
  return { taxable, gstAmt, total: +(taxable + gstAmt).toFixed(2) };
}

// Shared create/edit order form. `partners` + `channels` preloaded. `initial` optional (edit).
export default function OrderForm({ partners, channels, initial, saving, onSubmit, onCancel }) {
  const { PRODUCTS, PRODUCT_VARIANTS, PRODUCT_COLORS } = useProducts();
  const [partnerId, setPartnerId] = useState(initial?.partner_id || '');
  const [meta, setMeta] = useState({
    channel_key: initial?.channel_key || '',
    order_date: initial?.order_date || new Date().toISOString().slice(0, 10),
    credit_days: initial?.credit_days ?? 45,
    partner_po_ref: initial?.partner_po_ref || '',
    expected_dispatch_date: initial?.expected_dispatch_date || '',
    notes: initial?.notes || '',
  });
  const [lines, setLines] = useState(initial?.lines?.length ? initial.lines.map(l => ({ ...blankLine(), ...l })) : [blankLine()]);
  const setM = (k, v) => setMeta(s => ({ ...s, [k]: v }));

  const partner = useMemo(() => partners.find(p => p.id === partnerId), [partners, partnerId]);

  function pickPartner(pid) {
    setPartnerId(pid);
    const p = partners.find(x => x.id === pid);
    if (p) setMeta(s => ({ ...s, channel_key: p.channel_key || s.channel_key, credit_days: p.default_credit_days ?? s.credit_days }));
  }
  const setLine = (i, k, v) => setLines(ls => ls.map((l, j) => {
    if (j !== i) return l;
    const next = { ...l, [k]: v };
    if (k === 'product') { next.model = ''; next.color = ''; }
    if (k === 'model') { next.color = ''; }
    return next;
  }));
  const addLine = () => setLines(ls => [...ls, blankLine()]);
  const removeLine = (i) => setLines(ls => ls.length > 1 ? ls.filter((_, j) => j !== i) : ls);

  const totals = lines.reduce((acc, l) => {
    const m = lineMath(l); acc.taxable += m.taxable; acc.gst += m.gstAmt; acc.total += m.total; return acc;
  }, { taxable: 0, gst: 0, total: 0 });

  function submit() {
    onSubmit({
      partner_id: partnerId,
      channel_key: meta.channel_key || null,
      order_date: meta.order_date || null,
      credit_days: Math.round(Number(meta.credit_days) || 0),
      partner_po_ref: meta.partner_po_ref.trim() || null,
      expected_dispatch_date: meta.expected_dispatch_date || null,
      notes: meta.notes.trim() || null,
      lines: lines.filter(l => l.product || Number(l.qty) > 0).map((l, i) => ({
        product: l.product || null, model: l.model || null, color: l.color || null,
        sku: l.sku?.trim() || null, hsn_code: l.hsn_code?.trim() || null,
        description: l.description?.trim() || null,
        qty: Math.round(Number(l.qty) || 0), rate: Number(l.rate) || 0,
        discount_pct: Number(l.discount_pct) || 0, gst_pct: Number(l.gst_pct) || 0,
        sort_order: i,
      })),
    });
  }

  const valid = partnerId && lines.some(l => l.product && Number(l.qty) > 0);
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 };

  return (
    <div>
      <div style={panelStyle}>
        <div style={panelHeaderStyle}><span>Order</span></div>
        <div style={panelBodyStyle}>
          <div style={grid}>
            <Field label="Partner *">
              <select style={{ ...selectStyle, width: '100%' }} value={partnerId} onChange={e => pickPartner(e.target.value)}>
                <option value="">— select —</option>
                {partners.map(p => <option key={p.id} value={p.id}>{p.name} ({p.partner_code})</option>)}
              </select>
            </Field>
            <Field label="Channel">
              <select style={{ ...selectStyle, width: '100%' }} value={meta.channel_key} onChange={e => setM('channel_key', e.target.value)}>
                <option value="">— select —</option>
                {channels.map(c => <option key={c.channel_key} value={c.channel_key}>{c.label}</option>)}
              </select>
            </Field>
            <Field label="Credit days"><input type="number" style={{ ...inputStyle, width: '100%' }} value={meta.credit_days} onChange={e => setM('credit_days', e.target.value)} /></Field>
            <Field label="Order date"><input type="date" style={{ ...inputStyle, width: '100%' }} value={meta.order_date} onChange={e => setM('order_date', e.target.value)} /></Field>
            <Field label="Expected dispatch"><input type="date" style={{ ...inputStyle, width: '100%' }} value={meta.expected_dispatch_date} onChange={e => setM('expected_dispatch_date', e.target.value)} /></Field>
            <Field label="Partner PO ref"><input style={{ ...inputStyle, width: '100%' }} value={meta.partner_po_ref} onChange={e => setM('partner_po_ref', e.target.value)} /></Field>
            {partner && (
              <Field label="Place of supply" span>
                <div style={{ fontSize: 12, color: 'var(--t2)' }}>{partner.state || <span style={{ color: '#ff7070' }}>No state on partner — GST split needs it (set on the partner)</span>}{partner.gstin ? ` · GSTIN ${partner.gstin}` : ''}</div>
              </Field>
            )}
            <Field label="Notes" span><textarea style={{ ...inputStyle, width: '100%', minHeight: 44, fontFamily: 'inherit' }} value={meta.notes} onChange={e => setM('notes', e.target.value)} /></Field>
          </div>
        </div>
      </div>

      <div style={panelStyle}>
        <div style={panelHeaderStyle}><span>Lines</span><button style={btnSecondary} onClick={addLine}>+ Add line</button></div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 980 }}>
            <thead><tr>
              {['Product', 'Model', 'Colour', 'SKU', 'HSN', 'Qty', 'Rate', 'Disc%', 'GST%', 'Taxable', 'Total', ''].map((h, i) => (
                <th key={i} style={{ ...tableThStyle, textAlign: ['Qty', 'Rate', 'Disc%', 'GST%', 'Taxable', 'Total'].includes(h) ? 'right' : 'left' }}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {lines.map((l, i) => {
                const m = lineMath(l);
                const models = PRODUCT_VARIANTS[l.product] || [];
                const colors = (PRODUCT_COLORS[l.product] || {})[l.model] || [];
                const cell = { ...inputStyle, width: '100%', padding: '4px 6px' };
                const numCell = { ...cell, textAlign: 'right' };
                return (
                  <tr key={i}>
                    <td style={tableTdStyle}>
                      <select style={{ ...selectStyle, width: 130, padding: '4px 6px' }} value={l.product} onChange={e => setLine(i, 'product', e.target.value)}>
                        <option value="">—</option>
                        {PRODUCTS.map(p => <option key={p} value={p}>{p}</option>)}
                      </select>
                    </td>
                    <td style={tableTdStyle}>
                      <select style={{ ...selectStyle, width: 100, padding: '4px 6px' }} value={l.model} onChange={e => setLine(i, 'model', e.target.value)} disabled={!models.length}>
                        <option value="">{models.length ? '—' : 'n/a'}</option>
                        {models.map(mm => <option key={mm} value={mm}>{mm}</option>)}
                      </select>
                    </td>
                    <td style={tableTdStyle}>
                      <select style={{ ...selectStyle, width: 100, padding: '4px 6px' }} value={l.color} onChange={e => setLine(i, 'color', e.target.value)} disabled={!colors.length}>
                        <option value="">{colors.length ? '—' : 'n/a'}</option>
                        {colors.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </td>
                    <td style={tableTdStyle}><input style={{ ...cell, width: 90 }} value={l.sku || ''} onChange={e => setLine(i, 'sku', e.target.value)} /></td>
                    <td style={tableTdStyle}><input style={{ ...cell, width: 70, fontFamily: 'var(--mono)' }} value={l.hsn_code || ''} onChange={e => setLine(i, 'hsn_code', e.target.value)} placeholder="9503" /></td>
                    <td style={tableTdStyle}><input type="number" style={{ ...numCell, width: 56 }} value={l.qty} onChange={e => setLine(i, 'qty', e.target.value)} /></td>
                    <td style={tableTdStyle}><input type="number" style={{ ...numCell, width: 80 }} value={l.rate} onChange={e => setLine(i, 'rate', e.target.value)} /></td>
                    <td style={tableTdStyle}><input type="number" style={{ ...numCell, width: 56 }} value={l.discount_pct} onChange={e => setLine(i, 'discount_pct', e.target.value)} /></td>
                    <td style={tableTdStyle}><input type="number" style={{ ...numCell, width: 56 }} value={l.gst_pct} onChange={e => setLine(i, 'gst_pct', e.target.value)} /></td>
                    <td style={{ ...tableTdStyle, textAlign: 'right', fontFamily: 'var(--mono)' }}>{m.taxable.toLocaleString('en-IN')}</td>
                    <td style={{ ...tableTdStyle, textAlign: 'right', fontFamily: 'var(--mono)' }}>{m.total.toLocaleString('en-IN')}</td>
                    <td style={tableTdStyle}><button style={{ ...btnSecondary, padding: '3px 8px', color: '#ff7070' }} onClick={() => removeLine(i)}>×</button></td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot><tr>
              <td style={{ ...tableTdStyle, fontWeight: 700 }} colSpan={9}>Totals</td>
              <td style={{ ...tableTdStyle, textAlign: 'right', fontFamily: 'var(--mono)', fontWeight: 700 }}>{totals.taxable.toLocaleString('en-IN')}</td>
              <td style={{ ...tableTdStyle, textAlign: 'right', fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--yellow)' }}>{totals.total.toLocaleString('en-IN')}</td>
              <td style={tableTdStyle}></td>
            </tr></tfoot>
          </table>
        </div>
        <div style={{ ...panelBodyStyle, display: 'flex', justifyContent: 'flex-end', gap: 24, fontSize: 13 }}>
          <span style={{ color: 'var(--t3)' }}>Subtotal <b style={{ color: 'var(--t1)' }}>{inr(totals.taxable)}</b></span>
          <span style={{ color: 'var(--t3)' }}>GST <b style={{ color: 'var(--t1)' }}>{inr(totals.gst)}</b></span>
          <span style={{ color: 'var(--t3)' }}>Grand total <b style={{ color: 'var(--yellow)' }}>{inr(totals.total)}</b></span>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button style={btnPrimary} onClick={submit} disabled={saving || !valid}>{saving ? 'Saving…' : 'Save Order'}</button>
        <button style={btnSecondary} onClick={onCancel} disabled={saving}>Cancel</button>
      </div>
    </div>
  );
}
