// Flipkart PO xlsx — Minutes (hyperlocal, e.g. FLSHM4VFE4XN Anekal, intra-state) and National
// (e.g. FLSJD88U0HRZ Bhiwandi WE-II, inter-state) share one sheet layout. Input: the sheet as
// rows of cell values (row-major, 0-based columns, merged cells only in their top-left) — what
// extract.js builds from exceljs. Pure.
//
// Fields are found by their LABEL cell, value = the next non-blank cell to the right, and the
// item columns by their HEADER text across the two header rows ("S. no." … / "Title", "Ean",
// "Supplier Unit Price" …) — so a column shifting left or right does not break the read.
// ⚠️ "Supplier Unit Price" is GST-INCLUSIVE (1469.00 × 60 = the 88,140.00 line total). The SO
// rate is ex-GST, so unit cost = Taxable Value ÷ Quantity.
import { num, isoDate, pincodeOf, GSTIN_RE, round2 } from './common.js';

const txt = v => (v == null ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v)).trim();
const norm = v => txt(v).toLowerCase().replace(/\s+/g, ' ');

function labelValue(rows, re) {
  for (const r of rows) {
    for (let c = 0; c < (r || []).length; c++) {
      if (!re.test(norm(r[c]))) continue;
      for (let k = c + 1; k < r.length; k++) if (txt(r[k])) return r[k];
      return null;
    }
  }
  return null;
}

export function parseFlipkart(rows) {
  const warnings = [];
  const all = rows.map(r => (r || []));
  let po_no = null;
  for (const r of all) for (const v of r) {
    const m = txt(v).match(/PURCHASE ORDER NO\s*[-:]\s*([A-Z0-9]+)/i);
    if (m && !po_no) po_no = m[1].toUpperCase();
  }
  const gstinOf = v => (txt(v).toUpperCase().match(GSTIN_RE) || [null])[0];

  // Header rows: the one with "Product ID" and the one after it (sub-headers under "Product Details").
  const h1 = all.findIndex(r => r.some(v => norm(v) === 'product id'));
  const col = {};
  if (h1 >= 0) for (const hr of [all[h1], all[h1 + 1] || []]) hr.forEach((v, c) => { const k = norm(v); if (k && col[k] == null) col[k] = c; });
  const need = ['product id', 'quantity', 'taxable value'];
  const missing = need.filter(k => col[k] == null);
  if (h1 < 0 || missing.length) {
    return { channel_key: 'FLIPKART_MGD', layout: 'flipkart_xlsx', error: `Could not find the item table (missing ${missing.join(', ') || 'header'}).`, lines: [], warnings };
  }
  const at = (r, k) => (col[k] == null ? null : r[col[k]]);

  const lines = [];
  let po_total_taxable = null, po_grand_total = null;
  for (let i = h1 + 2; i < all.length; i++) {
    const r = all[i];
    if (r.some(v => /^total quantity\s*=?$/.test(norm(v))) || r.some(v => /^total\s*=$/.test(norm(v)))) {
      po_total_taxable = num(at(r, 'taxable value'));
      po_grand_total = num(at(r, 'total amount'));
      break;
    }
    const fsn = txt(at(r, 'product id'));
    if (!fsn) continue;
    const qty = num(at(r, 'quantity'));
    const pending = num(at(r, 'pending quantity'));
    const taxable = num(at(r, 'taxable value'));
    const gst = ['igst rate', 'sgst/utgst rate', 'cgst rate'].reduce((s, k) => s + (num(at(r, k)) || 0), 0);
    const ean = txt(at(r, 'ean')).replace(/\D/g, '') || null;
    // ⚠️ unit = Taxable ÷ Qty, so Σ qty × unit = the PO's taxable total BY CONSTRUCTION — the
    // preview's checksum proves nothing on this layout. The independent check is the printed
    // GST-inclusive Supplier Unit Price: unit (to paise) × (1 + GST%) must land within ₹1 of it.
    const unit = qty && taxable != null ? taxable / qty : null;
    const unitIncl = num(at(r, 'supplier unit price'));
    const n = lines.length + 1;
    if (unit != null && unitIncl != null && Math.abs(round2(unit) * (1 + gst / 100) - unitIncl) > 1) {
      warnings.push(`Line ${n} (${fsn}): ₹${round2(unit)} + ${gst}% GST ≠ the PO's Supplier Unit Price ₹${unitIncl} — check the rate.`);
    }
    // Pending Quantity < Quantity = part of this PO was already supplied (FLSJD88U0HRZ line 1: 0 of 18 pending).
    if (qty != null && pending != null && pending < qty) {
      warnings.push(`Line ${n} (${fsn}): ${qty - pending} of ${qty} already supplied on this PO — ${pending} still pending.`);
    }
    lines.push({
      channel_code: fsn.toUpperCase(), ean,
      title: txt(at(r, 'title')) || null,
      hsn: txt(at(r, 'hsn/sac code')) || null,
      qty, pending_qty: pending, mrp: num(at(r, 'supplier mrp')),
      unit_cost_ex_gst: unit,
      gst_pct: Math.round(gst * 100) / 100, taxable,
      required_by: isoDate(at(r, 'required by date')),
    });
  }
  if (po_total_taxable == null) warnings.push('No "Total=" row found — the PO total could not be read.');
  const ship_to_address = txt(labelValue(all, /^shipped to address$/)) || null;
  const req = [...new Set(lines.map(l => l.required_by).filter(Boolean))].sort();
  return {
    channel_key: 'FLIPKART_MGD', layout: 'flipkart_xlsx',
    po_no,
    po_date: isoDate(labelValue(all, /^order date$/)),
    // No delivery date on this layout beyond the per-line "Required by Date" (blank on both
    // samples) — take the earliest when present, else leave it for the user.
    delivery_date: req[0] || null,
    expiry_date: isoDate(labelValue(all, /^expiry date$/)),
    bill_to_gstin: gstinOf(labelValue(all, /^bi+l+ to gstin$/)),   // sic — the sheet says "Biil To GSTIN"
    ship_to_gstin: gstinOf(labelValue(all, /^ship to gstin$/)),
    ship_to_address, ship_to_city: null, ship_to_pincode: pincodeOf(ship_to_address),
    lines, po_total_taxable, po_grand_total, warnings,
  };
}
