// Snorkel redesign — shared formatters + status tone system.
// Ported from the handoff prototype (ui.jsx). Mono cells use these for
// dates / currency / counts. Tone maps drive every Badge and status pill.

export function fmtDate(raw) {
  if (!raw) return '—';
  const d = new Date(raw);
  if (isNaN(d)) return String(raw).slice(0, 10);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}
export function fmtDateShort(raw) {
  if (!raw) return '—';
  const d = new Date(raw);
  if (isNaN(d)) return String(raw).slice(0, 10);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}
export function inr(n) {
  const v = Number(n) || 0;
  return '₹' + v.toLocaleString('en-IN');
}
export function inrCompact(n) {
  const v = Number(n) || 0;
  if (v >= 10000000) return '₹' + (v / 10000000).toFixed(2) + ' Cr';
  if (v >= 100000)   return '₹' + (v / 100000).toFixed(2) + ' L';
  if (v >= 1000)     return '₹' + (v / 1000).toFixed(1) + 'k';
  return '₹' + v.toLocaleString('en-IN');
}
export function money(cur, n) {
  const sym = cur === 'USD' ? '$' : cur === 'RMB' || cur === 'CNY' ? '¥' : '₹';
  return sym + ' ' + (Number(n) || 0).toLocaleString('en-IN');
}

// ── Status tone system (soft bg / fg / border / solid) ────────────────
export const TONES = {
  yellow: { bg: 'rgba(242,205,26,.13)', fg: '#f4d54a', bd: 'rgba(242,205,26,.32)', solid: '#F2CD1A' },
  green:  { bg: 'rgba(34,197,94,.13)',  fg: '#5fe08a', bd: 'rgba(34,197,94,.30)',  solid: '#22c55e' },
  red:    { bg: 'rgba(222,42,42,.15)',  fg: '#ff7a7a', bd: 'rgba(222,42,42,.32)',  solid: '#DE2A2A' },
  blue:   { bg: 'rgba(77,104,255,.16)', fg: '#9aabff', bd: 'rgba(77,104,255,.34)', solid: '#4d68ff' },
  orange: { bg: 'rgba(249,115,22,.15)', fg: '#ffa459', bd: 'rgba(249,115,22,.32)', solid: '#f97316' },
  gray:   { bg: 'rgba(255,255,255,.05)',fg: '#9aa0a6', bd: 'rgba(255,255,255,.10)', solid: '#71767c' },
};

// Every PO status, in lifecycle order — PO_STATUSES (the PO list's filter) is DERIVED from these
// keys, so a status added here reaches the badge and the filter together. `Accepted` (Draft →
// Accepted → Approved, written by the worker's accept step) was missing from both until
// 2026-09-11 while holding 53% of all POs: the filter could not select it and its badge fell
// through to gray. Its tone matches PODetailClient's PO_STATUS_TONES.
export const PO_TONES = {
  Soft: 'orange', Draft: 'gray', 'Pending Approval': 'yellow', Accepted: 'yellow', Approved: 'blue', Sent: 'yellow',
  'Confirmed & Payment Done': 'green', 'Partially Received': 'yellow', Closed: 'green', Cancelled: 'red',
};
export const PO_STATUSES = Object.keys(PO_TONES);
// "Open" = still in flight: every status except Soft, Closed and Cancelled. ONE list for every
// Open KPI/value/list — four hand-kept copies disagreed with each other and all four left out
// `Accepted`, 255 of 480 POs that stock is still received against (Afshaan, 2026-09-11, S374).
export const OPEN_PO_STATUSES = ['Draft', 'Pending Approval', 'Accepted', 'Approved', 'Sent',
  'Confirmed & Payment Done', 'Partially Received'];

export function sourceTone(s) { return s === 'China' ? 'blue' : s === 'India' ? 'green' : 'gray'; }
export function countryTone(c) { return c === 'China' ? 'blue' : c === 'India' ? 'green' : 'gray'; }
export function urgencyTone(u) {
  const v = (u || '').toLowerCase();
  if (v === 'critical') return 'red';
  if (v === 'urgent' || v === 'high') return 'yellow';
  return 'gray';
}
