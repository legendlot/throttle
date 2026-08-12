'use client';
import { useEffect, useRef, useState } from 'react';
import { Combobox } from '@throttle/ui';
import { ignitionopsGet } from '../lib/ignitionopsFetch.js';

// Multi-row product picker (#4). Each row = product (Combobox over the real product list)
// → variant (free text) + quantity + goodies cost + shipping cost (⑥, S214).
//
// ⭐ NOW A COMBOBOX AGAIN (S273, Reann #2) — and the S214 objection no longer applies.
// S214 reverted an earlier Combobox because it DISCARDED non-matching typed text on blur, so a
// product outside the catalog vanished (Himani, 2026-07-15). Combobox has since gained
// **creatable mode** (`onCreateOption`), which keeps a typed product as free text instead of
// dropping it — so arbitrary products still save, and picking a real one now records the actual
// product_code, which is what makes COGS lookup possible at all.
// ⚠️ Options are per VARIANT, not per product name: sales.product_cost is keyed on product_code
// and a bare name is ambiguous (Bumble = 5 variants at different costs). Variant itself stays
// free text — the catalog carries no variant taxonomy.
//
// `value` is an array of line objects; `onChange(nextLines)` reports edits up.
// Each line: { product_code, product_variant, quantity, goodies_cost, shipping_cost }.

export function emptyLine() {
  return { product_code: '', product_ref: null, cogs_inr: null, product_variant: '', quantity: 1, goodies_cost: '', shipping_cost: '' };
}

export default function ProductLinesEditor({ value, onChange, session }) {
  const lines = value && value.length ? value : [emptyLine()];
  const [catalog, setCatalog] = useState([]);
  // Keep a fresh handle on the current lines + onChange so the async price-fill
  // (theme ②, B#9) merges into the latest state rather than a stale closure.
  const linesRef = useRef(lines); linesRef.current = lines;
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;

  useEffect(() => {
    if (!session) return;
    ignitionopsGet('getCatalogs', {}, session)
      .then(r => setCatalog(Array.isArray(r?.products) ? r.products : []))
      .catch(() => setCatalog([]));
  }, [session]);

  // One option PER VARIANT, because sales.product_cost is keyed on product_code and a product
  // name alone is ambiguous (Bumble has 5 variants at different costs). Legacy rows hold a bare
  // typed name that matches no option — creatable mode keeps them as free text rather than
  // discarding them on blur, which is exactly why S214 reverted the old Combobox attempt.
  const productOptions = (catalog || [])
    .filter(p => p.product_code)
    .map(p => {
      const label = [p.name, p.model, p.color].filter(Boolean).join(' · ');
      return { value: label, label, product_code: p.product_code };
    })
    .filter((o, i, a) => a.findIndex(x => x.value === o.value) === i);

  function setRow(i, patch) {
    const next = lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l));
    onChange(next);
  }

  // Picking from the catalogue records the REAL product reference alongside the typed name and
  // auto-fills goodies cost from COGS (Reann #2, S273 — replaces list price as the cost basis).
  //
  // ⚠️ The list-price path it replaces had NEVER actually worked: ignition.product_prices is
  // empty (its Shopify sync is gated behind the read_products scope), so getProductPrice always
  // missed and every goodies cost on record was typed by hand. Nothing is being "converted from
  // ASP" — there was no ASP. Historic rows therefore keep their manual values untouched, which
  // satisfies "retain the old method for previous months" without a backfill.
  //
  // A typed product that is not in the catalogue stays free text with no product_ref: the field
  // is deliberately free-text (S214) and must not discard what someone typed.
  // `opt` is the picked option (carrying the real product_code) or null for a typed-in product.
  async function onProductPicked(i, label, opt) {
    const code = opt?.product_code || null;
    setRow(i, { product_code: label, product_ref: code, cogs_inr: null });
    if (!code || !session) return;
    try {
      const r = await ignitionopsGet('getProductCogs', { product_code: code }, session);
      const cogs = r?.cogs_inr;
      if (cogs == null) return;   // uncosted variant — leave the field manual rather than write 0
      onChangeRef.current(linesRef.current.map((l, idx) => (idx === i ? { ...l, goodies_cost: cogs, cogs_inr: cogs } : l)));
    } catch { /* leave goodies as manual */ }
  }

  function addRow() { onChange([...lines, emptyLine()]); }
  function removeRow(i) {
    const next = lines.filter((_, idx) => idx !== i);
    onChange(next.length ? next : [emptyLine()]);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {lines.map((l, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '1.5fr 1.1fr 60px 1fr 1fr auto', gap: 8, alignItems: 'end' }}>
          <div>
            {i === 0 && <div style={lbl}>Product</div>}
            <Combobox
              value={l.product_code || ''}
              options={productOptions}
              onChange={(val, opt) => onProductPicked(i, val, opt)}
              onCreateOption={(typed) => onProductPicked(i, typed, null)}
              createLabel="Use"
              placeholder="Search a product…"
              portal
              style={inp}
            />
          </div>
          <div>
            {i === 0 && <div style={lbl}>Variant / colour</div>}
            <input
              value={l.product_variant || ''}
              onChange={e => setRow(i, { product_variant: e.target.value })}
              placeholder="e.g. Burnout Yellow"
              style={inp}
            />
          </div>
          <div>
            {i === 0 && <div style={lbl}>Qty</div>}
            <input type="number" min="1" value={l.quantity}
              onChange={e => setRow(i, { quantity: e.target.value })} style={inp} />
          </div>
          <div>
            {i === 0 && <div style={lbl}>Goodies ₹</div>}
            <input type="number" min="0" value={l.goodies_cost ?? ''}
              onChange={e => setRow(i, { goodies_cost: e.target.value })} placeholder="0" style={inp} />
          </div>
          <div>
            {i === 0 && <div style={lbl}>Shipping ₹</div>}
            <input type="number" min="0" value={l.shipping_cost ?? ''}
              onChange={e => setRow(i, { shipping_cost: e.target.value })} placeholder="0" style={inp} />
          </div>
          <button type="button" onClick={() => removeRow(i)} title="Remove" style={removeBtn}>×</button>
        </div>
      ))}
      <div>
        <button type="button" onClick={addRow} style={addBtn}>+ Add product</button>
      </div>
    </div>
  );
}

// Normalise editor rows into the worker `products[]` payload (drops blank rows,
// coerces numerics). Returns [] when nothing meaningful is filled in.
export function linesToPayload(lines) {
  return (lines || [])
    .filter(l => (l.product_code || '').trim())
    .map((l, idx) => ({
      product_code: l.product_code.trim(),
      product_ref: l.product_ref || null,
      cogs_inr: l.cogs_inr === '' || l.cogs_inr == null ? null : Number(l.cogs_inr),
      product_variant: (l.product_variant || '').trim() || null,
      quantity: Number(l.quantity) || 1,
      goodies_cost: l.goodies_cost === '' || l.goodies_cost == null ? null : Number(l.goodies_cost),
      shipping_cost: l.shipping_cost === '' || l.shipping_cost == null ? null : Number(l.shipping_cost),
      sort_order: idx,
    }));
}

const lbl = { fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 };
const inp = { width: '100%', boxSizing: 'border-box', background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', fontFamily: 'var(--font-mono)', fontSize: 13 };
const removeBtn = { padding: '6px 10px', background: 'transparent', color: 'var(--text-3)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 16, lineHeight: 1, cursor: 'pointer' };
const addBtn = { padding: '6px 12px', background: 'var(--surface-2)', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer' };
