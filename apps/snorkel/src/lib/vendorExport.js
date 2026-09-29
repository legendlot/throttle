// Pure logic behind the Vendors directory export (Prarthi, #bugs 1790662998 — "export all the
// vendors … along with their vendor details"). No React import here on purpose, so the same
// functions are importable from a plain node:test file in snorkelops-worker/test without pulling
// in Next/React (same arrangement as poExport.js / paymentsExport.js). Keep this file free of
// JSX/hooks.
//
// Relative, NOT the `@/lib/...` alias the components use: node --test resolves this file
// directly off disk with no bundler.
import { csvCell } from './sales.js';

// One row per vendor, every field on the Vendor Details form. ⚠️ Email / address / GSTIN / notes
// are shown on screen only inside a vendor's detail form, which needs `vendor_manage` — so the
// page offers this export to `vendor_manage` only (a `procurement_view`-only user sees a reduced
// table and must not get the full file). A new column always goes on the END — a spreadsheet
// someone has built on this file reads it by position.
export const VENDOR_EXPORT_COLUMNS = [
  'Vendor Code', 'Vendor Name', 'Category', 'Process', 'Country', 'Location', 'Currency',
  'Contact Name', 'Contact Phone', 'Contact Email', 'Payment Terms', 'Lead Time (days)',
  'Address', 'GSTIN', 'Notes', 'Active', 'Added On', 'Udyam Number',
];

// ⚠️ A phone held as digits ('098452 78523', '9599083163' — 111 of 112 on file, measured
// 2026-09-29) is read as a NUMBER when the CSV is opened in Excel: the leading 0 is dropped and a
// long one turns into 9.60E+09. Written as a ="…" text formula it opens exactly as stored (same
// trick as the payments export's HYPERLINK cell). Only digit-ish values are wrapped; anything
// else is plain text already. A phone can never hold a `"` under this pattern.
export function phoneCell(v) {
  const s = v == null ? '' : String(v).trim();
  return /^[+0-9][0-9 ()+-]*$/.test(s) ? `="${s}"` : s;
}

// A text cell starting = + - @ (or a tab/CR) is run as a FORMULA by Excel. Vendor data is typed by
// internal users and 0/171 rows start that way today, but the guard costs nothing: a leading `'`
// makes Excel show it as text. Phones go through phoneCell instead (its ="…" is the one formula
// we write on purpose). The shared csvCell is left alone — fleet-wide change, out of scope.
export function textCell(v) {
  const s = v == null ? '' : String(v);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

// created_at is a timestamptz in UTC; the date a vendor was added is an IST calendar date.
function istDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 10);
}

// `processLabels` is value → label from the page's VENDOR_PROCESS_TYPES, so the file says
// 'Product supplier (FBU / CKD)' like the screen, not 'product_supplier'. An unknown value is
// written raw rather than dropped.
export function buildVendorsCsv(vendors, processLabels = {}) {
  const rows = [VENDOR_EXPORT_COLUMNS.join(',')];
  for (const v of vendors || []) {
    const t = textCell;
    rows.push([
      t(v.vendor_code), t(v.vendor_name), t(v.category),
      v.process_type ? t(processLabels[v.process_type] || v.process_type) : '',
      t(v.source_country), t(v.location), t(v.currency),
      t(v.contact_name), phoneCell(v.contact_phone), t(v.contact_email),
      t(v.payment_terms), v.lead_time_days ?? '',
      t(v.address), t(v.gstin), t(v.notes),
      v.active === false ? 'No' : 'Yes',
      istDate(v.created_at), t(v.udyam_number),
    ].map(csvCell).join(','));
  }
  // UTF-8 BOM: without it Excel opens the file as Windows-1252 and a '–' or '—' in a name
  // (3 of 171 vendors today) comes out as 'â€"'.
  return '\uFEFF' + rows.join('\n');
}
