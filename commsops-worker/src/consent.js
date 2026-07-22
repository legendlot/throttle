// Consent ledger — append-only, grain = profile × channel × purpose.
const A = require('./auth.js');

// Raw latest-row read used internally by recordConsent's guard, distinguishing a
// FAILED read (r.ok === false) from a genuinely-empty result (no prior row) — the two
// are indistinguishable in latestConsent's public 'unknown' return value, which gate.js
// depends on and which this helper does NOT change. { ok, state } where state is null
// when there is no prior row (or the read failed); ok is false only on a read failure.
async function _latestConsentRaw(env, profile_id, channel, purpose) {
  const r = await A.sbComms(
    `/rest/v1/consent?profile_id=eq.${A.enc(profile_id)}&channel=eq.${A.enc(channel)}` +
    `&purpose=eq.${A.enc(purpose)}&select=state,captured_at&order=captured_at.desc&limit=1`, env);
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

// Latest consent state for (profile, channel, purpose). Returns the state string or
// 'unknown' — on either a genuinely-empty result OR a failed read. Unchanged contract;
// gate.js depends on this exact fail-to-'unknown' shape (fail-closed at the SEND gate,
// where 'unknown' already blocks). Do not use this inside recordConsent's guard — use
// _latestConsentRaw, which can distinguish the two cases.
async function latestConsent(env, profile_id, channel, purpose) {
  const r = await _latestConsentRaw(env, profile_id, channel, purpose);
  return r.state || 'unknown';
}

module.exports = { recordConsent, latestConsent };
