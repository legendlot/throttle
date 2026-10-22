// Pure helpers for Outpost › Production (O13): the time axis, the chart pivot and the rates. No I/O, unit-tested
// (test/production.test.mjs). Bucket keys come from outpost.owner_production as IST wall-clock text:
// 'YYYY-MM-DD' (day grain) or 'YYYY-MM-DDTHH:00' (hour grain). They are handled as naive strings — never through the
// browser's local time zone — so a laptop set to another zone still shows Satish's hours.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const addHour = t => {
  const d = new Date(`${t}:00Z`);
  d.setUTCHours(d.getUTCHours() + 1);
  return `${d.toISOString().slice(0, 13)}:00`;
};

// Every bucket on the x-axis. Days: each calendar day of the range, worked or not (a gap is a day off, and should show).
// Hours: from the first hour anything was packed to the last, so a 07:00 start or a 21:00 finish needs no shift setup.
export function axis(range, keys) {
  if (!range) return [];
  if (range.grain === 'day') {
    const out = [];
    for (let d = range.from; d <= range.to && out.length < 4000; d = addDays(d, 1)) out.push(d);
    return out;
  }
  const seen = [...new Set(keys || [])].sort();
  if (!seen.length) return [];
  const out = [];
  for (let t = seen[0]; t <= seen[seen.length - 1] && out.length < 100; t = addHour(t)) out.push(t);
  return out;
}

export function bucketLabel(t, grain, multiDay) {
  const day = `${Number(t.slice(8, 10))} ${MONTHS[Number(t.slice(5, 7)) - 1]}`;
  if (grain === 'day') return day;
  const hh = t.slice(11, 16);
  return multiDay ? `${day} ${hh}` : hh;
}

// What a chart series is: the vendor when several vendors are shown, else the colourway.
export const colourway = r => [r.product, r.model, r.color].filter(Boolean).join(' · ') || r.sku || 'Unknown';

// series rows → one row per bucket ({ t, total, v: Map(key → packs) }) and the keys, biggest first. Values live in a
// Map, not on the row, so no name (a vendor called "total", a series called "Other") can collide with bookkeeping.
// Past `max` keys the rest fold into OTHER (a key no real name can equal).
export const OTHER = '\u0000other';
export function pivot(series, buckets, keyOf, max = Infinity) {
  const byT = new Map(buckets.map(t => [t, { t, total: 0, v: new Map() }]));
  const tot = new Map();
  for (const s of series || []) {
    const row = byT.get(s.t);
    const n = Number(s.packs || 0);
    if (!row || !n) continue;
    const k = keyOf(s);
    row.v.set(k, (row.v.get(k) || 0) + n);
    row.total += n;
    tot.set(k, (tot.get(k) || 0) + n);
  }
  const rows = [...byT.values()];
  const keys = [...tot.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  if (keys.length <= max) return { rows, keys };
  const keep = keys.slice(0, max - 1);
  const fold = new Set(keys.slice(max - 1));
  for (const r of rows) {
    let o = 0;
    for (const k of fold) { o += r.v.get(k) || 0; r.v.delete(k); }
    if (o) r.v.set(OTHER, o);
  }
  return { rows, keys: [...keep, OTHER] };
}

// Units per active hour: packs over the time the station / operator was actually packing (gaps over 10 min excluded).
export const perHour = (packs, activeMin) => (Number(activeMin) > 0 ? Number(packs || 0) / (Number(activeMin) / 60) : null);

// The usual day, from the 7 working days before the range (packs, the same measure as the chart). Hour grain: the sum of
// the hourly averages; for today, the hours already over plus the elapsed share of the current hour. Day grain: the
// trailing average as of the first working day in the range — never a later day, which would compare the range with
// itself. All time has nothing before it.
export function usual(baseline, { isToday, nowHour, nowMin = 0, allTime } = {}) {
  if (!baseline || allTime) return null;
  if (baseline.kind === 'hour') {
    if (!Number(baseline.days)) return null;
    const hrs = baseline.by_hour || [];
    const day = hrs.reduce((a, h) => a + Number(h.avg || 0), 0);
    const byNow = isToday ? hrs.reduce((a, h) => a + (h.h < nowHour ? Number(h.avg || 0) : h.h === nowHour ? Number(h.avg || 0) * nowMin / 60 : 0), 0) : null;
    return { perDay: day, byNow, days: Number(baseline.days) };
  }
  const first = (baseline.by_day || [])[0];
  return first && first.avg7 != null ? { perDay: Number(first.avg7), byNow: null, days: null } : null;
}

// How long an open quantity lasts at a daily rate, in days.
export const daysCover = (open, perDay) => (Number(perDay) > 0 ? Number(open || 0) / Number(perDay) : null);

export function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Production history (Redline's Production History, for vendors): history rows (day × vendor × colourway) → days,
// newest first, each with its colourway rows, the day's totals and the running total of units made from the first day
// shown. `q` filters by product / model / colour text; the running total follows the filter.
export const HIST_COLS = ['made', 'repacks', 'unpacks', 'dispatched', 'checked_in', 'dtk'];
export function historyView(rows, q = '') {
  const want = String(q).trim().toLowerCase();
  const keep = (rows || []).filter(r => !want || colourway(r).toLowerCase().includes(want));
  const byDay = new Map();
  for (const r of keep) {
    if (!byDay.has(r.d)) byDay.set(r.d, { d: r.d, rows: [], tot: Object.fromEntries(HIST_COLS.map(c => [c, 0])) });
    const day = byDay.get(r.d);
    day.rows.push(r);
    for (const c of HIST_COLS) day.tot[c] += Number(r[c] || 0);
  }
  const days = [...byDay.values()].sort((a, b) => (a.d < b.d ? -1 : 1));
  let run = 0;
  for (const day of days) { run += day.tot.made; day.running = run; day.rows.sort((a, b) => Number(b.made) - Number(a.made)); }
  return days.reverse();
}
export const historyProducts = rows => [...new Set((rows || []).map(r => r.product).filter(Boolean))].sort();
