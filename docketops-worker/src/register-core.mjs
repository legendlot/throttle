// Pure checklist date + register arithmetic, shared by the worker (index.js) and its tests
// (test/register-core.test.mjs). No I/O here — everything is IST calendar dates as 'YYYY-MM-DD'.

export function istDateStr(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d); // 'YYYY-MM-DD'
}

// A recurring task is expired (and drops off the checklist) once today is past its `until` date.
export function isExpired(rec, dateStr) { return !!(rec && rec.until && rec.until < dateStr); }
// Is a recurrence due on the given IST calendar date ('YYYY-MM-DD')?
export function isDueOn(rec, dateStr) {
  if (!rec || !rec.freq) return false;
  if (rec.freq === 'daily') return true;
  if (rec.freq === 'weekly') {
    const wd = new Date(`${dateStr}T12:00:00Z`).getUTCDay(); // 0=Sun..6=Sat for that calendar date
    return Array.isArray(rec.days_of_week) && rec.days_of_week.map(Number).includes(wd);
  }
  if (rec.freq === 'monthly') {
    const y = +dateStr.slice(0, 4), m = +dateStr.slice(5, 7), day = +dateStr.slice(8, 10);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate(); // last day of month m (1-based)
    const dom = Number(rec.day_of_month);
    return day === dom || (day === lastDay && dom > lastDay); // clamp short months
  }
  return false;
}

// IST 'HH:MM' for an ISO timestamp (used for late detection + display).
export function istHM(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
}
// Late = completed after the section's due_time (IST). No due_time → never late.
export function lateFlag(completedAtIso, dueTime) {
  if (!dueTime || !completedAtIso) return false;
  return istHM(completedAtIso) > dueTime;
}

// ── F8 P1 register ──────────────────────────────────────────────────────────
// rows:  [{ id, kind, task_no?, title, section, due_time, rec, start, spans }]
//        start = first IST date the row can be due; spans = null | [[from, until)] date pairs
//        (assignment periods, cut at the day a template was switched off).
// ticks: [{ row, date, at, by, note }]   (by = user id)
// days:  every date in the window, ascending.
// A row is due on d when d ≥ start, d is inside a span, the recurrence says so and it hasn't expired.
// A RECORDED TICK IS NEVER DROPPED: a date with a tick counts as due for that row even if the
// CURRENT schedule says otherwise — the schedule may have been changed since (hostile review #3:
// DKT-334/335 went Tue/Thu → Mon/Wed/Fri and would have lost 6 real ticks).
// Adherence counts a due date once it is over; today counts only if already ticked.
export function buildRegister({ rows, ticks, days, today, names = {}, userId = null }) {
  const daySet = new Set(days);
  const rowById = Object.fromEntries(rows.map(r => [r.id, r]));
  const inSpans = (r, d) => !r.spans || r.spans.some(([a, b]) => d >= a && d < b);
  const dueOn = (r, d) => d >= r.start && inSpans(r, d) && isDueOn(r.rec, d) && !isExpired(r.rec, d);

  const first = {};   // first tick wins per row|date
  [...ticks].sort((a, b) => String(a.at).localeCompare(String(b.at))).forEach(t => {
    const k = `${t.row}|${t.date}`;
    if (!first[k] && rowById[t.row] && daySet.has(t.date)) first[k] = t;
  });

  const rowDue = {};
  rows.forEach(r => { rowDue[r.id] = days.filter(d => dueOn(r, d) || first[`${r.id}|${d}`]); });
  const cols = days.filter(d => rows.some(r => rowDue[r.id].includes(d)));

  const cells = {};
  for (const [k, t] of Object.entries(first)) {
    const backfilled = istDateStr(new Date(t.at)) > t.date;   // F8 C2: ticked on a later IST day
    cells[k] = {
      at: t.at, by: names[t.by] || null, note: t.note || null, mine: !!userId && t.by === userId,
      backfilled, late: !backfilled && lateFlag(t.at, rowById[t.row].due_time),
    };
  }

  const counts = () => ({ done: 0, due: 0 });
  const adherence = { rows: {}, cols: {}, overall: counts() };
  rows.forEach(r => { adherence.rows[r.id] = counts(); });
  cols.forEach(d => { adherence.cols[d] = counts(); });
  for (const r of rows) for (const d of rowDue[r.id]) {
    const done = !!cells[`${r.id}|${d}`];
    if (d === today && !done) continue;   // today isn't over yet
    for (const b of [adherence.rows[r.id], adherence.cols[d], adherence.overall]) { b.due++; if (done) b.done++; }
  }

  return {
    rows: rows.map(r => ({ id: r.id, kind: r.kind, task_no: r.task_no || null, title: r.title, section: r.section, due_time: r.due_time, due: rowDue[r.id] })),
    cols, cells, adherence,
  };
}
