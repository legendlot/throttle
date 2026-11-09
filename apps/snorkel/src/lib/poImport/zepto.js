// Zepto PO PDF (sample P6150806, Qt 4 export). Input: text lines from itemsToLines(); pure.
//
// Item row:  Sr · Material Code · <desc fragment> · HSN · EAN · Qty · MRP · Unit Base Cost ·
//            Taxable · CGST% · amt · SGST% · amt · IGST% · amt · CESS% · amt · Addl Cess · Total
// The SKU Code (a UUID — what sales.sku_map keys Zepto on) WRAPS over 2–3 lines around the row
// ("05285852-99e0-4b15-" above, "8ce1-d8dc026e4bf4" below), so it is reassembled from the
// hex fragments of the whole table and dealt out in order — only when the count matches the row
// count; otherwise every line falls back to its EAN rather than risk pairing a code to the
// wrong row.
import { num, isoDate, grab, round2, assignTitles, composeTitle } from './common.js';
import { shipBlock, isMoney } from './pdfCommon.js';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const TRAIL = 14;   // qty … total

function itemRow(line) {
  const t = line.trim().split(/\s+/);
  if (t.length < TRAIL + 3 || !/^\d{1,3}$/.test(t[0]) || !/^\d{5,}$/.test(t[1])) return null;
  const tail = t.slice(-TRAIL);
  if (!tail.every(isMoney)) return null;
  const pct = [4, 6, 8, 10].map(k => tail[k]);           // CGST/SGST/IGST/CESS rate cells
  if (!pct.every(p => p.endsWith('%'))) return null;
  const mid = t.slice(2, -TRAIL);
  const ean = mid.length && /^\d{12,14}$/.test(mid[mid.length - 1]) ? mid.pop() : null;
  const hsn = mid.length && /^\d{4,8}$/.test(mid[mid.length - 1]) ? mid.pop() : null;
  return {
    material_code: t[1], ean, hsn, desc: mid.join(' '),
    qty: num(tail[0]), mrp: num(tail[1]), unit_cost_ex_gst: num(tail[2]), taxable: num(tail[3]),
    gst_pct: round2(num(tail[4]) + num(tail[6]) + num(tail[8])),
  };
}

const isHexFrag = tok => tok.length >= 4 && /^[0-9a-f-]+$/i.test(tok) && (tok.includes('-') || tok.length >= 8);

export function parseZepto(lines) {
  const warnings = [];
  const header = lines.findIndex(l => /\bSr\./.test(l) && /Material Code/i.test(l));
  const totalAt = lines.findIndex((l, i) => i > header && /Total Taxable Amount/i.test(l));
  const rowIdx = [], rows = [];
  lines.forEach((l, i) => { const r = itemRow(l); if (r) { rowIdx.push(i); rows.push(r); } });

  // UUID reassembly over the item table only (header → totals).
  const from = header >= 0 ? header + 1 : 0, to = totalAt >= 0 ? totalAt : lines.length;
  let hex = '';
  for (let i = from; i < to; i++) {
    if (rowIdx.includes(i)) continue;
    for (const tok of lines[i].trim().split(/\s+/)) if (isHexFrag(tok)) hex += tok;
  }
  const uuids = (hex.match(UUID_RE) || []).map(u => u.toLowerCase());
  if (rows.length && uuids.length !== rows.length) {
    warnings.push(`Found ${uuids.length} Zepto SKU codes for ${rows.length} lines — matching on EAN instead.`);
  }
  const titles = assignTitles(lines, rowIdx, from, to,
    l => l.trim().split(/\s+/).every(isHexFrag) || /\bRate\s+AMT\b/i.test(l));   // UUID fragments, the 3rd header line

  const block = shipBlock(lines);
  return {
    channel_key: 'ZEPTO', layout: 'zepto_pdf',
    po_no: grab(lines, /\bPO No:\s*([A-Z0-9][A-Z0-9/-]*)/i),
    po_date: isoDate(grab(lines, /\bPO Date:\s*(\d{4}-\d{2}-\d{2})/)),
    delivery_date: isoDate(grab(lines, /Expected Delivery Date:\s*(\d{4}-\d{2}-\d{2})/)),
    expiry_date: isoDate(grab(lines, /PO Expiry Date:\s*(\d{4}-\d{2}-\d{2})/)),
    bill_to_gstin: block.bill_to_gstin, ship_to_gstin: block.ship_to_gstin,
    ship_to_address: block.address, ship_to_city: null, ship_to_pincode: block.pincode,
    lines: rows.map((r, k) => ({
      channel_code: uuids.length === rows.length ? uuids[k] : null,
      alt_code: r.material_code,   // Zepto's Material Code — shown, never matched on
      ean: r.ean,
      title: composeTitle(titles[k], rowIdx[k], r.desc),
      hsn: r.hsn, qty: r.qty, unit_cost_ex_gst: r.unit_cost_ex_gst, mrp: r.mrp, gst_pct: r.gst_pct, taxable: r.taxable,
    })),
    po_total_taxable: num(grab(lines, /Total Taxable Amount \(INR\)\s+([\d,]+(?:\.\d+)?)/i)),
    po_grand_total: num(grab(lines, /Grand Total Amount \(INR\)\s+([\d,]+(?:\.\d+)?)/i)),
    warnings,
  };
}
