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
  const data = await readJson(res);
  if (!res.ok || !data || data.ok === false) throw replyError(`docketopsGet ${action}`, res, data);
  return data.data;
}

// The body, parsed defensively: a 502 / 504 from the edge is an HTML page, and res.json() would surface
// it as a SyntaxError ("Unexpected token <") instead of "the read failed (502)". null = no JSON body.
export async function readJson(res) {
  let text = '';
  try { text = await res.text(); } catch { return null; }
  if (!text) return null;
  try { const v = JSON.parse(text); return v && typeof v === 'object' ? v : null; } catch { return null; }
}

// One error shape for reads and writes: the message stays the worker's code (callers match on it),
// `status` tells "not allowed" (403) from "didn't load", `detail` is the whole refusal body (null when
// the reply was not JSON). A 200 with no readable body is a failure too, never an empty result.
export function replyError(what, res, data) {
  const status = res?.status ?? 0;
  const why = !res?.ok ? `failed (${status})` : data ? 'refused' : 'unreadable reply';
  const e = new Error((data && data.error) || `${what} ${why}`);
  e.status = status;
  e.detail = data;
  return e;
}

// The worker refused this caller (403) — an access answer, not a failed load. Never cached.
export function isForbidden(e) { return Number(e?.status) === 403; }

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
// Plan writes (F9) hold no tasks either — a split re-links tasks but moves none between spaces; proposals
// (R3) hold none at all.
// R9a: saving / archiving a template holds no tasks (applying one creates tasks — it refreshes).
// F8 P2: record writes hold no tasks (…Checklist… covers create / update / link) — except
// createTaskFromRecordItem, which creates one and so is deliberately NOT matched here.
const NO_COUNT_CHANGE = /ScratchNote|Checklist|PlanItem|Proposal|Review|FounderFocus|saveTemplate|archiveTemplate|setRecordItemState|addRecordItem|pullTemplateUpdates/i;

export async function docketopsPost(action, body = {}, session) {
  const res = await fetch(`${DK_URL}/?action=${action}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token(session)}`,
    },
    body: JSON.stringify({ action, ...body }),
  });
  const data = await readJson(res);
  if (!res.ok || !data || data.ok === false) {
    // status: callers may tell a 4xx (changed / forbidden) from a 5xx (F3 triage). detail: the full refusal
    // body, as workerFetch does — F7's 409 waiting_on lists its blockers.
    throw replyError(`docketopsPost ${action}`, res, data);
  }
  // Only after a CONFIRMED success — a failed write must not move a badge.
  if (typeof window !== 'undefined' && !NO_COUNT_CHANGE.test(action)) {
    window.dispatchEvent(new Event('docket:counts-changed'));
  }
  // F9 R2: the shared Plan pickers (components/plan/PlanPicker.js) re-read after any plan write.
  // R9a: applying a template creates plan items too.
  if (typeof window !== 'undefined' && /PlanItem|applyTemplate/.test(action)) window.dispatchEvent(new Event('docket:plan-changed'));
  return data.data;
}
