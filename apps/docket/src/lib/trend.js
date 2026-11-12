// F9 R9b — the score trend (spec §8.1 #2, §8.5): pure geometry for the inline-SVG charts on /review. Every
// number is the worker's (getScoreTrend over docket.week_score — never recomputed here).

// x for point i of n across [pad, w - pad]; one point sits in the middle.
export function xAt(i, count, w, pad = 0) {
  if (count <= 1) return w / 2;
  return pad + (i * (w - 2 * pad)) / (count - 1);
}
// y for a pct (0–100) in [pad, h - pad], 100 at the top.
export function yAt(pct, h, pad = 0) {
  const p = Math.max(0, Math.min(100, Number(pct)));
  return pad + ((100 - p) * (h - 2 * pad)) / 100;
}
const r1 = (x) => Math.round(x * 10) / 10;

// points [{ pct|null }] → an SVG path; a null pct breaks the line (a new "M"), never drawn as 0.
export function linePath(points = [], { w = 100, h = 40, pad = 2 } = {}) {
  let d = '', pen = false;
  points.forEach((p, i) => {
    if (p == null || p.pct == null || !Number.isFinite(Number(p.pct))) { pen = false; return; }
    d += `${pen ? 'L' : 'M'}${r1(xAt(i, points.length, w, pad))} ${r1(yAt(p.pct, h, pad))}`;
    pen = true;
  });
  return d;
}
// The dots (only real points).
export function dots(points = [], { w = 100, h = 40, pad = 2 } = {}) {
  return points.map((p, i) => (p == null || p.pct == null || !Number.isFinite(Number(p.pct)) ? null
    : { i, x: r1(xAt(i, points.length, w, pad)), y: r1(yAt(p.pct, h, pad)), pct: Number(p.pct), week_end: p.week_end })).filter(Boolean);
}

// The trend needs two closed weeks that actually had a cohort.
export function hasTrend(t) {
  const scored = (t?.overall || []).filter(p => p && Number(p.cohort) > 0);
  return scored.length >= 2;
}
// The last N points of a team's series from a review-pack team ({ trend, last_week }), oldest first.
export function packSeries(team, n = 4) {
  const pts = [...(team?.trend || []), team?.last_week].filter(p => p && p.week_end);
  const seen = new Set();
  const uniq = pts.filter(p => (seen.has(p.week_end) ? false : (seen.add(p.week_end), true)));
  uniq.sort((a, b) => (a.week_end < b.week_end ? -1 : 1));
  return uniq.slice(-n).map(p => ({ week_end: p.week_end, pct: p.cohort ? p.pct : null }));
}
// A stable colour per series from the app's status tokens.
const PALETTE = ['var(--accent)', 'var(--st-progress)', 'var(--st-done)', 'var(--st-blocked)', 'var(--st-abandon)', 'var(--text-2)'];
export function seriesColor(i) { return PALETTE[i % PALETTE.length]; }
