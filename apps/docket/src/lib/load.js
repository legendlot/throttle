// Load helpers (S462 speed + honest-failure pass) — no React, no I/O; unit-tested in load.test.mjs.
//
// The rules they serve: only the newest request may land (a ticket); a failed load is an error with a
// Retry, never an empty list; cached copies are read-only overviews, and nothing that enables a write is
// ever taken from one. What may be cached here: the sidebar (spaces / programs / counts / unread), the
// dashboard numbers, the announcement list. Never task lists, a task, the plan, the review, hand-offs or
// checklists.

// A request ticket: take one when a load starts; apply its answer only while it is still the latest.
// Stepping views fast must never leave an older answer on screen or turn `loading` off early.
export function createTicket() {
  let n = 0;
  return {
    next() { n += 1; return n; },
    isCurrent(t) { return t === n; },
    // Unmount / a view that no longer wants anything in flight.
    drop() { n += 1; },
  };
}

// Run `fn`; on failure wait `delayMs` and try again, `retries` times. Resolves with the value, rejects
// with the LAST error. `wait` is injectable for tests.
export async function withRetry(fn, { retries = 1, delayMs = 2000, wait = defaultWait } = {}) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); } catch (e) { last = e; }
    if (i < retries) await wait(delayMs);
  }
  throw last;
}
// An arrow, not a stored bare setTimeout (an unbound built-in throws "Illegal invocation" in browsers).
const defaultWait = (ms) => new Promise((resolve) => { setTimeout(() => resolve(), ms); });

// ── cache keys: everything the response depends on (the user is the cache's own identity) ──
export const ME_SIDEBAR_KEY = 'docket:me:sidebar';
export function dashboardKey(spaceId) { return `docket:dashboard:${spaceId || 'org'}`; }
export function announcementsKey(past) { return `docket:announcements:${past ? 'past' : 'live'}`; }

// The part of getMe the sidebar PAINTS — and the only part ever cached. No permission or identity field
// (can_view_dashboard, can_announce, default_space_id, employee_id, department_id) is held, so nothing
// that enables an action can come from the cached copy. A space's is_owner is kept for the My spaces /
// By others split; the ⋯ settings button it would enable waits for the fresh getMe (layout.js).
export function sidebarFromMe(me) {
  if (!me || typeof me !== 'object') throw new Error('Unexpected getMe reply');
  return {
    spaces: Array.isArray(me.spaces) ? me.spaces : [],
    programs: Array.isArray(me.programs) ? me.programs : [],
    announcements_unread: Number(me.announcements_unread) || 0,
  };
}

// A cached sidebar that does not have the projection's shape is ignored rather than trusted.
export function validSidebar(v) {
  return !!v && typeof v === 'object' && Array.isArray(v.spaces) && Array.isArray(v.programs);
}

// IST stamp: "21:04" today, "12 Nov 21:04" otherwise (Podium's / Garage's).
export function istStamp(ms, nowMs = Date.now()) {
  const d = new Date(ms);
  const hhmm = d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
  const day = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const today = new Date(nowMs).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  if (day === today) return hhmm;
  return `${d.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' })} ${hhmm}`;
}

// The freshness line over one or more useCachedQuery results; the stamp is the OLDEST data showing.
// `warn` = a refresh failed and nothing is in flight (the copy on screen is stale).
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
