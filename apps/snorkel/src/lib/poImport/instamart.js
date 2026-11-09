// Swiggy Instamart PO PDF — billed as SCOOTSY LOGISTICS PRIVATE LIMITED, one GSTIN per state and
// several fulfilment centres per GSTIN (samples CMFPO…476 Mumbai FC22, KOCPO…078 Kochi IM1; Qt 5,
// same layout). Input: text lines from itemsToLines(); pure.
//
// Item row:  S.No · Item Code · HSN · Qty · MRP · Unit Base Cost · Taxable ·
//            CGST rate · amt · SGST/UGST rate · amt · IGST rate · amt · CESS rate · amt · Addl CESS · Total
// The description wraps over 3–8 lines ABOVE and BELOW the row and never shares its baseline.
// The Item Code (140019, 646970) is what sales.sku_map keys Instamart on; there is no EAN.
// Unit Base Cost carries 5 decimals (1135.09932) — kept as printed; the SO rounds to paise.
import { num, isoDate, grab, round2, assignTitles, composeTitle } from './common.js';
import { shipBlock, shipColumn, isMoney } from './pdfCommon.js';

const TRAIL = 14;   // qty … total

function itemRow(line) {
  const t = line.trim().split(/\s+/);
  if (t.length < TRAIL + 3 || !/^\d{1,3}$/.test(t[0]) || !/^[A-Za-z0-9]{3,}$/.test(t[1])) return null;
  const tail = t.slice(-TRAIL);
  if (!tail.every(x => isMoney(x) && !x.endsWith('%'))) return null;
  const mid = t.slice(2, -TRAIL);
  const hsn = mid.length && /^\d{4,8}$/.test(mid[mid.length - 1]) ? mid.pop() : null;
  if (!hsn) return null;   // the HSN cell is always printed on this layout — no HSN, not an item row
  return {
    item_code: t[1], hsn, desc: mid.join(' '),
    qty: num(tail[0]), mrp: num(tail[1]), unit_cost_ex_gst: num(tail[2]), taxable: num(tail[3]),
    gst_pct: round2(num(tail[4]) + num(tail[6]) + num(tail[8])),
  };
}

const DATE = '([A-Za-z]{3,9}\\.?\\s+\\d{1,2},?\\s+\\d{4})';

export function parseInstamart(lines) {
  const warnings = [];
  const header = lines.findIndex(l => /\bItem Desc\b/i.test(l));
  const totalAt = lines.findIndex((l, i) => i > header && /^\s*Total\s+\d/.test(l));
  const rowIdx = [], rows = [];
  lines.forEach((l, i) => { const r = itemRow(l); if (r) { rowIdx.push(i); rows.push(r); } });
  const from = header >= 0 ? header + 1 : 0, to = totalAt >= 0 ? totalAt : lines.length;
  const titles = assignTitles(lines, rowIdx, from, to, l => /^\(INR\)/.test(l.trim()) || /^(No|Code|Cost|Rate)\b/.test(l.trim()));

  const block = shipBlock(lines);
  // "Mumbai, Maharashtra, 421302" — the ship column's City, State, PIN line.
  let city = null;
  const h = lines.findIndex(l => /billing address/i.test(l) && /shipping address/i.test(l));
  for (let i = h + 1; h >= 0 && i <= block.end; i++) {
    const m = shipColumn(lines[i]).match(/^([A-Za-z .]+),\s*[A-Za-z .]+,\s*[1-9]\d{5}$/);
    if (m) { city = m[1].trim(); break; }
  }
  return {
    channel_key: 'INSTAMART', layout: 'instamart_pdf',
    po_no: grab(lines, /\bPO No\s*:\s*([A-Z0-9][A-Z0-9/-]*)/i),
    po_date: isoDate(grab(lines, new RegExp(`\\bPO Date\\s*:\\s*${DATE}`))),
    delivery_date: isoDate(grab(lines, new RegExp(`Expected Delivery Date\\s*:\\s*${DATE}`))),
    expiry_date: isoDate(grab(lines, new RegExp(`PO Expiry Date\\s*:\\s*${DATE}`))),
    bill_to_gstin: block.bill_to_gstin, ship_to_gstin: block.ship_to_gstin,
    ship_to_address: block.address, ship_to_city: city, ship_to_pincode: block.pincode,
    lines: rows.map((r, k) => ({
      channel_code: r.item_code, ean: null,
      title: composeTitle(titles[k], rowIdx[k], r.desc),
      hsn: r.hsn, qty: r.qty, unit_cost_ex_gst: r.unit_cost_ex_gst, mrp: r.mrp, gst_pct: r.gst_pct, taxable: r.taxable,
    })),
    po_total_taxable: num(grab(lines, /(?:^|\s)Total Amount \(INR\)\s+([\d,]+(?:\.\d+)?)/i)),
    po_grand_total: num(grab(lines, /Grand Total \(INR\)\s+([\d,]+(?:\.\d+)?)/i)),
    warnings,
  };
}
