// Period-key helpers + labels shared by the payouts UI. Mirrors the worker's periodMeta.
export const PAYOUT_TYPES = [
  { key: 'fixed', label: 'Fixed' },
  { key: 'variable', label: 'Variable' },
  { key: 'one_time_bonus', label: 'One-time Bonus' },
  { key: 'perk', label: 'Perk' },
  { key: 'other', label: 'Other' },
];
export const payoutTypeLabel = (k) => (PAYOUT_TYPES.find((t) => t.key === k)?.label || k);

export const fmtINR = (n) => (n == null || n === '' ? '—' : '₹' + Number(n).toLocaleString('en-IN'));

// Fiscal year that a JS Date falls in (Apr–Mar). Returns the start calendar year.
export function fyStartYear(d) {
  const dt = d ? new Date(d) : new Date(2026, 6, 1);
  return dt.getMonth() >= 3 ? dt.getFullYear() : dt.getFullYear() - 1;
}
export function halfKey(startYear, half) {
  return `FY${String(startYear).slice(2)}-${String(startYear + 1).slice(2)}-H${half}`;
}
export const monthKey = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
export function periodLabel(key) {
  if (/^\d{4}-\d{2}$/.test(key)) {
    const [y, m] = key.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleString('en-IN', { month: 'short', year: 'numeric' });
  }
  const hm = /^FY(\d{2})-(\d{2})-H([12])$/.exec(key);
  if (hm) return `FY${hm[1]}-${hm[2]} · H${hm[3]} (${hm[3] === '1' ? 'Apr–Sep' : 'Oct–Mar'})`;
  return key || 'Ad-hoc';
}
