// Pure logic behind the PAID-payments export (Priya, #bugs 2026-09-07 — "a consolidated
// report/export from Snorkel… preferably payment-wise" to update Tally and reconcile vendor
// ledgers against the bank). No React import here on purpose, so the same functions are
// importable from a plain node:test file in snorkelops-worker/test without pulling in Next/React
// (same arrangement as paymentList.js / poExport.js / tds.js). Keep this file free of JSX/hooks.
//
// Relative, NOT the `@/lib/...` alias the components use: node --test resolves this file
// directly off disk with no bundler, and the alias is a webpack/tsconfig thing that only exists
// inside Next. Same shared quoter either way.
import { csvCell } from './sales.js';
import { netPayable, round2, hasTds } from './tds.js';

// PAID ONLY, and therefore one row per PAYMENT. UTR and payment date only exist once a request
// is paid; an unpaid row cannot be booked in Tally and would invite a double entry when it later
// pays. The server-side filter (`getPaidPaymentsExport`) is the real gate — this list is the
// shape of the file.
export const PAYMENTS_EXPORT_COLUMNS = [
  'Request No', 'Payee / Vendor', 'Invoice No', 'Invoice Date', 'Invoice Total', 'Currency',
  'Amount to Pay', 'GST % (TDS)', 'Taxable value (TDS base)', 'TDS %', 'TDS Amount', 'Net Paid',
  'Payment Date', 'UTR / Ref',
  'Payment Mode', 'Category', 'Linked PO', 'Purpose', 'Requested By', 'Approved By', 'Paid By',
];

// `paid_at` is a timestamptz and arrives as UTC ('2026-09-08T06:24:19.538+00:00'), but Tally is
// keyed on the IST calendar date — a payment made at 23:00 IST is a 06-something-UTC row for the
// NEXT day, and booking it a day late breaks the bank reconciliation this file exists for.
// So shift by +5:30 and read the UTC fields (the deliberately-compensated form of PATTERN-221;
// this worker/lib pair has no local timezone to trust, unlike todayStr() in the browser).
export function istDateOf(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const ist = new Date(d.getTime() + 330 * 60 * 1000);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const day = String(ist.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// What actually left the bank.
// ⚠️ `paid_amount` is ALREADY the net when TDS was entered — the Mark-as-Paid form overwrites it
// with netPayable() the moment finance types a rate (payments/detail/page.js, finance/page.js).
// Subtracting tds_amount from it again would double-deduct. So the recorded figure wins, and the
// derivation is only the fallback for the rows finance marked paid without touching the amount
// (all 7 live rows today, none of which carry TDS).
export function netPaidOf(r) {
  if (r?.paid_amount !== null && r?.paid_amount !== undefined && r?.paid_amount !== '')
    return round2(r.paid_amount);
  return netPayable({ amountToPay: r?.amount_to_pay, tdsAmount: r?.tds_amount });
}

// One row per PAYMENT, columns in PAYMENTS_EXPORT_COLUMNS order.
// ⚠️ Every numeric here arrives from PostgREST as a STRING ('98345.00') — nothing below does
// arithmetic on a raw field; the money columns go through round2/netPayable, which coerce.
// ⚠️ A row with no TDS writes BLANK TDS cells, never 0: a 0 in a Tally-bound sheet reads as a
// deduction of zero that WAS applied, which is a different (and wrong) statement from "no TDS
// here". `hasTds` is the same gate the list and detail screens use — a 0% rate IS applicable and
// must render as 0.
// GST % (TDS) and Taxable value (TDS base) are the audit trail for the TDS figure (base = invoice
// total ex-GST, decisions.md 2026-09-11): blank with no TDS, and blank on a row paid before those
// columns existed (it has a rate but no stored base) — never back-filled with a guess.
export function buildPaymentsExportCsv(rows) {
  const out = [PAYMENTS_EXPORT_COLUMNS.join(',')];
  for (const r of rows || []) {
    const tds = hasTds(r);
    out.push([
      r.request_no || '',
      // The worker embeds the payee; `payee_name` is the flattened fallback so a caller that
      // pre-resolved the name still exports it rather than a blank vendor column.
      r.payee?.name || r.payee_name || '',
      r.invoice_no || '',
      r.invoice_date || '',
      r.invoice_total ?? '',
      r.currency || 'INR',
      r.amount_to_pay ?? '',
      tds && r.tds_gst_rate != null && r.tds_gst_rate !== '' ? Number(r.tds_gst_rate) : '',
      tds ? (round2(r.tds_base) ?? '') : '',
      tds ? Number(r.tds_rate) : '',
      tds ? (round2(r.tds_amount) ?? '') : '',
      netPaidOf(r) ?? '',
      istDateOf(r.paid_at),
      // NULL UTR is real and live (PAY-0009 was marked paid without one): an empty cell, not a
      // throw and not a placeholder Tally would try to match.
      r.payment_ref || '',
      r.payment_mode || '',
      r.category?.label || r.category_key || '',
      r.linked_po_number || '',
      r.purpose || '',
      r.requested_by_name || '',
      r.approved_by_name || '',
      r.paid_by_name || '',
    ].map(csvCell).join(','));
  }
  return out.join('\n');
}
