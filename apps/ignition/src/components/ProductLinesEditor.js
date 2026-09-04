'use client';
import { useEffect, useRef, useState } from 'react';
import { Combobox } from '@throttle/ui';
import { ignitionopsGet } from '../lib/ignitionopsFetch.js';

// Multi-row product picker (#4). Each row = product (Combobox over the real product list)
// → variant (free text) + quantity + goodies cost + shipping cost (⑥, S214).
//
// ⭐ THE PRODUCT FIELD IS NO LONGER FREE TEXT (Afshaan, 2026-09-04). Creatable mode
// (`onCreateOption`) is removed: a line must resolve to a real catalogue product, and if the
// product does not exist yet it gets CREATED FIRST — its EAN has to exist before anything ships
// to an influencer anyway. This is the standing rule (S179 / PATTERN-160: every product picker is
// a searchable Combobox, never free text).
//
// ⚠️ Two things that removal must NOT do, both traced bugs:
//   · `freeTextValue` STAYS. 341 deals hold legacy free-text lines; Combobox renders the box from
//     `value` only under this flag, so dropping it would blank every legacy row on screen.
//   · Dropping `onCreateOption` alone is SILENTLY LOSSY — Combobox only preserves typed text on
//     blur under `freeTextValue && onCreateOption`, so unmatched text would sit in the box and
//     never reach the parent (the S214 data-loss bug that got the first Combobox reverted). So the
//     block is EXPLICIT: unmatched text on blur raises a visible inline error on that row and
//     makes the editor invalid, instead of quietly evaporating.
//   · Legacy rows STAY SAVEABLE. ~250 live/shipped/delivered deals carry a free-text line; blocking
//     save on them would freeze view/metric updates on active deals. A row that ARRIVED with
//     product_code and no product_ref is stamped legacy and stays saveable until it is edited.
// ⚠️ Options are per VARIANT, not per product name: sales.product_cost is keyed on product_code
// and a bare name is ambiguous (Bumble = 5 variants at different costs). Variant itself stays
// free text — the catalog carries no variant taxonomy.
//
// `value` is an array of line objects; `onChange(nextLines)` reports edits up.
// Each line: { product_code, product_variant, quantity, goodies_cost, shipping_cost }.

export function emptyLine() {
  return { product_code: '', product_ref: null, cogs_inr: null, product_variant: '', quantity: 1, goodies_cost: '', shipping_cost: '' };
}

export default function ProductLinesEditor({ value, onChange, session, onValidityChange }) {
  // The blank fallback row is held in a ref so it keeps ONE identity across renders — a fresh
  // emptyLine() each render would hand out a new __uid every time.
  const blankRef = useRef(emptyLine());
  const lines = value && value.length ? value : [blankRef.current];
  const [catalog, setCatalog] = useState([]);
  // Per-row rejected text: __uid -> what the user typed that resolved to no product.
  const [rowErrors, setRowErrors] = useState({});
  // __uids whose next blur is the tail of a commit the Combobox itself made (selectOption always
  // calls input.blur() right after onChange), so that blur must not be read as unmatched text.
  const pickedRef = useRef(new Set());
  const uidSeq = useRef(0);
  // Keep a fresh handle on the current lines + onChange so the async price-fill
  // (theme ②, B#9) merges into the latest state rather than a stale closure.
  const linesRef = useRef(lines); linesRef.current = lines;
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;

  // Stable per-row identity, stamped ONCE per row object and carried by every `{...l, ...patch}`.
  // NOT the array index: rows are added and removed, and an index-keyed error follows the wrong
  // row after a delete. `__legacyFreeText` is decided at the same moment — on FIRST SIGHT of the
  // row — which is the only point at which "arrived that way" is still distinguishable from
  // "someone typed it just now". Neither marker is persisted: linesToPayload builds its fields
  // explicitly, so they never reach the worker.
  for (const l of lines) {
    if (!l.__uid) {
      l.__uid = `pl${++uidSeq.current}`;
      l.__legacyFreeText = !!(l.product_code || '').trim() && !l.product_ref;
    }
  }

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
  // typed name that matches no option; they still DISPLAY (freeTextValue) and stay saveable, but
  // nothing new may be entered that way.
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
  // `opt` is the picked option (carrying the real product_code); it is null only for a CLEAR
  // (the × / Backspace path) now that creatable mode is gone — typed text no longer arrives here
  // at all, it is refused on blur by onProductBlur.
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
    // Touching the product field ends this row's legacy grace: from here it must resolve.
    // ⚠️ `pickedRef` means "the Combobox committed a REAL PICK and blurred itself", and only a
    // real pick may suppress the blur error. Adding the uid unconditionally silently DROPPED the
    // line: Combobox.handleChange fires onChange('', null) on the first keystroke over a row whose
    // text exactly matches an option label (true for every bare legacy name that matches a remote's
    // label — Shadow, Ghost, Flare, Dash, Mac, Knox, Nitro, Rift, Rumble, Fang, Roxie, whose XXR
    // rows have null model/color so label === name). That cleared product_code to '', the wrapper's
    // capture-phase delete ran BEFORE handleChange re-added the uid, so blur saw it in pickedRef,
    // raised no error, left `valid` true — and linesToPayload filtered the now-blank row out. One
    // keystroke, no warning, line gone. Two keystrokes were safe, which is why it survived review.
    if (prev.__uid) { if (opt) pickedRef.current.add(prev.__uid); clearRowError(prev.__uid); }
    setRow(i, {
      product_code: name, product_ref: code, cogs_inr: null, list_price_inr: null,
      __legacyFreeText: false,
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
      if (cogs != null) {
        // cogs_inr is a pick-time SNAPSHOT of the cost basis and always tracks the pick.
        // goodies_cost is the USER'S number and must survive one. The wasAutoFilled test
        // above already protects the clear path; without the same guard here the write
        // path undid it a moment later, once the fetch resolved — re-picking a product
        // silently replaced a hand-typed figure with COGS (11 live/delivered deals lost
        // ₹441–550 → ₹65–80 on 2026-09-04, ~85% down, straight into total_cost → CPM → ROAS).
        // Test the CURRENT row, not `prev`: if wasAutoFilled the setRow above already
        // blanked it, and if the user typed while the fetch was in flight that typing wins.
        const gc = l.goodies_cost;
        if (gc === '' || gc == null) next.goodies_cost = cogs;
        next.cogs_inr = cogs;
      }
      return next;
    }));
  }

  function clearRowError(uid) {
    setRowErrors(prev => {
      if (!(uid in prev)) return prev;
      const next = { ...prev };
      delete next[uid];
      return next;
    });
  }

  // Leaving the product field with text that resolved to nothing is the case the removed
  // `onCreateOption` used to swallow. It is raised HERE, synchronously on blur (onBlurCapture on
  // the wrapper, not the Combobox's own 150 ms deferred blur) so the editor is already invalid by
  // the time a mousedown on a Save button turns into a click.
  function onProductBlur(uid, typed) {
    // The Combobox just committed a pick/clear and blurred the input itself — not a stray edit.
    if (pickedRef.current.has(uid)) { pickedRef.current.delete(uid); clearRowError(uid); return; }
    const t = (typed || '').trim();
    const row = linesRef.current.find(l => l.__uid === uid) || {};
    const committed = (row.product_code || '').trim();
    if (!t) { clearRowError(uid); return; }
    // Focused and left without changing anything: a resolved row, or a legacy row that is
    // allowed to stay as it is.
    if (t === committed && (row.product_ref || row.__legacyFreeText)) { clearRowError(uid); return; }
    // An exact label match is resolved by Combobox's own blur handler a tick later — flagging it
    // here would show an error that clears itself.
    if (productOptions.some(o => (o.label || '').trim().toLowerCase() === t.toLowerCase())) {
      clearRowError(uid); return;
    }
    setRowErrors(prev => ({ ...prev, [uid]: t }));
  }

  // A row is unresolved when it carries product text with no product_ref and was not stamped
  // legacy on arrival. `linesAreValid` below applies the same rule for the save handlers.
  function rowNeedsRef(l) {
    return !!(l.product_code || '').trim() && !l.product_ref && !l.__legacyFreeText;
  }
  const valid = !lines.some(l => rowErrors[l.__uid] || rowNeedsRef(l));
  const onValidityChangeRef = useRef(onValidityChange); onValidityChangeRef.current = onValidityChange;
  const lastValidRef = useRef(null);
  useEffect(() => {
    if (lastValidRef.current === valid) return;
    lastValidRef.current = valid;
    onValidityChangeRef.current?.(valid);
  }, [valid]);

  function addRow() { onChange([...lines, emptyLine()]); }
  function removeRow(i) {
    const next = lines.filter((_, idx) => idx !== i);
    onChange(next.length ? next : [emptyLine()]);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {lines.map((l, i) => {
        const uid = l.__uid;
        const rejected = rowErrors[uid];
        // Two shapes of the same failure: text the user typed that never resolved (rejected),
        // and a row already holding an unresolved name it is not entitled to keep (rowNeedsRef).
        const problem = rejected
          ? `“${rejected}” isn’t in the product catalogue.`
          : (rowNeedsRef(l) ? `“${l.product_code}” isn’t linked to a catalogue product.` : null);
        return (
        <div key={uid} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1.1fr 60px 1fr 1fr auto', gap: 8, alignItems: 'end' }}>
          <div
            // Captured on the wrapper because the Combobox's own blur is deferred 150 ms, which
            // loses the race against a click on Save. Focus clears the row's error so a mistyped
            // entry is recoverable: focus again, leave it as it was, and the flag goes.
            onFocusCapture={() => clearRowError(uid)}
            onBlurCapture={e => onProductBlur(uid, e.target && e.target.value)}
            // Any keystroke means the pending Combobox commit (if any) is no longer what is in
            // the box, so the next blur must be judged on its text.
            onChangeCapture={() => pickedRef.current.delete(uid)}
          >
            {i === 0 && <div style={lbl}>Product</div>}
            <Combobox
              value={l.product_code || ''}
              options={productOptions}
              onChange={(val, opt) => onProductPicked(i, val, opt)}
              placeholder="Search a product…"
              // Legacy rows (341 deals) hold a name that matches no option. Without this the
              // Combobox renders them EMPTY, which reads as the line having been destroyed.
              // Creatable mode is deliberately absent — see the header note.
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
        {problem && (
          <div style={errText}>
            {problem} Pick a product from the list — if it doesn’t exist yet, create the
            product first.
          </div>
        )}
        </div>
        );
      })}
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

// The save-side twin of the inline check: every line carrying product text must resolve to a
// real product_ref, EXCEPT a row the editor stamped legacy on arrival (it came from the DB that
// way and stays saveable — ~250 live/shipped/delivered deals depend on that). Call sites use it
// as the hard guard next to the onValidityChange state that disables their button; the state is
// the wider of the two (it also knows about typed text that never got committed).
export function linesAreValid(lines) {
  return !(lines || []).some(l => (l.product_code || '').trim() && !l.product_ref && !l.__legacyFreeText);
}

const errText = { fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.4, color: 'var(--state-error-fg)' };
const hint = { display: 'flex', alignItems: 'center', gap: 6, marginTop: 3, fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-3)' };
const hintBtn = { background: 'transparent', border: 'none', padding: 0, color: 'var(--state-info-fg, #6aa9ff)', fontFamily: 'var(--font-mono)', fontSize: 10.5, textDecoration: 'underline', cursor: 'pointer' };
const lbl = { fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 };
const inp = { width: '100%', boxSizing: 'border-box', background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', fontFamily: 'var(--font-mono)', fontSize: 13 };
const removeBtn = { padding: '6px 10px', background: 'transparent', color: 'var(--text-3)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 16, lineHeight: 1, cursor: 'pointer' };
const addBtn = { padding: '6px 12px', background: 'var(--surface-2)', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer' };
