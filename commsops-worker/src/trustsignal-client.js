// TrustSignal vendor boundary. Hosts, auth, error shapes, phone rendering.
// NO channel logic and NO database access lives here — SMS and RCS both import it.

// ── Phone rendering (F1) ─────────────────────────────────────────────────────
// Relay stores canonical E.164. `/v1/sms` wants BARE 10 DIGITS, which makes the naive
// implementation "take the last 10" — and that sends +14155550123 to Indian mobile
// 4155550123, a real unrelated person, with nothing erroring anywhere.
//
// So: only a well-formed +91 is dialable. Everything else is a typed refusal, never a
// best-effort repair. The DLT header and template registry are India-only, so an
// international SMS could not be compliant even if it were deliverable.
function renderPhoneForSms(e164) {
  const s = typeof e164 === 'string' ? e164.trim() : '';
  if (!/^\+\d+$/.test(s)) return { ok: false, value: null, reason: 'invalid_phone' };
  if (!s.startsWith('+91')) return { ok: false, value: null, reason: 'unsupported_country' };
  if (s.length !== 13) return { ok: false, value: null, reason: 'invalid_phone' };
  return { ok: true, value: s.slice(3) };
}

module.exports = { renderPhoneForSms };
