// Pure helpers for the Dashboard (app/(auth)/dashboard/page.js) instant-load. No I/O, no React —
// unit-tested in test/dashboard.test.mjs.
//
// Only the departments read is cached in this tab's sessionStorage (cacheIdentities below); the people
// read is always fresh. Podium holds salary, personal and performance data, so what the page holds is
// ONLY what the tiles and lists render: counts, tallies, department headcounts, and per listed person the
// handful of fields their row shows. Never a raw employee row — no date of birth (birthdays are
// held as the "in Nd" text the card shows), no email, phone, PAN, address or compensation.
// The arithmetic is the page's own from before instant-load, run over the same rows in the same
// order, so a fresh result renders exactly as the page always did (the test proves it side by side) —
// with two deliberate fixes (2026-11-14 review), both tested:
//   • Notice counts the `on_notice` flag. It counted status === 'notice', a status no row has: the worker
//     marks someone on notice by an OPEN exit (getEmployees sets on_notice on every row, full or projected,
//     for every viewer), so the tile read 0 while people were serving notice.
//   • Anniversaries / birthdays compare IST calendar days. They compared instants, so after noon today's
//     entry rounded to -1 and dropped, and tomorrow's rounded to 0 and showed as "Today".

const LIST_ROWS = 6;

// getEmployees({ status: 'all' }) → the KPI counts, the employment-type bars, and the three
// person lists. A reply without an employees array THROWS — an error with a Retry, never a cached
// "headcount 0". `nowMs` is the clock the date-based figures (New · 30d, anniversaries, birthdays)
// are counted against; the cache key carries the IST date so they never outlive their day.
export function dashboardPeople(reply, nowMs = Date.now()) {
  if (!reply || !Array.isArray(reply.employees)) throw new Error('Unexpected getEmployees reply');
  const emps = reply.employees;
  const active = emps.filter(e => e.status === 'active');
  const byStatus = tally(emps, e => e.status);
  const byType = tally(active, e => e.employment_type || 'unknown');
  const typeRows = Object.entries(byType).sort((a, b) => b[1] - a[1]);
  const typeMax = Math.max(1, ...typeRows.map(([, v]) => v));
  const recent = [...active]
    .filter(e => e.date_joined)
    .sort((a, b) => (b.date_joined || '').localeCompare(a.date_joined || ''))
    .slice(0, LIST_ROWS);
  const listRow = e => ({ id: e.id, full_name: e.full_name, job_title: e.job_title, when: e._when });
  return {
    headcount: active.length,
    newCount: active.filter(e => withinDays(e.date_joined, 30, nowMs)).length,
    onLeave: byStatus.on_leave || 0,
    notice: emps.filter(e => e.on_notice).length,
    types: typeRows.map(([k, v]) => ({ key: k, value: v, pct: Math.round(v / typeMax * 100) })),
    recent: recent.map(e => ({ id: e.id, full_name: e.full_name, photo_url: e.photo_url, job_title: e.job_title, date_joined: e.date_joined })),
    anniversaries: upcoming(active, 'date_joined', nowMs).map(listRow),
    birthdays: upcoming(active, 'date_of_birth', nowMs).map(listRow),
  };
}

// getDepartments → the Departments tile and the By Department bars (name + headcount only; the
// head / founder-owner embeds are not shown here and are dropped). Same throw-on-bad-reply rule.
export function dashboardDepartments(reply) {
  if (!reply || !Array.isArray(reply.departments)) throw new Error('Unexpected getDepartments reply');
  const depts = reply.departments;
  const deptRows = depts.slice().sort((a, b) => (b.headcount || 0) - (a.headcount || 0));
  const maxHc = Math.max(1, ...deptRows.map(d => d.headcount || 0));
  return {
    count: depts.length,
    activeCount: deptRows.filter(d => (d.headcount || 0) > 0).length,
    rows: deptRows.map(d => ({ id: d.id, name: d.name, value: d.headcount || 0, pct: Math.round((d.headcount || 0) / maxHc * 100) })),
  };
}

// Which query may use this tab's cache. PEOPLE: none, for anyone — what a viewer may see of a person is
// decided per call by the worker (HR, or the viewer's manager chain), and nothing in the browser can tell
// reliably when that narrows, so the people figures are always a fresh, server-projected answer (the query
// gets no cache identity: useCachedQuery neither seeds nor writes without one). DEPARTMENTS (id, name,
// headcount) are the same for every viewer and stay cached per user.
export function cacheIdentities(userId) {
  return { people: null, departments: userId || null };
}

// Earlier builds cached the people payload under `podium:dashboard:people:*`; remove any such entry.
export const LEGACY_PEOPLE_PREFIX = 'lotq:v1:podium:dashboard:people:';
export function purgeLegacyPeopleCache(storage) {
  if (!storage) return 0;
  try {
    const keys = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (typeof k === 'string' && k.startsWith(LEGACY_PEOPLE_PREFIX)) keys.push(k);
    }
    keys.forEach(k => { try { storage.removeItem(k); } catch { /* ignore */ } });
    return keys.length;
  } catch { return 0; }
}

export function istDate(nowMs = Date.now()) {
  return new Date(nowMs).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

// Never stored (see cacheIdentities); the key only names the query, and its IST date makes the page
// refresh when the day changes.
export function peopleKey(day = istDate()) {
  return `podium:dashboard:people:${day}`;
}

// Milliseconds from `nowMs` to the next IST midnight (IST is UTC+5:30, no DST). Always in (0, 24 h].
const IST_OFFSET_MS = 330 * 60000;
export function msUntilNextIstMidnight(nowMs = Date.now()) {
  const sinceIstMidnight = ((nowMs + IST_OFFSET_MS) % 86400000 + 86400000) % 86400000;
  return 86400000 - sinceIstMidnight;
}
export const DEPARTMENTS_KEY = 'podium:dashboard:departments';

// IST stamp: "21:04" today, "12 Nov 21:04" otherwise (same as Snorkel's / Depot's).
export function istStamp(ms, nowMs = Date.now()) {
  const d = new Date(ms);
  const hhmm = d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
  const day = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const today = new Date(nowMs).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  if (day === today) return hhmm;
  return `${d.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' })} ${hhmm}`;
}

// The page's one freshness line over the people + departments queries (the other sections carry no stamp).
// The stamp is the OLDEST data showing.
export function freshness(qs, nowMs = Date.now()) {
  const inFlight = qs.some(q => q.loading || q.refreshing);
  const failed = qs.some(q => q.error);
  const stamps = qs.map(q => q.updatedAt).filter(Boolean);
  const oldest = stamps.length ? istStamp(Math.min(...stamps), nowMs) : null;
  const text = inFlight ? (oldest ? `Updating… (showing ${oldest})` : 'Updating…')
    : failed ? (oldest ? `Couldn't refresh — showing ${oldest}` : "Couldn't refresh")
    : oldest ? `As of ${oldest}` : '';
  return { text, warn: failed && !inFlight };
}

// Not polled: refresh when the tab comes back after more than a minute hidden.
export const RETURN_REFRESH_MS = 60000;
export function shouldRefreshOnReturn(hiddenAtMs, nowMs = Date.now()) {
  return typeof hiddenAtMs === 'number' && nowMs - hiddenAtMs > RETURN_REFRESH_MS;
}

// ── the page's own helpers, unchanged except that the clock is passed in ──
function tally(arr, keyFn) { const o = {}; for (const x of arr) { const k = keyFn(x); o[k] = (o[k] || 0) + 1; } return o; }
function withinDays(d, n, nowMs) {
  if (!d) return false;
  const dt = new Date(d); if (isNaN(dt)) return false;
  const days = Math.round((nowMs - dt.getTime()) / 86400000);
  return days >= 0 && days <= n;
}
// Whole IST calendar days from today to the next occurrence of the date's month/day (a date column,
// 'YYYY-MM-DD', parses as UTC midnight — read its parts in UTC). 29 Feb in a common year → 1 Mar, as before.
function upcoming(arr, field, nowMs) {
  const ist = new Date(nowMs + 330 * 60000);
  const y = ist.getUTCFullYear();
  const today = Date.UTC(y, ist.getUTCMonth(), ist.getUTCDate());
  const out = [];
  for (const e of arr) {
    if (!e[field]) continue;
    const d = new Date(e[field]);
    if (isNaN(d)) continue;
    let next = Date.UTC(y, d.getUTCMonth(), d.getUTCDate());
    if (next < today) next = Date.UTC(y + 1, d.getUTCMonth(), d.getUTCDate());
    const days = Math.round((next - today) / 86400000);
    if (days >= 0 && days <= 30) out.push({ ...e, _days: days, _when: days === 0 ? 'Today' : `in ${days}d` });
  }
  return out.sort((a, b) => a._days - b._days).slice(0, LIST_ROWS);
}
