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
// The COMMAND prototype's ST map (handoff §3.2) — bright fg hues on dark,
// bg ≈ rgba(hue,.13), bd ≈ rgba(hue,.34). Gray uses white at .05/.11.
export const TONES = {
  yellow: { bg: 'rgba(242,205,26,.13)',  fg: '#f2cd1a', bd: 'rgba(242,205,26,.34)',  solid: '#F2CD1A' },
  green:  { bg: 'rgba(52,211,153,.13)',  fg: '#34d399', bd: 'rgba(52,211,153,.34)',  solid: '#34d399' },
  red:    { bg: 'rgba(248,113,113,.13)', fg: '#f87171', bd: 'rgba(248,113,113,.34)', solid: '#f87171' },
  blue:   { bg: 'rgba(124,155,255,.15)', fg: '#7c9bff', bd: 'rgba(124,155,255,.34)', solid: '#7c9bff' },
  orange: { bg: 'rgba(251,146,60,.15)',  fg: '#fb923c', bd: 'rgba(251,146,60,.36)',  solid: '#fb923c' },
  gray:   { bg: 'rgba(255,255,255,.05)', fg: '#9aa0aa', bd: 'rgba(255,255,255,.11)', solid: '#71767c' },
};

export const PO_TONES = {
  Soft: 'orange', Draft: 'gray', 'Pending Approval': 'yellow', Approved: 'blue', Sent: 'yellow',
  'Confirmed & Payment Done': 'green', 'Partially Received': 'yellow', Closed: 'green', Cancelled: 'red',
};

export function sourceTone(s) { return s === 'China' ? 'blue' : s === 'India' ? 'green' : 'gray'; }
export function countryTone(c) { return c === 'China' ? 'blue' : c === 'India' ? 'green' : 'gray'; }
export function urgencyTone(u) {
  const v = (u || '').toLowerCase();
  if (v === 'critical') return 'red';
  if (v === 'urgent' || v === 'high') return 'yellow';
  return 'gray';
}
