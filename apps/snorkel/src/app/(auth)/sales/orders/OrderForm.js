'use client';
import { useState, useMemo, useEffect } from 'react';
import { Combobox, Modal } from '@throttle/ui';
import { garageFetch } from '@throttle/db';
import { useAuth } from '@throttle/auth';
import { todayStr } from '@throttle/domain';
import { useProducts } from '@/hooks/useProducts';
import {
  panelStyle, panelHeaderStyle, panelBodyStyle, inputStyle, selectStyle, labelStyle,
  btnPrimary, btnSecondary, tableThStyle, tableTdStyle,
} from '@/lib/snorkelui';
import { inr } from '@/lib/sales';
import PartnerForm from '../partners/PartnerForm';

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
// `onCreatePartner` (optional, async (data) => newPartnerRow) enables the inline
// "+ Add" partner quick-create — pass it only when the user can manage partners.
export default function OrderForm({ partners, channels, initial, saving, onSubmit, onCancel, onCreatePartner }) {
  const { PRODUCTS, PRODUCT_VARIANTS, PRODUCT_COLORS } = useProducts();
  const { session } = useAuth();
  const [partnerId, setPartnerId] = useState(initial?.partner_id || '');
  const [partnerModal, setPartnerModal] = useState(false);
  const [creatingPartner, setCreatingPartner] = useState(false);
  const [meta, setMeta] = useState({
    channel_key: initial?.channel_key || '',
    order_date: initial?.order_date || todayStr(),
    credit_days: initial?.credit_days ?? 45,
    partner_po_ref: initial?.partner_po_ref || '',
    expected_dispatch_date: initial?.expected_dispatch_date || '',
    destination_warehouse: initial?.destination_warehouse || '',
    notes: initial?.notes || '',
  });
  const [lines, setLines] = useState(initial?.lines?.length ? initial.lines.map(l => ({ ...blankLine(), ...l })) : [blankLine()]);
  const setM = (k, v) => setMeta(s => ({ ...s, [k]: v }));
  // product -> { hsn_code, gst_pct } from the product master (Afshaan 2026-07-27).
  const [hsnMap, setHsnMap] = useState({});
  const [hsnTouched, setHsnTouched] = useState({});   // lines where the user edited HSN/GST themselves
  useEffect(() => {
    if (!session) return;
    garageFetch('getProductHsnMap', {}, session)
      .then(rows => setHsnMap(Object.fromEntries((Array.isArray(rows) ? rows : []).map(r => [r.product, r]))))
      .catch(() => {});   // non-fatal: the field stays typeable, it just isn't pre-filled
  }, [session]);

  const partner = useMemo(() => partners.find(p => p.id === partnerId), [partners, partnerId]);

  const partnerOptions = useMemo(
    () => partners.map(p => ({ value: p.id, label: p.name, hint: p.partner_code })),
    [partners]
  );
  // Partners order by the name printed on THEIR PO, which is often the variant rather
  // than our product name — Blinkit's "L.O.T Build Harry Potter Wooden Collectible
  // Puzzle" is our product `HP Desk warmer standee`, model `Harry Potter with Hedwig`.
  // Matching on the product name alone made those SKUs look absent (#bugs 2026-07-21),
  // so feed every model + colour in as hidden `search` text: the dropdown still lists
  // just the product, but typing a character/variant/colour name finds it.
  const productOptions = useMemo(() => PRODUCTS.map((p) => {
    const models = PRODUCT_VARIANTS[p] || [];
    const colors = Object.values(PRODUCT_COLORS[p] || {}).flat();
    return {
      value: p,
      label: p,
      search: [...models, ...new Set(colors)].join(' '),
    };
  }), [PRODUCTS, PRODUCT_VARIANTS, PRODUCT_COLORS]);

  function applyPartner(p) {
    if (p) setMeta(s => ({ ...s, channel_key: p.channel_key || s.channel_key, credit_days: p.default_credit_days ?? s.credit_days }));
  }
  function pickPartner(pid) {
    setPartnerId(pid);
    applyPartner(partners.find(x => x.id === pid));
  }

  // Inline quick-create: parent persists the partner + returns the new row; we
  // select it directly off that row (the `partners` prop may not have refreshed yet).
  async function handleCreatePartner(data) {
    if (!onCreatePartner) return;
    setCreatingPartner(true);
    try {
      const np = await onCreatePartner(data);
      if (np?.id) { setPartnerId(np.id); applyPartner(np); }
      setPartnerModal(false);
    } catch { /* parent surfaces the error toast */ }
    finally { setCreatingPartner(false); }
  }
  const setLine = (i, k, v) => setLines(ls => ls.map((l, j) => {
    if (j !== i) return l;
    const next = { ...l, [k]: v };
    if (k === 'product') {
      next.model = ''; next.color = '';
      // Pre-fill HSN + GST from the product master so nobody types a tax code from
      // memory (and so L.O.T Build lands on 5%, not the 18% blankLine default).
      // Only fills what's still untouched — never overwrites a typed code. The team
      // confirms it on screen; correcting it here syncs back to the master on save.
      const m = hsnMap[v];
      if (m) {
        if (!String(l.hsn_code || '').trim()) next.hsn_code = m.hsn_code || '';
        if (m.gst_pct != null && !hsnTouched[i]) next.gst_pct = m.gst_pct;
      }
    }
    if (k === 'model') { next.color = ''; }
    if (k === 'gst_pct' || k === 'hsn_code') setHsnTouched(t => ({ ...t, [i]: true }));
    return next;
  }));
  const addLine = () => setLines(ls => [...ls, blankLine()]);
  const removeLine = (i) => setLines(ls => ls.length > 1 ? ls.filter((_, j) => j !== i) : ls);

  const totals = lines.reduce((acc, l) => {
    const m = lineMath(l); acc.taxable += m.taxable; acc.gst += m.gstAmt; acc.total += m.total; return acc;
  }, { taxable: 0, gst: 0, total: 0 });

  // Guard at the source (Afshaan's standing rule): a STARTED line (has a product or a qty)
  // must carry a model when the product has variants, and a colour when that product+model
  // has colours. A null model/colour rides silently through the fulfilment request into the
  // shipment manifest and only hard-rejects days later at the PACK station. Data-driven off
  // the same PRODUCT_VARIANTS/PRODUCT_COLORS maps the pickers use — so a genuinely
  // model-less / colour-less product is never falsely blocked.
  const lineErrors = useMemo(() => lines.map((l, i) => {
    const started = l.product || Number(l.qty) > 0;
    if (!started) return null;
    const miss = [];
    if (!l.product) miss.push('product');
    if (!(Number(l.qty) > 0)) miss.push('quantity');
    if (l.product && (PRODUCT_VARIANTS[l.product] || []).length && !l.model) miss.push('model');
    if (l.product && ((PRODUCT_COLORS[l.product] || {})[l.model] || []).length && !l.color) miss.push('colour');
    return miss.length ? { i, miss } : null;
  }).filter(Boolean), [lines, PRODUCT_VARIANTS, PRODUCT_COLORS]);

  function submit() {
    if (lineErrors.length) return;   // Save is disabled on this, but never trust the button alone
    onSubmit({
      partner_id: partnerId,
      channel_key: meta.channel_key || null,
      order_date: meta.order_date || null,
      credit_days: Math.round(Number(meta.credit_days) || 0),
      partner_po_ref: meta.partner_po_ref.trim() || null,
      expected_dispatch_date: meta.expected_dispatch_date || null,
      destination_warehouse: meta.destination_warehouse.trim() || null,
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

  const valid = partnerId && lines.some(l => l.product && Number(l.qty) > 0) && lineErrors.length === 0;
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 };

  return (
    <div>
      <div style={panelStyle}>
        <div style={panelHeaderStyle}><span>Order</span></div>
        <div style={panelBodyStyle}>
          <div style={grid}>
            <Field label="Partner *">
              <div style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Combobox
                    value={partnerId}
                    options={partnerOptions}
                    onChange={pickPartner}
                    placeholder="Search partner…"
                    emptyLabel="No matching partner"
                  />
                </div>
                {onCreatePartner && (
                  <button type="button" style={{ ...btnSecondary, whiteSpace: 'nowrap', padding: '0 12px' }} onClick={() => setPartnerModal(true)} title="Create a new partner">+ Add</button>
                )}
              </div>
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
            <Field label="Destination warehouse"><input style={{ ...inputStyle, width: '100%' }} placeholder="e.g. Blinkit Bhiwandi DC (for quick-commerce)" value={meta.destination_warehouse} onChange={e => setM('destination_warehouse', e.target.value)} /></Field>
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
        <div style={{ padding: '0 16px' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', minWidth: 1040 }}>
            <colgroup>
              {[170, 110, 110, 95, 75, 58, 85, 58, 58, 95, 95, 44].map((w, i) => <col key={i} style={{ width: w }} />)}
            </colgroup>
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
                const started = l.product || Number(l.qty) > 0;
                const needModel = started && models.length && !l.model;
                const needColor = started && colors.length && !l.color;
                const cell = { ...inputStyle, width: '100%', padding: '4px 6px' };
                const numCell = { ...cell, textAlign: 'right' };
                const cbInput = { padding: '4px 6px', fontSize: 12 };
                const cbInputBad = { ...cbInput, borderColor: '#ff7070' };
                return (
                  <tr key={i}>
                    <td style={tableTdStyle}>
                      <Combobox
                        value={l.product}
                        options={productOptions}
                        onChange={v => setLine(i, 'product', v)}
                        placeholder="Search…"
                        emptyLabel="No match"
                        inputStyle={cbInput}
                        maxDropdownHeight={220}
                        portal
                      />
                    </td>
                    <td style={tableTdStyle}>
                      <Combobox
                        value={l.model || ''}
                        options={models.map(mm => ({ value: mm, label: mm }))}
                        onChange={v => setLine(i, 'model', v)}
                        placeholder={models.length ? (needModel ? 'Required' : 'Search…') : 'n/a'}
                        emptyLabel="No match"
                        inputStyle={needModel ? cbInputBad : cbInput}
                        maxDropdownHeight={220}
                        disabled={!models.length}
                        portal
                      />
                    </td>
                    <td style={tableTdStyle}>
                      <Combobox
                        value={l.color || ''}
                        options={colors.map(c => ({ value: c, label: c }))}
                        onChange={v => setLine(i, 'color', v)}
                        placeholder={colors.length ? (needColor ? 'Required' : 'Search…') : 'n/a'}
                        emptyLabel="No match"
                        inputStyle={needColor ? cbInputBad : cbInput}
                        maxDropdownHeight={220}
                        disabled={!colors.length}
                        portal
                      />
                    </td>
                    <td style={tableTdStyle}><input style={cell} value={l.sku || ''} onChange={e => setLine(i, 'sku', e.target.value)} /></td>
                    <td style={tableTdStyle}><input style={{ ...cell, fontFamily: 'var(--mono)' }} value={l.hsn_code || ''} onChange={e => setLine(i, 'hsn_code', e.target.value)} placeholder="9503" /></td>
                    <td style={tableTdStyle}><input type="number" style={numCell} value={l.qty} onChange={e => setLine(i, 'qty', e.target.value)} /></td>
                    <td style={tableTdStyle}><input type="number" style={numCell} value={l.rate} onChange={e => setLine(i, 'rate', e.target.value)} /></td>
                    <td style={tableTdStyle}><input type="number" style={numCell} value={l.discount_pct} onChange={e => setLine(i, 'discount_pct', e.target.value)} /></td>
                    <td style={tableTdStyle}><input type="number" style={numCell} value={l.gst_pct} onChange={e => setLine(i, 'gst_pct', e.target.value)} /></td>
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

      {lineErrors.length > 0 && (
        <div style={{ marginBottom: 8, fontSize: 12, color: '#ff7070' }}>
          {lineErrors.map(e => `Line ${e.i + 1} needs ${e.miss.join(' + ')}`).join('  ·  ')}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button style={btnPrimary} onClick={submit} disabled={saving || !valid}>{saving ? 'Saving…' : 'Save Order'}</button>
        <button style={btnSecondary} onClick={onCancel} disabled={saving}>Cancel</button>
      </div>

      {onCreatePartner && (
        <Modal open={partnerModal} onClose={() => { if (!creatingPartner) setPartnerModal(false); }} title="New Partner" size="lg">
          <PartnerForm
            channels={channels}
            saving={creatingPartner}
            onSubmit={handleCreatePartner}
            onCancel={() => setPartnerModal(false)}
          />
        </Modal>
      )}
    </div>
  );
}
