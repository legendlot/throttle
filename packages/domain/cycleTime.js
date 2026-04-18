// Tukey IQR fences applied to cycle-time rows.
// Server (Postgres RPC) computes these for Redline; this pure-JS version
// is for reporting views that receive raw rows and need client-side stats.
export function calcCycleTimeStats(rows) {
  const values = (rows || [])
    .map((r) => (typeof r === 'number' ? r : r?.cycle_time_mins ?? r?.cycle_time ?? r?.mins))
    .filter((v) => typeof v === 'number' && isFinite(v) && v >= 0)
    .sort((a, b) => a - b);

  const n = values.length;
  if (n === 0) {
    return { median: 0, p95: 0, mean: 0, iqrLow: 0, iqrHigh: 0, outlierCount: 0, outlierPct: 0 };
  }

  const q = (p) => {
    const idx = (n - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return values[lo];
    return values[lo] + (values[hi] - values[lo]) * (idx - lo);
  };

  const q1 = q(0.25);
  const q3 = q(0.75);
  const iqr = q3 - q1;
  const iqrLow  = Math.max(0, q1 - 1.5 * iqr);
  const iqrHigh = q3 + 1.5 * iqr;

  const inliers = values.filter((v) => v >= iqrLow && v <= iqrHigh);
  const outlierCount = n - inliers.length;
  const outlierPct = n ? (outlierCount / n) * 100 : 0;

  const mean = inliers.length
    ? inliers.reduce((a, b) => a + b, 0) / inliers.length
    : 0;
  const median = q(0.5);
  const p95 = q(0.95);

  return { median, p95, mean, iqrLow, iqrHigh, outlierCount, outlierPct };
}
