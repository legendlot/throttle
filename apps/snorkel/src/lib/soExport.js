// Pure logic behind the Sales Orders list's LINE-LEVEL export ("Export + lines", Prarthi, #bugs
// 2026-09-11) — the SO twin of poExport.js. No React import here on purpose, so it is importable
// from a plain node:test file in snorkelops-worker/test without pulling in Next/React. Keep this
// file free of JSX/hooks.
// Relative, NOT the `@/lib/...` alias: node --test resolves this file directly off disk with no
// bundler, and the alias only exists inside Next.
import { csvCell, orderStatusLabel } from './sales.js';

// One row PER LINE, carrying enough order header context that the file stands on its own in a
// spreadsheet. ⚠️ Finance reads these files by POSITION: a new column always goes on the END, and
// every row builder below must emit exactly SO_LINES_COLUMNS.length cells (the test checks it).
export const SO_LINES_COLUMNS = [
  'Order', 'Order Date', 'Status', 'Partner', 'Partner Code', 'Partner GSTIN', 'Partner PO Ref',
  'Channel', 'Invoice', 'Invoice Date',
  'Line No', 'Product', 'Model', 'Colour', 'SKU', 'HSN', 'Description',
  'Qty', 'Rate', 'Discount %', 'Taxable Value', 'GST %', 'GST Amount', 'Line Total',
];

// PostgREST returns numeric columns as STRINGS ("1234.50"). Normalise to a number so the file
// is uniform whichever shape arrives — but a null/blank stays BLANK (never 0: a blank rate and a
// zero rate mean different things), and a genuine 0 stays 0 (never blank).
function num(v) {
  if (v == null || String(v).trim() === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? n : String(v);
}

// `filteredRows` is the CLIENT's list (getSalesOrders rows after the on-screen search /
// fulfilment / overdue filters), so this file covers exactly the orders the header Export does.
// `linesByOrder` (order id → lines, already in sort_order) and `partnerByOrder` (order id →
// { partner_code, gstin }) come from the worker's getSalesOrderLinesBulk. Orders with no lines
// contribute no row — the header Export is what covers "which orders exist".
export function buildSoLinesCsv({ filteredRows, linesByOrder, partnerByOrder }) {
  const rows = [SO_LINES_COLUMNS.join(',')];
  for (const o of filteredRows || []) {
    const p = partnerByOrder?.[o.id] || {};
    (linesByOrder?.[o.id] || []).forEach((l, i) => {
      rows.push([
        o.order_no, o.order_date || '', orderStatusLabel(o.status), o.partner_name || '',
        p.partner_code || '', p.gstin || '', o.partner_po_ref || '',
        o.channel_key || '', o.invoice_no || '', o.invoice_date || '',
        i + 1, l.product || '', l.model || '', l.color || '', l.sku || '', l.hsn_code || '',
        l.description || '',
        num(l.qty), num(l.rate), num(l.discount_pct), num(l.taxable_value), num(l.gst_pct),
        num(l.gst_amount), num(l.line_total),
      ].map(csvCell).join(','));
    });
  }
  return rows.join('\n');
}
