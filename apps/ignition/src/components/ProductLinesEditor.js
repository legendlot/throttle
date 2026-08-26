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

  // Resolve the list-price hint for rows that ALREADY have a product reference. `list_price_inr`
  // is display-only and deliberately not persisted, so before this it appeared on PICK and then
  // vanished the moment the deal was reopened — fine for entry, wrong for review, which is when
  // someone is actually checking whether a goodies figure looks right.
  // Keyed on the refs present, so it re-runs when a row gains one; rows without a ref are skipped.
  const refsKey = lines.map(l => l.product_ref || '').join(',');
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    const wanted = [...new Set(lines.filter(l => l.product_ref && l.list_price_inr == null).map(l => l.product_ref))];
    if (!wanted.length) return;
    Promise.all(wanted.map(code =>
      ignitionopsGet('getProductPrice', { sku: '', product_code: code }, session)
        .then(r => [code, r?.price?.price])
        .catch(() => [code, null])
    )).then(pairs => {
      if (cancelled) return;
      const priced = new Map(pairs.filter(([, p]) => p != null && Number(p) > 0).map(([c, p]) => [c, Number(p)]));
      if (!priced.size) return;
      onChangeRef.current(linesRef.current.map(l => (
        l.product_ref && priced.has(l.product_ref) && l.list_price_inr == null
          ? { ...l, list_price_inr: priced.get(l.product_ref) }
          : l
      )));
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, refsKey]);

  // One option PER VARIANT, because sales.product_cost is keyed on product_code and a product
  // name alone is ambiguous (Bumble has 5 variants at different costs). Legacy rows hold a bare
  // typed name that matches no option — creatable mode keeps them as free text rather than
  // discarding them on blur, which is exactly why S214 reverted the old Combobox attempt.
  const productOptions = (catalog || [])
    .filter(p => p.product_code)
    .map(p => {
      const label = [p.name, p.model, p.color].filter(Boolean).join(' · ');
      // sku rides along for the list-price lookup (S309) — product_prices is
      // sku-keyed, while COGS is product_code-keyed. getCatalogs returns both.
      // name/model/color ride along so a pick can SPLIT into the two fields
      // (product name → Product, model+colour → Variant) — see onProductPicked.
      return {
        value: label, label, product_code: p.product_code, sku: p.sku || null,
        name: p.name || '', model: p.model || '', color: p.color || '',
      };
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
    const sku = opt?.sku || null;
    // A catalog pick SPLITS into the two fields: product name into Product,
    // model + colour into Variant / colour. Stuffing the whole "Shadow · Tarmac ·
    // Black" label into the (narrow) product box left the Variant field empty and
    // read as "the variant isn't displayed" (Himani, #bugs 2026-08-26) — users then
    // re-typed a short name over the pick, which is how product_ref kept getting
    // wiped. Free-typed text (opt null) keeps the old behaviour: the text is the
    // product name and the Variant field is left alone.
    const name = opt ? (opt.name || label) : label;
    const variant = opt ? [opt.model, opt.color].filter(Boolean).join(' ') : null;
    // Switching product must not carry the PREVIOUS product's COGS into the new row.
    // Where the new product is uncosted nothing overwrites the field, so the old
    // number just sits there looking like this product's cost — which is what "the
    // COGS aren't updating" on a crest actually was (crests have no cost row, and the
    // field still showed the Shadow figure). Only a value we auto-filled ourselves is
    // cleared; a hand-typed one (≠ the recorded cogs_inr) is never touched.
    const prev = lines[i] || {};
    const wasAutoFilled = prev.cogs_inr != null && Number(prev.goodies_cost) === Number(prev.cogs_inr);
    setRow(i, {
      product_code: name, product_ref: code, cogs_inr: null, list_price_inr: null,
      ...(wasAutoFilled ? { goodies_cost: '' } : {}),
      ...(opt && variant ? { product_variant: variant } : {}),
    });
    if (!session || (!code && !sku)) return;
    // COGS and list price are fetched together but do NOT play the same role.
    //
    // ⚠️ COGS is the cost basis and the ONLY thing that auto-fills goodies_cost
    // (S273, Reann #2). List price is shown as REFERENCE and never written
    // automatically. They are different numbers by the whole gross margin — a
    // silent fallback to list price on an uncosted variant would leave one column
    // holding some rows at cost and some at retail, which is how a spend metric
    // quietly stops meaning anything. Where COGS is unknown the user is offered
    // the list price explicitly and chooses.
    const [cogsRes, priceRes] = await Promise.all([
      code ? ignitionopsGet('getProductCogs', { product_code: code }, session).catch(() => null) : null,
      // product_code rides along so the worker can fall back through Odo's sku_map when
      // product_master.sku is stale vs the live Shopify sku (the HP crest case).
      (sku || code) ? ignitionopsGet('getProductPrice', { sku: sku || '', product_code: code || '' }, session).catch(() => null) : null,
    ]);
    const cogs = cogsRes?.cogs_inr;
    // A ₹0 list price is a real answer for creatorshipment-*/prize SKUs, but it is
    // not a useful reference, so treat it as unknown rather than showing "List ₹0".
    const listRaw = priceRes?.price?.price;
    const list = (listRaw == null || Number(listRaw) <= 0) ? null : Number(listRaw);
    onChangeRef.current(linesRef.current.map((l, idx) => {
      if (idx !== i) return l;
      // Stale-merge guard: only apply if the row still holds THIS pick. Without it,
      // clearing or re-typing the product while the fetch was in flight produced a
      // free-text row wearing the previous pick's COGS (the "SHA" row, ref null but
      // cogs_inr 523.15 — IGN-2026-00530, 2026-08-26).
      if (l.product_ref !== code) return l;
      const next = { ...l, list_price_inr: list };
      // uncosted variant — leave the field manual rather than write 0
      if (cogs != null) { next.goodies_cost = cogs; next.cogs_inr = cogs; }
      return next;
    }));
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
              createLabel={(q) => <>Use “{q}”</>}
              placeholder="Search a product…"
              // This field's value IS the typed text (S214 free text), so a product that
              // isn't in the catalogue must display and must survive tabbing to Variant.
              // Without it the name vanished on the way to the next field.
              freeTextValue
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
            {/* Reference only (S309). Shows what the product retails for so nobody has
                to go and look it up, which is what Reann was doing by hand. "Use" is a
                deliberate click, never automatic — see onProductPicked for why. */}
            {l.list_price_inr != null && (
              <div style={hint}>
                List ₹{Number(l.list_price_inr).toLocaleString('en-IN')}
                {Number(l.goodies_cost) !== Number(l.list_price_inr) && (
                  <button type="button" style={hintBtn}
                    onClick={() => setRow(i, { goodies_cost: l.list_price_inr })}>use</button>
                )}
              </div>
            )}
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

const hint = { display: 'flex', alignItems: 'center', gap: 6, marginTop: 3, fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-3)' };
const hintBtn = { background: 'transparent', border: 'none', padding: 0, color: 'var(--state-info-fg, #6aa9ff)', fontFamily: 'var(--font-mono)', fontSize: 10.5, textDecoration: 'underline', cursor: 'pointer' };
const lbl = { fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 };
const inp = { width: '100%', boxSizing: 'border-box', background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', fontFamily: 'var(--font-mono)', fontSize: 13 };
const removeBtn = { padding: '6px 10px', background: 'transparent', color: 'var(--text-3)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 16, lineHeight: 1, cursor: 'pointer' };
const addBtn = { padding: '6px 12px', background: 'var(--surface-2)', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer' };
