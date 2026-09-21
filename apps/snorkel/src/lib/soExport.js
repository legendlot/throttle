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
  // Nikhil (#bugs 1789971181, 2026-09-21): "which SKU we still need to send". Sent / packed /
  // pending come from the worker's allocateLineFulfilment — the SAME numbers the order screen
  // shows — and stay BLANK (unknown) when the worker could not read every dispatch line.
  'Shipped', 'Packed', 'Pending',
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
        num(l.shipped_qty), num(l.packed_qty), num(l.pending_qty),
      ].map(csvCell).join(','));
    });
  }
  return rows.join('\n');
}

// ── SKU summary: one row per channel × variant across the orders on screen ──────────────
// Nikhil (#bugs 1789971181): "SKU-wise … to calculate which SKU we need to send". Cancelled
// orders need nothing sent, so they are skipped even when the on-screen list includes them;
// drafts are not yet orders and are skipped too. Sorted by channel, then most pending first.
export const SO_SKU_COLUMNS = [
  'Channel', 'Product', 'Model', 'Colour', 'SKU', 'Orders', 'Ordered', 'Shipped', 'Packed', 'Pending',
];

export function buildSoSkuSummaryCsv({ filteredRows, linesByOrder }) {
  const groups = new Map();
  for (const o of filteredRows || []) {
    if (o.status !== 'confirmed') continue;
    for (const l of (linesByOrder?.[o.id] || [])) {
      // Group on the SAME key the worker allocates on (product / model / colour, whitespace- and
      // case-insensitive) — never on sku: 91% of lines carry a blank sku and the same variant
      // appears both blank and filled, which would split one pool over two rows (hostile review
      // S391d, finding 4). The SKU column shows the first non-blank one seen for the variant.
      const norm = (x) => String(x ?? '').toLowerCase().replace(/\s+/g, '');
      const k = [o.channel_key || '', norm(l.product), norm(l.model), norm(l.color)].join('\u0001');
      let g = groups.get(k);
      if (!g) {
        g = { channel: o.channel_key || '', product: l.product || '', model: l.model || '', color: l.color || '',
              sku: '', orders: new Set(), ordered: 0, shipped: 0, packed: 0, pending: 0, unknown: false };
        groups.set(k, g);
      }
      if (!g.sku && l.sku) g.sku = l.sku;
      g.orders.add(o.id);
      g.ordered += Math.round(Number(l.qty)) || 0;
      // Unknown on ANY line makes the group's sent/pending unknown — a partial sum would read
      // as "fewer to send" than the truth, which is the one direction this file must not err in.
      if (l.shipped_qty == null || l.pending_qty == null) { g.unknown = true; continue; }
      g.shipped += Math.round(Number(l.shipped_qty)) || 0;
      g.packed += Math.round(Number(l.packed_qty)) || 0;
      g.pending += Math.round(Number(l.pending_qty)) || 0;
    }
  }
  const list = [...groups.values()].sort((a, b) =>
    a.channel.localeCompare(b.channel) || (b.unknown ? 0 : b.pending) - (a.unknown ? 0 : a.pending)
    || a.product.localeCompare(b.product) || a.model.localeCompare(b.model) || a.color.localeCompare(b.color));
  const rows = [SO_SKU_COLUMNS.join(',')];
  for (const g of list) {
    rows.push([
      g.channel, g.product, g.model, g.color, g.sku, g.orders.size, g.ordered,
      g.unknown ? '' : g.shipped, g.unknown ? '' : g.packed, g.unknown ? '' : g.pending,
    ].map(csvCell).join(','));
  }
  return rows.join('\n');
}
