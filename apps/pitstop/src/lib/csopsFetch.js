/**
 * csopsFetch — thin client for the csops Cloudflare Worker.
 * Mirrors @throttle/db workerFetch but pointed at NEXT_PUBLIC_CSOPS_URL.
 *
 * GET reads:  csopsGet(action, params, session)  → { ok, data }
 * POST writes: csopsPost(action, body, session)  → { ok, data, error? }
 */

function token(session) {
  return typeof session === 'string' ? session : session?.access_token;
}

const CSOPS_URL = process.env.NEXT_PUBLIC_CSOPS_URL || 'https://csops.afshaan.workers.dev';

export async function csopsGet(action, params = {}, session) {
  const qs = new URLSearchParams({ action, ...params }).toString();
  const res = await fetch(`${CSOPS_URL}/?${qs}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token(session)}` },
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.error || `csopsGet ${action} failed (${res.status})`);
  return data.data;
}

export async function csopsPost(action, body = {}, session) {
  const res = await fetch(`${CSOPS_URL}/?action=${action}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token(session)}`,
    },
    body: JSON.stringify({ action, ...body }),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.error || `csopsPost ${action} failed (${res.status})`);
  return data.data;
}

// ── Multi-select filter transport ────────────────────────────────────────────
// Multi-select filter values used to be comma-joined, so any dimension value
// CONTAINING a comma (a product named "Shadow, Red") split into two fragments,
// matched nothing, and rendered an EMPTY report that read like a quiet month
// rather than an error. No such value exists today (0 of 14,195 tickets,
// measured 2026-09-04) — this is a legal-tomorrow input, closed before it bites.
//
// Encoding: join on U+001F (UNIT SEPARATOR) and PREFIX the string with one too.
// The prefix is what makes this safe to roll out: the worker reads a leading
// U+001F as "new encoding, split on U+001F" and anything else as the old
// comma-joined form, so a page cached mid-rollout keeps working AND a single
// value containing a comma is transported intact.
export const MULTI_SEP = '\u001f';

// ⚠️ A value CONTAINING the separator would decode as TWO values — a plausible WRONG filter, and a
// worse failure than the visibly-empty report this encoding replaced. We strip it rather than throw,
// because a report must not be taken down by one odd row.
// ⛔ BE HONEST ABOUT WHAT THE STRIP DOES: "A<US>B" becomes "AB", which matches NO row — so the
// filter comes back empty or under-counted, it is NOT silently corrected to the right value. An
// earlier version of this comment claimed it "still yields the right single value"; that was wrong.
// This is acceptable only because no such value can exist: U+001F is a control character, and 0 of
// 14,209 cs_tickets rows carry any C0 control char in a filter dimension (measured 2026-09-04).
// If a value ever legitimately needs one, percent-encode here instead of stripping.
// null/undefined elements are dropped rather than becoming the strings "null"/"undefined", which
// would reach a uuid[] parameter and 500 the whole report.
export function joinMulti(values) {
  const clean = (values || [])
    .filter(v => v !== null && v !== undefined)
    .map(v => String(v).split(MULTI_SEP).join(''));
  return MULTI_SEP + clean.join(MULTI_SEP);
}
