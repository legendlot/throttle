// Opt-out / opt-in intent detection + the single withdrawal writer.
// Channel-agnostic: WhatsApp inbound, the email unsubscribe link, and the agent-actioned
// admin call all funnel through applyOptOut, so evidence is uniform and withdrawal
// semantics live in exactly one place.

const A = require('./auth.js');
const { recordConsent } = require('./consent.js');

// EXACT-MATCH, not substring — deliberate. "please stop sending me broken cars" is a
// support complaint, not a withdrawal; substring-matching "stop" would silently opt that
// customer out while they were asking for help. That failure is invisible and
// unrecoverable — we'd never know to re-ask. A missed keyword is visible: the customer
// repeats themselves, or an agent actions it via optOutProfile. Bare keywords are also
// the TRAI/Meta convention, so exact-match is both safer AND standard.
//
// 'cancel' is deliberately ABSENT: "cancel my order" is a support intent, not a withdrawal.
const KEYWORDS_OUT = new Set([
  'stop', 'stopall', 'stop promotions', 'unsubscribe', 'unsub',
  'optout', 'opt out', 'end', 'quit', 'revoke',
]);
const KEYWORDS_IN = new Set(['start', 'unstop', 'subscribe', 'optin', 'opt in', 'resume']);

// Lowercase, drop anything that isn't a letter or space (punctuation, digits, emoji),
// collapse whitespace. "OPT-OUT" -> "opt out"; "Stop." -> "stop"; "🛑" -> "".
//
// KNOWN GAP (accepted by Afshaan 2026-07-17): this strips non-Latin scripts, so a Hindi
// "बंद करो" normalises to '' and is NEVER detected. Accepted because our approved
// template instructs "Reply STOP" in English. Tracked in BACKLOG as a DPDP s.6(4)
// exposure; optOutProfile (agent-actioned) is the manual backstop.
function normalise(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// detectOptOut(text) -> 'opt_out' | 'opt_in' | null
function detectOptOut(text) {
  const n = normalise(text);
  if (!n) return null;
  if (KEYWORDS_OUT.has(n)) return 'opt_out';
  if (KEYWORDS_IN.has(n)) return 'opt_in';
  return null;
}

// Append a withdrawal (or re-subscribe) to the consent ledger + mirror it as an event.
//
// Deliberately NOT a suppression: `comms.suppressions` is gate step ① and blocks EVERY
// purpose including transactional, so suppressing here would stop a customer's own order
// and shipping updates. `comms.consent` is gate step ② and gates marketing only — exactly
// "stop the promos, keep my delivery texts". Matches Meta's promotional policy and DPDP
// s.6(5) (withdrawal does not undo the paid order).
//
// THROWS on a failed consent write — never swallow. The caller is a webhook; a swallowed
// error returns 200, Meta never retries, and the customer's STOP is lost forever with no
// trace. Throwing surfaces a 500, Meta retries, and `ingest` dedups the event while this
// runs again. Cost: a partial failure can leave two identical opted_out rows. The ledger
// is append-only + latest-wins, so that's cosmetic. A lost withdrawal is not.
//
// `evidence` is the DPDP s.6(10) proof burden — the fiduciary must PROVE the withdrawal
// happened and on what basis. Always pass the raw artefact.
async function applyOptOut(env, { profile_id, channel, purpose = 'marketing', state, source, evidence, unsubscribe_token }) {
  if (!profile_id) return { ok: false, error: 'profile_id_required' };
  if (state !== 'opted_out' && state !== 'opted_in') return { ok: false, error: 'bad_state' };

  const c = await recordConsent(env, {
    profile_id, channel, purpose, state, source, evidence, unsubscribe_token,
  });
  if (!c.ok) throw new Error(`consent_write_failed:${JSON.stringify(c.data)}`);

  // Best-effort mirror. The consent row is the system of record; a failed event write
  // must not re-trigger the whole webhook and duplicate the consent row. sbComms returns
  // {ok:false} on a non-2xx rather than throwing, so check .ok explicitly — a bare
  // .catch() would only ever see network-layer rejections and would drop a 500 silently.
  const ev = await A.sbComms('/rest/v1/events', env, {
    method: 'POST',
    body: JSON.stringify({
      profile_id,
      name: state === 'opted_out' ? 'opted_out' : 'opted_in',
      source: source || null,
      properties: { channel, purpose },
    }),
  }).catch((e) => ({ ok: false, data: String(e?.message || e) }));
  if (!ev.ok) console.log('optout_event_error', JSON.stringify(ev.data));

  return { ok: true, profile_id, channel, purpose, state };
}

module.exports = { detectOptOut, normalise, applyOptOut, KEYWORDS_OUT, KEYWORDS_IN };
