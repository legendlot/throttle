// Consent ledger — append-only, grain = profile × channel × purpose.
const A = require('./auth.js');

// Raw latest-row read used internally by recordConsent's guard, distinguishing a
// FAILED read (r.ok === false) from a genuinely-empty result (no prior row) — the two
// are indistinguishable in latestConsent's public 'unknown' return value, which gate.js
// depends on and which this helper does NOT change. { ok, state } where state is null
// when there is no prior row (or the read failed); ok is false only on a read failure.
// `unknown` rows are EXCLUDED here — the latest KNOWN state is what matters.
//
// An `unknown` means "we have no information". An append-only ledger entry that carries no
// information must not be able to change the effective state, yet ordering by captured_at let
// exactly that happen. The 2026-07-22 write-guard stopped an `unknown` landing ON TOP of a
// known row, but could not stop the reverse race, which is what still bit us:
//
//   Shopify's webhook stamps captured_at = now(); Shopflo's genuine opt-in carries its OWN
//   (earlier) timestamp and often arrives a few seconds LATER. At the moment the `unknown` was
//   written no opt-in existed, so the guard correctly allowed it — then the opt-in landed
//   underneath it and the `unknown` won the sort. Measured live: a customer who opted in at
//   00:28:40 was buried by an `unknown` stamped 00:28:59, 19 seconds later.
//
// Excluding `unknown` from the read makes the ordering race unlosable, and needs no backfill:
// the buried opt-ins simply become visible again.
//
// Fail-closed is preserved. A profile whose ONLY rows are `unknown` still resolves to null
// here, and latestConsent still returns the string 'unknown', which the gate blocks on. And a
// withdrawal is always written as `opted_out` (optout.js applyOptOut rejects anything else), so
// no real opt-out can hide behind this filter.
async function _latestConsentRaw(env, profile_id, channel, purpose) {
  const r = await A.sbComms(
    `/rest/v1/consent?profile_id=eq.${A.enc(profile_id)}&channel=eq.${A.enc(channel)}` +
    `&purpose=eq.${A.enc(purpose)}&state=neq.unknown` +
    `&select=state,captured_at&order=captured_at.desc,created_at.desc&limit=1`, env);
  if (!r.ok) return { ok: false, state: null };
  return { ok: true, state: r.data?.[0] ? (r.data[0].state || 'unknown') : null };
}

// Append an immutable consent row. Opt-in/out also emits an event (caller's choice).
//
// GUARD (Afshaan-approved 2026-07-22, closes the Shopify unknown-consent hostile-review
// item): an `unknown` write is appended ONLY when no prior KNOWN state (opted_in/
// opted_out) exists for this (profile, channel, purpose). Without this, Shopify's
// indeterminate-consent signal (mapped to 'unknown' in shopify.js mktState) clobbers a
// genuine opted_in on every customers/update webhook — live evidence: Afshaan's own
// opted_in (2026-06-30) was overridden by a shopify_webhook unknown on 2026-07-16,
// causing no_consent send-skips. A real withdrawal always arrives as opted_out (never
// unknown — see optout.js applyOptOut, which rejects any state other than
// opted_out/opted_in), so this guard can never block a genuine opt-out. Cost: one extra
// read, and ONLY on the unknown path — opted_in/opted_out writes are unaffected.
// unknown-over-unknown is deliberately NOT guarded (dedup upstream already collapses
// identical rows); the only protected case is unknown landing above a KNOWN row.
//
// FAILS CLOSED on a failed read (review follow-up 2026-07-22): latestConsent's public
// contract collapses "no prior row" and "read failed" into the same 'unknown' string,
// which would let a transient DB error fail OPEN — an unknown row landing above a known
// one, exactly the bug this guard exists to prevent. So the guard uses the raw variant
// above and treats a failed read as "skip the write", never "proceed to write". Skipping
// is always safe: an unknown row is never load-bearing, and the next successful delivery
// (webhook retry / next backfill page) re-attempts it.
async function recordConsent(env, { profile_id, channel, purpose, state, source, evidence, unsubscribe_token, captured_at }) {
  if (state === 'unknown') {
    const latest = await _latestConsentRaw(env, profile_id, channel, purpose);
    if (!latest.ok) {
      return { ok: true, skipped: 'unknown_no_override_read_failed' };
    }
    if (latest.state === 'opted_in' || latest.state === 'opted_out') {
      return { ok: true, skipped: 'unknown_no_override' };
    }
  }
  const row = {
    profile_id, channel, purpose, state,
    source: source || null,
    evidence: evidence || null,
    unsubscribe_token: unsubscribe_token || null,
    captured_at: captured_at || new Date().toISOString(),
  };
  return A.sbComms('/rest/v1/consent', env, { method: 'POST', body: JSON.stringify(row) });
}

// Latest KNOWN consent state for (profile, channel, purpose) — see _latestConsentRaw for why
// `unknown` rows are skipped. Returns the state string, or 'unknown' when there is no known
// row at all OR the read failed. Return SHAPE is unchanged; gate.js depends on this exact
// fail-to-'unknown' behaviour (fail-closed at the SEND gate, where 'unknown' blocks). Do not
// use this inside recordConsent's guard — use _latestConsentRaw, which distinguishes
// "no row" from "read failed".
async function latestConsent(env, profile_id, channel, purpose) {
  const r = await _latestConsentRaw(env, profile_id, channel, purpose);
  return r.state || 'unknown';
}

// `_latestConsentRaw` is exported for gate.js's `influencer_outreach` check ONLY (S327).
// That check treats "no consent row" as PASS (cold outreach is the point), so it cannot use
// latestConsent: that collapses "no row" and "read failed" into the same 'unknown' string, and
// a purpose which passes on 'unknown' would therefore FAIL OPEN on a transient DB error —
// sending cold outreach to someone who may have opted out. The raw variant keeps the two apart
// so the gate can block on a read failure, matching every other step in it.
// Underscore retained: still not for general use. Prefer latestConsent everywhere else.
module.exports = { recordConsent, latestConsent, _latestConsentRaw };
