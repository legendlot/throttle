// Import PO → OrderForm glue. Pure, so snorkelops-worker/test/po-import-parsers.test.mjs covers it.
// Used by sales/orders/import/page.js (initialFromPreview) and sales/orders/OrderForm.js (the line rules).

export const IMPORT_CHANNEL_LABEL = { ZEPTO: 'Zepto', INSTAMART: 'Swiggy Instamart', FLIPKART_MGD: 'Flipkart' };

// previewSalesOrderImport result (+ the chosen partner) → OrderForm `initial`.
// When the PO is ALREADY on an SO (duplicate_of), a line's quantity defaults to what the PO
// still has PENDING (Flipkart prints it) — the usual reason to import a PO twice is the balance.
// Lines with nothing pending are left off and returned in `skippedPending` so the page lists them.
export function initialFromPreview(pv, partner, today) {
  const label = IMPORT_CHANNEL_LABEL[pv.channel_key] || pv.channel_key;
  const usePending = (pv.duplicate_of || []).length > 0;
  const skippedPending = [];
  const lines = [];
  for (const l of pv.lines || []) {
    let qty = l.qty;
    if (usePending && l.pending_qty != null) {
      if (l.pending_qty <= 0) { skippedPending.push(l); continue; }
      qty = l.pending_qty;
    }
    lines.push({
      product: l.product || '', model: l.model || '', color: l.color || '', sku: l.sku || '',
      hsn_code: l.hsn_code || '', description: '', qty,
      rate: l.rate == null ? '' : l.rate,            // unknown price stays blank, never ₹0
      discount_pct: 0, gst_pct: l.gst_pct ?? 18,
      _import: {
        channel_code: l.channel_code, ean: l.ean, title: l.title, matched: l.matched, matched_by: l.matched_by,
        // Learn only a code that has NO sku_map row yet — a pick on a code/barcode conflict is not
        // written over the existing mapping (it would be a no-op insert anyway).
        learn: !l.matched && !l.code_mapped, note: l.note,
        po_qty: l.qty, pending_qty: l.pending_qty ?? null,
      },
    });
  }
  return {
    usedPending: usePending && (pv.lines || []).some(l => l.pending_qty != null),
    skippedPending,
    initial: {
      partner_id: partner?.id || '',
      channel_key: partner?.channel_key || pv.channel_key,
      credit_days: partner?.default_credit_days ?? 45,
      order_date: pv.po.po_date || today,
      partner_po_ref: pv.po.po_no || '',
      expected_dispatch_date: pv.po.delivery_date || '',
      notes: `Imported from ${label} PO ${pv.po.po_no || '(no number read)'}${pv.po.expiry_date ? ` · PO expires ${pv.po.expiry_date}` : ''}`,
      lines,
    },
  };
}

// OrderForm.setLine hook: on an imported line the pre-filled SKU belongs to the MATCHED variant,
// so changing product/model/colour clears it rather than ship a stale identifier to Odo.
export function afterImportLineEdit(next, key) {
  if (next._import && (key === 'product' || key === 'model' || key === 'color')) return { ...next, sku: '' };
  return next;
}

// What an imported line still needs before Save (plain words, OrderForm's "Line N needs …").
// An imported line always counts as started — a zero-qty or zero-rate PO line must be fixed or
// removed, never silently dropped or saved at ₹0.
export function importLineProblems(l) {
  if (!l?._import) return [];
  const out = [];
  if (!(Number(l.qty) > 0)) out.push('a quantity above 0');
  if (l.rate === '' || l.rate == null || !(Number(l.rate) > 0)) out.push('a rate above ₹0 (the PO price could not be read — type it or remove the line)');
  return out;
}
