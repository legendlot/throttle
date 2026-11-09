// Quick-add tokens for the task capture row (Docket F2). Pure: no React, no Date.now() —
// `now` is injected so it is testable. Only whitespace-delimited tokens count; anything
// unmatched stays in the title. A deadline set at create is IMMUTABLE (RULE-DOCKET-001,
// revisions need a reason), so a false positive is the expensive mistake: when in doubt a
// word stays text.
//
//   @name            → owner: an exact first name, else a unique case-insensitive prefix of
//                      the first name, then the full name; ambiguous → text. (preferred_name
//                      is honoured if a record ever carries one — getEmployees doesn't today.)
//   !p0 … !p3        → priority P0…P3
//   today · tomorrow · tmrw            anywhere
//   mon…sun / monday…sunday            only after by/on/due/before/till/until, next to a time,
//                                      or as the last word ("Sat with Riya" stays text)
//   12 nov · nov 12                    worded date
//   12/11 · 12/11/26                   slash date, day-first (Indian)
//   5pm · 5:30pm · 17:00 · 09:30       time; 24h needs a two-digit hour ("9:16", "3:30" are text)
// A date and a time may be adjacent tokens ("fri 5pm", "5pm fri"); a preceding by/on/due/
// before/till/until is taken with the deadline ("invite cards by wed" → "invite cards").
//
// Deadline shape: a UTC ISO string (`Date#toISOString()`), the same as DatePicker emits for
// the updateTask / createTask deadline. Date without a time → 18:00 IST (DatePicker's default).
// Never a past deadline, and never a date silently moved:
//   · time only            → today if still ahead, else tomorrow
//   · today / same weekday, no time → 18:00, else 23:59, else tomorrow 18:00
//   · a weekday with a time that has passed today → next week ("mon 9am" said Monday 10am)
//   · today / an explicit date + a time that has passed → no deadline (text)
//   · 12 nov (worded)      → a passed date rolls to next year only if ≤183 days away, else text
//   · 12/11 (slash, no year) → only a future date ≤60 days away (rollover included), else text
//                            ("1/2 inch", "3/4 sleeve" in November stay text)
//   · an explicit year in the past → text
// `ignore` (a Set of lower-cased words) switches parsing off for words the person un-chipped;
// `off` (a Set of kinds) skips a kind entirely (the person picked that value in a chip).

const IST_MS = 330 * 60000;
const DEFAULT_H = 18, DEFAULT_M = 0;
const DAY_MS = 86400000;
const ROLL_MAX_MS = 183 * DAY_MS;     // worded date rollover window
const SLASH_MAX_MS = 60 * DAY_MS;     // slash date (no year) window
const PREP = new Set(['by', 'on', 'due', 'before', 'till', 'until']);

const WEEKDAY = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };
const MONTH = { jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5,
  jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11 };
const WD_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON_LABEL = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// IST wall-clock parts of an instant.
function istParts(date) {
  const d = new Date(date.getTime() + IST_MS);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), wd: d.getUTCDay(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
}
// The instant for an IST wall-clock date + time (month/day overflow normalises).
const istInstant = (y, mo, d, h, mi) => new Date(Date.UTC(y, mo, d, h, mi) - IST_MS);
const validDay = (y, mo, d) => { const t = new Date(Date.UTC(y, mo, d)); return t.getUTCMonth() === mo && t.getUTCDate() === d; };

// ── single-token readers ──
function readTime(w) {
  let m = /^(\d{1,2})(?::([0-5]\d))?(am|pm)$/.exec(w);
  if (m) {
    let h = Number(m[1]); const mi = Number(m[2] || 0);
    if (h < 1 || h > 12) return null;
    if (m[3] === 'pm' && h !== 12) h += 12;
    if (m[3] === 'am' && h === 12) h = 0;
    return { h, mi };
  }
  m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(w);                    // 24h: two-digit hour only
  return m ? { h: Number(m[1]), mi: Number(m[2]) } : null;
}
// → { rel: 'today'|'tomorrow' } | { wd } | { mo, d, y? }
function readDate1(w) {
  if (w === 'today') return { rel: 'today' };
  if (w === 'tomorrow' || w === 'tmrw') return { rel: 'tomorrow' };
  if (Object.hasOwn(WEEKDAY, w)) return { wd: WEEKDAY[w] };   // hasOwn: not 'constructor'
  const m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(w);   // day-first (Indian)
  if (m) {
    const d = Number(m[1]), mo = Number(m[2]) - 1;
    const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : undefined;
    if (mo < 0 || mo > 11 || d < 1 || !validDay(y ?? 2024, mo, d)) return null;   // 2024: lets 29/02 through
    return { mo, d, y, slash: true };
  }
  return null;
}
function readDate2(a, b) {
  const num = (w) => (/^\d{1,2}$/.test(w) ? Number(w) : null);
  let d, mo;
  if (num(a) != null && Object.hasOwn(MONTH, b)) { d = num(a); mo = MONTH[b]; }
  else if (Object.hasOwn(MONTH, a) && num(b) != null) { d = num(b); mo = MONTH[a]; }
  else return null;
  return d >= 1 && validDay(2024, mo, d) ? { mo, d } : null;
}

// Resolve a date (and optional time) against `now` → Date, or null (stays text).
function resolve(date, time, now) {
  const n = istParts(now);
  const at = (y, mo, d, t) => istInstant(y, mo, d, t ? t.h : DEFAULT_H, t ? t.mi : DEFAULT_M);
  const future = (x) => (x > now ? x : null);
  // Today with no time: 18:00, else 23:59, else (23:59:30) tomorrow 18:00.
  const todayNoTime = (allowTomorrow) => future(at(n.y, n.mo, n.d, null)) || future(istInstant(n.y, n.mo, n.d, 23, 59))
    || (allowTomorrow ? at(n.y, n.mo, n.d + 1, null) : null);
  if (!date) {                                                // time only
    if (!time) return null;
    return future(at(n.y, n.mo, n.d, time)) || at(n.y, n.mo, n.d + 1, time);
  }
  if (date.rel === 'today') return time ? future(at(n.y, n.mo, n.d, time)) : todayNoTime(true);
  if (date.rel === 'tomorrow') return at(n.y, n.mo, n.d + 1, time);
  if (date.wd != null) {
    const ahead = (date.wd - n.wd + 7) % 7;
    if (ahead === 0) {                                         // same weekday = today
      if (!time) return todayNoTime(true);
      return future(at(n.y, n.mo, n.d, time)) || at(n.y, n.mo, n.d + 7, time);
    }
    return at(n.y, n.mo, n.d + ahead, time);
  }
  // explicit day + month (+ year)
  const y0 = date.y ?? n.y;
  if (y0 === n.y && date.mo === n.mo && date.d === n.d) {      // it IS today: never move it
    return time ? future(at(n.y, n.mo, n.d, time)) : todayNoTime(false);
  }
  let y = y0;
  const rolled = date.y == null && (date.mo < n.mo || (date.mo === n.mo && date.d < n.d));
  if (rolled) y += 1;
  if (!validDay(y, date.mo, date.d)) return null;              // 29/02 in a non-leap year
  const x = future(at(y, date.mo, date.d, time));
  if (!x) return null;
  // A slash date with no year is often a fraction or a ratio ("1/2 inch", "3/4 sleeve"):
  // only a near-future one counts. A passed worded date rolls only within ~6 months
  // ("12 jan" said in November) — "review nov 3 report" on 9 Nov is a mention, not a deadline.
  if (date.slash && date.y == null && x - now > SLASH_MAX_MS) return null;
  if (!date.slash && rolled && x - now > ROLL_MAX_MS) return null;
  return x;
}

export function fmtDeadlineLabel(iso, now = new Date()) {
  const p = istParts(new Date(iso)), n = istParts(now);
  const h12 = ((p.h + 11) % 12) + 1, ap = p.h < 12 ? 'am' : 'pm';
  const time = p.mi ? `${h12}:${String(p.mi).padStart(2, '0')}${ap}` : `${h12}${ap}`;
  const tom = istParts(new Date(now.getTime() + 86400000));
  const day = (p.y === n.y && p.mo === n.mo && p.d === n.d) ? 'Today'
    : (p.y === tom.y && p.mo === tom.mo && p.d === tom.d) ? 'Tomorrow'
    : `${WD_LABEL[p.wd]} ${p.d} ${MON_LABEL[p.mo]}${p.y !== n.y ? ' ' + p.y : ''}`;
  return `${day}, ${time}`;
}

// people: [{ id, full_name }] (getEmployees). preferred_name is optional and absent in
// production today (0/64); the code path is kept harmless for if it is ever added.
function matchPerson(q, people) {
  const query = q.toLowerCase().replace(/[._-]/g, '');
  if (!query) return null;
  // 1) An EXACT first-name (or preferred-name) match wins (Riya beats Riyaz for "@riya");
  //    two people with that exact name → ambiguous, stays as text.
  const first = (p) => (p.full_name || '').trim().split(/\s+/)[0].toLowerCase();
  const exact = new Map();
  for (const p of people || []) {
    if ((p.preferred_name || '').toLowerCase().replace(/\s+/g, '') === query || first(p) === query) exact.set(p.id, p);
  }
  if (exact.size === 1) return [...exact.values()][0];
  if (exact.size > 1) return null;
  // 2) Otherwise a UNIQUE prefix, tier by tier.
  const tiers = [
    (p) => (p.preferred_name || '').toLowerCase().replace(/\s+/g, ''),
    (p) => (p.full_name || '').trim().split(/\s+/)[0].toLowerCase(),
    (p) => (p.full_name || '').toLowerCase().replace(/\s+/g, ''),
  ];
  for (const key of tiers) {
    const hits = new Map();
    for (const p of people || []) { const k = key(p); if (k && k.startsWith(query)) hits.set(p.id, p); }
    if (hits.size === 1) return [...hits.values()][0];
    if (hits.size > 1) return null;                  // ambiguous at this tier — don't guess wider
  }
  return null;
}

export function parseQuickAdd(text, { people = [], now = new Date(), ignore, off } = {}) {
  const raw = String(text || '');
  const words = [];
  const re = /\S+/g; let m;
  while ((m = re.exec(raw))) words.push({ w: m[0], lw: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
  const skip = (i) => ignore && ignore.has(words[i].lw);
  const isOff = (kind) => off && off.has(kind);
  const used = new Set();
  const out = { tokens: [] };
  const push = (kind, s0, e0, label) => {
    for (let k = s0; k <= e0; k++) used.add(k);
    out.tokens.push({ kind, raw: raw.slice(words[s0].start, words[e0].end), start: words[s0].start, end: words[e0].end, label });
  };
  // Only owner / priority tokens (parsed or not) after index k → k is the "last word".
  const lastish = (k) => words.slice(k).every(x => /^!p[0-3]$/i.test(x.w) || x.w.startsWith('@'));

  for (let i = 0; i < words.length; i++) {
    if (used.has(i) || skip(i)) continue;
    const { w, lw } = words[i];
    // owner
    if (/^@[\p{L}][\p{L}._'-]*$/u.test(w)) {
      if (!out.owner_employee_id && !isOff('owner')) {
        const p = matchPerson(w.slice(1), people);
        if (p) { out.owner_employee_id = p.id; push('owner', i, i, p.full_name); }
      }
      continue;
    }
    // priority
    const pm = /^!p([0-3])$/.exec(lw);
    if (pm) {
      if (!out.priority && !isOff('priority')) { out.priority = 'P' + pm[1]; push('priority', i, i, out.priority); }
      continue;
    }
    // deadline: [date2 | date1] [time]  or  time [date2 | date1]
    if (out.deadline || isOff('deadline')) continue;
    const at = (k) => (k >= 0 && k < words.length && !used.has(k) && !skip(k) ? words[k].lw : null);
    const dateAt = (k) => {
      const a = at(k), b = at(k + 1);
      if (a && b) { const d2 = readDate2(a, b); if (d2) return { date: d2, n: 2 }; }
      if (a) { const d1 = readDate1(a); if (d1) return { date: d1, n: 1 }; }
      return null;
    };
    let date = null, time = null, span = 0;
    const dHere = dateAt(i);
    if (dHere) {
      date = dHere.date; span = dHere.n;
      const t = at(i + span) && readTime(at(i + span));
      if (t) { time = t; span += 1; }
    } else {
      const t = readTime(lw);
      if (!t) continue;
      time = t; span = 1;
      const dNext = dateAt(i + 1);
      if (dNext) { date = dNext.date; span += dNext.n; }
    }
    const prep = PREP.has(at(i - 1) || '');
    // A weekday is a common word ("Sat with Riya", "Sunday Soul Sante"): only after a
    // preposition, next to a time, or as the last word.
    if (date && date.wd != null && !time && !prep && !lastish(i + span)) continue;
    const when = resolve(date, time, now);
    // Rejected as a whole: its words stay text — the time half must not then parse on its
    // own ("pay 12 nov 9am" at 10am must not become tomorrow 9am).
    if (!when) { i += span - 1; continue; }
    out.deadline = when.toISOString();
    push('deadline', prep ? i - 1 : i, i + span - 1, fmtDeadlineLabel(out.deadline, now));
    i += span - 1;
  }

  const title = words.filter((_, i) => !used.has(i)).map(x => x.w).join(' ').trim();
  if (!title) return { title: raw.trim(), tokens: [] };
  out.title = title;
  out.tokens.sort((a, b) => a.start - b.start);
  return out;
}
