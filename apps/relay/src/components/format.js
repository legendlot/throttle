// Snorkel redesign — shared formatters + status tone system.
// Ported from the handoff prototype (ui.jsx). Mono cells use these for
// dates / currency / counts. Tone maps drive every Badge and status pill.

// ⚠️ Timezone is PINNED to IST on the date-only formatters too, not just the datetime
// ones below. A date is MORE exposed to this than a timestamp, not less: rendered from a
// browser west of IST, any instant between 00:00 and 05:30 IST falls back onto the previous
// calendar day and the row silently reads a day early, with no clock shown to give the
// error away. `fmtDateTime`/`fmtDateTimeShort`/`stampParts` were pinned when they were
// written; these two were missed and kept the browser's zone until 2026-08-21 (S302).
export function fmtDate(raw) {
  if (!raw) return '—';
  const d = new Date(raw);
  if (isNaN(d)) return String(raw).slice(0, 10);
  return d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
}
export function fmtDateShort(raw) {
  if (!raw) return '—';
  const d = new Date(raw);
  if (isNaN(d)) return String(raw).slice(0, 10);
  return d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' });
}
// Date + time, always. A date alone cannot order two things that happened on the same
// day, which is exactly the case that matters here: several saves of one template, or
// several copies of it, all stamped "31 Jul 2026" with no way to tell which is current.
// Timezone is PINNED to IST rather than left to the browser — these timestamps are read
// against the floor's clock and quoted to the team, and a laptop on a different tz would
// silently shift every row (the same reason activity/page.js already pins it).
export function fmtDateTime(raw) {
  if (!raw) return '—';
  const d = new Date(raw);
  if (isNaN(d)) return String(raw).slice(0, 16);
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}
// Same instant, no year — for dense tables where the year is noise but the clock is not.
export function fmtDateTimeShort(raw) {
  if (!raw) return '—';
  const d = new Date(raw);
  if (isNaN(d)) return String(raw).slice(0, 16);
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true,
  });
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

// A timestamp in a table cell, split into its two facts. `fmtDateTime` returns one string
// ("17 Aug 2026, 08:50 pm") which wraps mid-value in a narrow column — the meridiem drops to
// a second line and the row grows, which is what the Links table was doing. Date identifies
// the row, clock refines it, so the clock is subordinate rather than equal.
// Returns a plain string via `.text` for CSV/title use.
export function stampParts(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  if (isNaN(d)) return null;
  const opt = { timeZone: 'Asia/Kolkata' };
  return {
    date: d.toLocaleDateString('en-IN', { ...opt, day: '2-digit', month: 'short', year: 'numeric' }),
    time: d.toLocaleTimeString('en-IN', { ...opt, hour: '2-digit', minute: '2-digit', hour12: true }),
  };
}
