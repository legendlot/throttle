/**
 * docketopsFetch — thin client for the docketops Cloudflare Worker.
 * Mirrors podiumopsFetch; pointed at NEXT_PUBLIC_DOCKETOPS_URL.
 *
 * GET reads:  docketopsGet(action, params, session)  → unwrapped data
 * POST writes: docketopsPost(action, body, session)  → unwrapped data
 */

function token(session) {
  return typeof session === 'string' ? session : session?.access_token;
}

const DK_URL = process.env.NEXT_PUBLIC_DOCKETOPS_URL || 'https://docketops.afshaan.workers.dev';

export async function docketopsGet(action, params = {}, session) {
  const clean = {};
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') clean[k] = v;
  const qs = new URLSearchParams({ action, ...clean }).toString();
  const res = await fetch(`${DK_URL}/?${qs}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token(session)}` },
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.error || `docketopsGet ${action} failed (${res.status})`);
  return data.data;
}

// Writes that provably cannot change a sidebar task count (S309). Everything else
// fires `docket:counts-changed`, so this is a SKIP-list on purpose and not an
// allow-list: a task action added later refreshes the badges by default, and the
// worst a missing entry here can do is cost one extra getMe. An allow-list is the
// PATTERN-218 shape — a rule fully coded with one enforcement point that nobody
// remembers to teach the new value.
//
// Scratch notes are the reason this list exists at all: the Scratchpad autosaves
// 600ms after each typing pause, so an unfiltered hook fires a getMe per pause
// while someone writes a note, for a surface that holds no tasks.
const NO_COUNT_CHANGE = /ScratchNote|Checklist/i;

export async function docketopsPost(action, body = {}, session) {
  const res = await fetch(`${DK_URL}/?action=${action}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token(session)}`,
    },
    body: JSON.stringify({ action, ...body }),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.error || `docketopsPost ${action} failed (${res.status})`);
  // Only after a CONFIRMED success — a failed write must not move a badge.
  if (typeof window !== 'undefined' && !NO_COUNT_CHANGE.test(action)) {
    window.dispatchEvent(new Event('docket:counts-changed'));
  }
  return data.data;
}
