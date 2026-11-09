// Shared helpers for the channel-PO parsers (Sales → Orders → Import PO).
// Pure — no DOM, no fetch — so snorkelops-worker/test/po-import-parsers.test.mjs runs them in node.
// Harsh #bugs 1793871854.409349; plan docs/superpowers/plans/2026-11-09-snorkel-channel-po-import.md.
//
// Every parser returns the SAME neutral shape (the plan's), which previewSalesOrderImport consumes:
//   { channel_key, layout, po_no, po_date, delivery_date, expiry_date,
//     bill_to_gstin, ship_to_gstin, ship_to_address, ship_to_city, ship_to_pincode,
//     lines: [{ channel_code, ean, title, hsn, qty, unit_cost_ex_gst, mrp, gst_pct, taxable }],
//     po_total_taxable, po_grand_total, warnings: [] }
// Dates are ISO yyyy-mm-dd or null. Money is a Number, never a string.

export const GSTIN_RE = /\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]\b/g;

// "1,469.00 (INR)" / "18.00 %" / "  40863.58 " → Number; anything else → null (never 0 —
// a blank cell must not read as a real zero price).
export function num(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = String(v).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = n => String(n).padStart(2, '0');
const validYmd = (y, m, d) => y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31;

// Accepts 2026-11-05 · "Oct 30, 2026" · 15/11/2026 (DAY first — Flipkart's 15/11/2026 has no
// other reading) · a JS Date (exceljs hands typed date cells over as Dates, in UTC).
export function isoDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return validYmd(+m[1], +m[2], +m[3]) ? `${m[1]}-${m[2]}-${m[3]}` : null;
  m = s.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (m && MONTHS[m[1].toLowerCase()]) {
    const mo = MONTHS[m[1].toLowerCase()];
    return validYmd(+m[3], mo, +m[2]) ? `${m[3]}-${pad(mo)}-${pad(m[2])}` : null;
  }
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  if (m) return validYmd(+m[3], +m[2], +m[1]) ? `${m[3]}-${pad(m[2])}-${pad(m[1])}` : null;
  return null;
}

export const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Last plausible Indian PIN (6 digits, no leading 0) in an address.
export function pincodeOf(s) {
  const all = String(s || '').match(/(?<!\d)[1-9]\d{5}(?!\d)/g);
  return all ? all[all.length - 1] : null;
}

// First capture of `re` across the lines, trimmed; null when absent.
export function grab(lines, re) {
  for (const l of lines) { const m = l.match(re); if (m && m[1] != null && String(m[1]).trim()) return String(m[1]).trim(); }
  return null;
}

// Fold wrapped description lines onto the nearest item row (by line distance). A line exactly
// half-way goes to the LATER item: both PDF layouts start an item's description above its
// numeric row. Display only — matching never reads the title.
// `from`/`to` bound the item table (first line after the column header, the totals line).
export function assignTitles(lines, rowIdx, from, to, isNoise) {
  const out = rowIdx.map(() => []);
  for (let i = Math.max(0, from); i < Math.min(lines.length, to); i++) {
    if (!rowIdx.length || rowIdx.includes(i) || isNoise(lines[i])) continue;
    let best = 0;
    for (let k = 1; k < rowIdx.length; k++) if (Math.abs(rowIdx[k] - i) <= Math.abs(rowIdx[best] - i)) best = k;
    out[best].push({ i, t: lines[i].trim() });
  }
  return out;
}

// Wrapped fragments above the row + the row's own fragment + fragments below, in reading order.
export function composeTitle(parts, rowI, own) {
  const above = parts.filter(p => p.i < rowI).map(p => p.t), below = parts.filter(p => p.i > rowI).map(p => p.t);
  return [...above, own, ...below].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() || null;
}
