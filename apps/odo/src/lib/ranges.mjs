// Quick-range presets as a pure function of the clock, so they can be recomputed at call time
// and tested across an IST midnight. api.js rangePresets() is exactly rangePresetsAt(Date.now()).
// No imports — unit-tested in test/dashboard.test.mjs.

const IST_MS = 5.5 * 3600 * 1000;
const istDate = (nowMs, daysAgo = 0) => new Date(nowMs + IST_MS - daysAgo * 86400 * 1000).toISOString().slice(0, 10);

// Quick-range presets → [{ key, label, from, to }] (IST). FY = Indian fiscal year (Apr 1).
export function rangePresetsAt(nowMs) {
  const to = istDate(nowMs);
  // IST wall-clock parts (UTC getters on a +5.5h-shifted Date == IST Y/M/D).
  const d = new Date(nowMs + IST_MS);
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  const pad = n => String(n).padStart(2, '0');
  const mtd = `${y}-${pad(m + 1)}-01`;
  const fy = `${m >= 3 ? y : y - 1}-04-01`;
  // Last calendar month (full 1st→last day of the previous month, IST).
  const lmY = m === 0 ? y - 1 : y, lmM = m === 0 ? 11 : m - 1;   // 0-indexed prev month
  const lmFrom = `${lmY}-${pad(lmM + 1)}-01`;
  const lmLast = new Date(Date.UTC(lmY, lmM + 1, 0)).getUTCDate();   // day 0 of next month = last day
  const lmTo = `${lmY}-${pad(lmM + 1)}-${pad(lmLast)}`;
  return [
    { key: 'today', label: 'Today',   from: to, to },
    { key: '7d',    label: '7D',      from: istDate(nowMs, 6),  to },
    { key: '30d',   label: '30D',     from: istDate(nowMs, 29), to },
    { key: '90d',   label: '90D',     from: istDate(nowMs, 89), to },
    { key: 'mtd',   label: 'MTD',     from: mtd, to },
    { key: 'lm',    label: 'Last mo', from: lmFrom, to: lmTo },
    { key: 'fy',    label: 'FY',      from: fy,  to },
  ];
}

// A tab left open across IST midnight still holds yesterday's from/to under a "Today"/"MTD" label.
// Given the selected preset key and the presets recomputed NOW, the range it should be — or null
// when nothing moved, or the range is custom (no preset), which is never touched.
export function rollPreset(preset, from, to, presetsNow) {
  if (!preset) return null;
  const p = (presetsNow || []).find(x => x.key === preset);
  if (!p || (p.from === from && p.to === to)) return null;
  return { from: p.from, to: p.to };
}
