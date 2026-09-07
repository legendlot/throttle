// Ticket → conversation visibility (S354, 2026-09-07, Pruthvi #bugs 1788772437).
//
// A Support ticket shows ONLY conversations that arrived on the Support WhatsApp number (or on a
// non-WhatsApp channel — email, Instagram, Messenger). Conversations the same customer had on the
// Marketing or Transactional numbers are NOT pulled under the ticket: measured 2026-09-07 over the
// 2,198 tickets of the last 30 days that carry a linked conversation, 1,541 carried at least one
// thread on a non-support number — nearly all of them the one-line "wrong number" redirect, which
// is exactly what the panel was rendering on the ticket instead of the real conversation.
//
// Pure functions, real imports in the test (same shape as analytics.js): the predicate decides
// what an agent SEES on a ticket, so a silent change here hides conversations with nothing failing.
//
// `supportPid` is the Support number's phone_number_id, resolved by the caller from
// comms.sender_identities (purpose=utility, active) — never hardcoded, it changes on every WABA
// migration. A NULL waba_phone_number_id is a pre-Relay (BiteSpeed-era) thread, and every one of
// those was on the support line, so NULL counts as support.

/** Does this thread belong on a Support ticket? */
export function isSupportVisible(thread, supportPid) {
  if (!thread) return false;
  if (String(thread.channel || 'whatsapp') !== 'whatsapp') return true;
  const pid = thread.waba_phone_number_id;
  if (pid == null || pid === '') return true;
  return String(pid) === String(supportPid);
}

/** Split a thread list into what the ticket shows and what it hides, order preserved. */
export function partitionBySupport(threads, supportPid) {
  const visible = [];
  const hidden = [];
  for (const t of threads || []) (isSupportVisible(t, supportPid) ? visible : hidden).push(t);
  return { visible, hidden };
}

/**
 * The same rule as a PostgREST filter, for the query-level fallback (phone/email match).
 * Returns a bare `or=(...)` clause — the caller joins it with `&`.
 */
export function supportVisibleClause(supportPid) {
  const pid = encodeURIComponent(String(supportPid));
  return `or=(channel.neq.whatsapp,waba_phone_number_id.is.null,waba_phone_number_id.eq.${pid})`;
}
