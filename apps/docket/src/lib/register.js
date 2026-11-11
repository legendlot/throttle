// F8 P1 — checklist register helpers (pure; tested in register.test.mjs).
// The worker (getChecklistRegister) owns the truth: due dates per row, ticks, adherence. This file only
// turns that payload into what a cell shows, and moves the window.

// Pure UTC arithmetic on a date-only string — no local-timezone drift.
export function shiftDate(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// The window [from, to] of `span` days ending at `end`.
export function windowFor(end, span) {
  return { from: shiftDate(end, -(span - 1)), to: end };
}

// Page the window by its own length. Forward never passes today (a register records the past).
export function pageWindow(end, span, dir, today) {
  const next = shiftDate(end, dir * span);
  return next > today ? today : next;
}

// What one cell is. `dueSet` = the row's due dates (Set); `cell` = the worker's tick or undefined.
//   'nodue'  — the row isn't scheduled that day
//   'done' | 'late' | 'backfilled' — ticked (backfilled wins: ticked on a later day)
//   'missed' — due, over, not ticked
//   'open'   — due today, not ticked yet
export function cellState(dueSet, cell, date, today) {
  if (!dueSet.has(date)) return 'nodue';
  if (cell) return cell.backfilled ? 'backfilled' : cell.late ? 'late' : 'done';
  return date < today ? 'missed' : 'open';
}

// Adherence as a whole percent, or null when nothing was due yet (renders as a dash, not 0%).
export function pct(bucket) {
  if (!bucket || !bucket.due) return null;
  return Math.round((bucket.done / bucket.due) * 100);
}

// Colour band for an adherence percent — matches the cell palette.
export function pctTone(p) {
  if (p == null) return 'none';
  if (p >= 90) return 'good';
  if (p >= 60) return 'mid';
  return 'bad';
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WD = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
// Column header parts for a YYYY-MM-DD date: weekday initial, day number, and the month label on
// the 1st of a month or the first column.
export function colHead(date, first) {
  const dt = new Date(`${date}T12:00:00Z`);
  const day = dt.getUTCDate();
  return { wd: WD[dt.getUTCDay()], day, month: (first || day === 1) ? MON[dt.getUTCMonth()] : '' };
}

// "12 Nov" for a date-only string.
export function fmtDay(date) {
  const dt = new Date(`${date}T12:00:00Z`);
  return `${dt.getUTCDate()} ${MON[dt.getUTCMonth()]}`;
}

// The tooltip for a cell.
export function cellTip(state, cell, date, fmtClock) {
  const d = fmtDay(date);
  if (state === 'nodue') return `${d} · not scheduled`;
  if (state === 'missed') return `${d} · missed`;
  if (state === 'open') return `${d} · due today`;
  const parts = [`${d} · done`];
  if (cell?.at) parts.push(state === 'backfilled' ? `ticked later, on ${fmtClock(cell.at, true)}` : `at ${fmtClock(cell.at)}`);
  if (state === 'late') parts.push('late');
  if (cell?.by) parts.push(`by ${cell.by}`);
  if (cell?.note) parts.push(`for ${cell.note}`);
  return parts.join(' · ');
}

// Rows grouped by section, in order, for rendering section header rows.
export function groupRows(rows) {
  const out = [];
  let cur = null;
  for (const r of rows) {
    if (!cur || cur.section !== r.section) { cur = { section: r.section, rows: [] }; out.push(cur); }
    cur.rows.push(r);
  }
  return out;
}
