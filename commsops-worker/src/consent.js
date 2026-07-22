// Consent ledger — append-only, grain = profile × channel × purpose.
const A = require('./auth.js');

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
async function recordConsent(env, { profile_id, channel, purpose, state, source, evidence, unsubscribe_token, captured_at }) {
  if (state === 'unknown') {
    const latest = await latestConsent(env, profile_id, channel, purpose);
    if (latest === 'opted_in' || latest === 'opted_out') {
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

// Latest consent state for (profile, channel, purpose). Returns the state string or 'unknown'.
async function latestConsent(env, profile_id, channel, purpose) {
  const r = await A.sbComms(
    `/rest/v1/consent?profile_id=eq.${A.enc(profile_id)}&channel=eq.${A.enc(channel)}` +
    `&purpose=eq.${A.enc(purpose)}&select=state,captured_at&order=captured_at.desc&limit=1`, env);
  if (!r.ok || !r.data?.[0]) return 'unknown';
  return r.data[0].state || 'unknown';
}

module.exports = { recordConsent, latestConsent };
