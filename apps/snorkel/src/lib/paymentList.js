// Pure logic behind PaymentList.js — no React import here on purpose, so the same functions
// are importable from a plain node:test file in snorkelops-worker/test without pulling in
// Next/React. Keep this file free of JSX/hooks; the component is the only thing that renders.

// Tabs group the worker's statuses the way the requester thinks about them.
export const STATUS_TABS = [
  { key: 'all',       label: 'All',       statuses: null },
  { key: 'submitted', label: 'Submitted', statuses: ['submitted', 'pending_approval'] },
  { key: 'approved',  label: 'Approved',  statuses: ['approved', 'held'] },
  { key: 'paid',      label: 'Paid',      statuses: ['paid'] },
  { key: 'cancelled', label: 'Cancelled', statuses: ['cancelled', 'rejected'] },
];
// Closed = nobody owes this any more. Excluded from the headline Value.
export const CLOSED = new Set(['cancelled', 'rejected']);

// Every status any tab (other than All) claims. A status outside this set has no tab of its
// own — it would otherwise be invisible everywhere except All (the 8th-status risk).
const KNOWN_STATUSES = new Set(STATUS_TABS.flatMap(t => t.statuses || []));

// Never add rupees to dollars: the headline is INR-only, and any other currency is counted,
// not summed. Byte-exact comparison used to drop 'inr' / ' INR' silently — normalise first.
export function isINR(r) {
  return String(r?.currency ?? 'INR').trim().toUpperCase() === 'INR';
}

// Rows a given tab shows. 'all' (or any tab with statuses: null) shows everything.
export function filterByTab(rows, tabKey) {
  const t = STATUS_TABS.find(t => t.key === tabKey);
  if (!t || !t.statuses) return rows;
  return rows.filter(r => t.statuses.includes(r.status));
}

// Rows counted into the headline Value for a tab. On 'all' a cancelled/rejected request is not
// money anyone still owes, so it is excluded there; a specific tab (e.g. Cancelled) still shows
// what was cancelled, for tracking.
export function valueRowsForTab(rows, tabKey) {
  const visible = filterByTab(rows, tabKey);
  return tabKey === 'all' ? visible.filter(r => !CLOSED.has(r.status)) : visible;
}

// Rows whose status isn't covered by ANY tab — an unrecognised status must show up somewhere,
// not only on All, or it can hide indefinitely.
export function otherStatusRows(rows) {
  return rows.filter(r => !KNOWN_STATUSES.has(r?.status));
}

// Free-text search over the loaded rows (Prarthi, #bugs 1791444233.835769): request no., payee,
// purpose, invoice no., linked PO, UTR, requester and the amounts. Every word must match
// somewhere in the row, case-insensitive, so "anu 0157" finds PAY-0157 for Anu Printers.
// Amounts match as typed with or without commas ("124396" or "1,24,396").
export function searchPaymentRows(rows, q) {
  const words = String(q ?? '').toLowerCase().replace(/,/g, '').split(/\s+/).filter(Boolean);
  if (!words.length) return rows;
  return rows.filter(r => {
    const hay = [
      r?.request_no, r?.payee?.name, r?.payee?.payee_code, r?.purpose, r?.invoice_no,
      r?.linked_po_number, r?.payment_ref, r?.requested_by_name, r?.category_key,
      r?.amount_to_pay, r?.invoice_total, r?.paid_amount,
    ].filter(v => v !== null && v !== undefined && v !== '').join(' ').toLowerCase().replace(/,/g, '');
    return words.every(w => hay.includes(w));
  });
}
