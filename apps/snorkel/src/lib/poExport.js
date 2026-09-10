// Pure logic behind the PO list's LINE-LEVEL export — no React import here on purpose, so the
// same functions are importable from a plain node:test file in snorkelops-worker/test without
// pulling in Next/React (same arrangement as paymentList.js). Keep this file free of JSX/hooks.
//
// ⚠️ The header-only export (exportCsv on the PO list) is safe for free: it is built from rows
// getPOs already gated server-side. A LINE-level export cannot borrow that — the lines are a
// second read — so the SAME gate is re-applied here, and again in snorkelops-worker's
// `getPOLinesBulk`. `gatePoLines` below is the single written statement of that policy; the
// worker holds an inline copy of it because the worker is a zero-import single file (no bundler,
// no module graph — it cannot import out of apps/). If the two ever diverge, this one is the
// spec and the test is on this one.
// Relative, NOT the `@/lib/...` alias the components use: node --test resolves this file
// directly off disk with no bundler, and the alias is a webpack/tsconfig thing that only exists
// inside Next. Same shared quoter either way.
import { csvCell } from './sales.js';

// Same shape as the worker's stripChinaPOLine: the two money columns leave the object entirely,
// so a caller that forgets the marker renders blank rather than a number.
function stripChinaPOLine(line) {
  if (!line) return line;
  const { unit_price, total_value, ...rest } = line;
  return rest;
}

// The China/Soft gate, mirrored EXACTLY from getPO (snorkelops-worker):
//   no `po_china` → a Soft PO is completely invisible (no header, no lines), and a China PO's
//   lines ARE returned but without unit_price/total_value.
//   with `po_china` → everything, untouched.
// `headersByPo` is po_number → { status, source }. A line whose PO has no header is DROPPED,
// not passed through: an unknown PO is one whose status we could not check, and the fail-safe
// on a permission gate is "deny", never "assume India, assume not Soft".
export function gatePoLines({ lines, headersByPo, canChina }) {
  const out = [];
  for (const line of lines || []) {
    const head = headersByPo?.[line?.po_number];
    if (!head) continue;
    if (head.status === 'Soft' && !canChina) continue;
    out.push(head.source === 'China' && !canChina ? stripChinaPOLine(line) : line);
  }
  return out;
}

// One row PER LINE, carrying enough PO header context that the file stands on its own in a
// spreadsheet — Prarthi asked for the line items, and a line without its PO number, vendor and
// status is not usable away from the screen (#bugs 2026-09-10).
export const PO_LINES_COLUMNS = [
  'PO Number', 'Revision', 'Type', 'Source', 'Vendor', 'Vendor Code', 'Status', 'Expected',
  'Line No', 'Part Code', 'Description', 'Product', 'Variant', 'Colour',
  'Qty Ordered', 'Qty Received', 'Unit', 'Unit Price', 'Total Value', 'HSN', 'GST %',
];

// `filteredRows` is the CLIENT's list, so the on-screen text search is honoured exactly like the
// header export; `linesByPo` is the worker's already-gated payload. POs with no lines in the
// payload contribute no row — this is a line-level file, and the header export is what covers
// "which POs exist". The truncation marker in the filename is what says a PO could be missing.
export function buildPoLinesCsv({ filteredRows, linesByPo, canChina }) {
  const rows = [PO_LINES_COLUMNS.join(',')];
  for (const p of filteredRows || []) {
    const restricted = p.source === 'China' && !canChina;
    for (const l of (linesByPo?.[p.po_number] || [])) {
      rows.push([
        p.po_number, p.revision || 0, p.order_type, p.source, p.vendor_name, p.vendor_code,
        p.status, p.expected_delivery || '',
        l.line_no ?? '', l.part_code || '', l.description || '',
        l.product || '', l.variant || '', l.color || '',
        l.qty_ordered ?? '', l.qty_received ?? '', l.unit || '',
        // Same marker the header export writes in the Value column — never a number, never a
        // blank that could be read as "free".
        restricted ? 'Restricted' : (l.unit_price ?? ''),
        restricted ? 'Restricted' : (l.total_value ?? ''),
        l.hsn_code || '', l.gst_percent ?? '',
      ].map(csvCell).join(','));
    }
  }
  return rows.join('\n');
}
