// Consent ledger — append-only, grain = profile × channel × purpose.
const A = require('./auth.js');

// Append an immutable consent row. Opt-in/out also emits an event (caller's choice).
async function recordConsent(env, { profile_id, channel, purpose, state, source, evidence, unsubscribe_token, captured_at }) {
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
