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
