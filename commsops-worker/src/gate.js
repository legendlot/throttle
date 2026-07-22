// THE central send gate — one gate, every channel, every purpose. Fixed order
// (PRD §5.4): suppression → consent → frequency cap → quiet hours → channel rule.
// Transactional/utility bypass consent+cap+quiet-hours, but NEVER suppression.
const A = require('./auth.js');
const { latestConsent } = require('./consent.js');

let _settingsCache = null;
let _settingsAt = 0;
const SETTINGS_TTL_MS = 60 * 1000; // short TTL so admin threshold/quiet-hour changes take effect within a minute
async function getSettings(env) {
  if (_settingsCache && (Date.now() - _settingsAt) < SETTINGS_TTL_MS) return _settingsCache;
  const r = await A.sbComms('/rest/v1/settings?id=eq.1&select=*&limit=1', env);
  _settingsCache = (r.ok && r.data?.[0]) || {
    frequency_cap_per_day: 3, frequency_cap_window_hours: 24,
    quiet_hours_start: 21, quiet_hours_end: 9,
    test_mode: true, test_mode_allow: ['@legendoftoys.com'],  // fail-safe: lock on if settings unreadable
  };
  _settingsAt = Date.now();
  return _settingsCache;
}

// current hour in IST (UTC+5:30)
function istHour() {
  const nowMs = Date.now() + (5 * 60 + 30) * 60 * 1000;
  return new Date(nowMs).getUTCHours();
}
function inQuietHours(start, end) {
  const h = istHour();
  return start > end ? (h >= start || h < end) : (h >= start && h < end);
}

// Test-mode allowlist match: '@domain' = suffix match, else exact email. Case-insensitive.
// Phone numbers get typed the way people read them — "+91 70191 03926", "+91-7019103926" —
// while the allow-list entry is compact. Exact equality made FORMATTING decide whether the gate
// opened, which reads as "the system is broken" rather than "you typed a space". Compare
// separator-insensitively: only whitespace, hyphens, dots and brackets are removed, never digits
// and never the leading +, so this cannot widen a match to a different number. Domain patterns
// (@example.com) still match on the raw address.
const compactAddr = (s) => s.replace(/[\s()\-.]/g, '');

function testModeAllows(to, allow) {
  const addr = (to || '').toLowerCase().trim();
  if (!addr) return false;
  const compact = compactAddr(addr);
  const list = Array.isArray(allow) ? allow : [];
  return list.some((pat) => {
    const p = String(pat || '').toLowerCase().trim();
    if (!p) return false;
    return p[0] === '@' ? addr.endsWith(p) : compactAddr(p) === compact;
  });
}

// runGate(env, {profileId, channel, purpose, to, wa?}) → {pass, reason}
// wa (WhatsApp only): {mode:'template'|'text', window_open:boolean, hasTemplate:boolean}
async function runGate(env, { profileId, channel, purpose, to, wa }) {
  const settings = await getSettings(env);

  // 0. TEST MODE — global send lock, ahead of everything. Default ON (fail-safe).
  // Until a super-admin disables it, NO send (any channel, any purpose, incl. test
  // sends + transactional) reaches an address off the allowlist. The crown-jewel guard
  // against ever emailing a real customer before sign-off.
  if (settings.test_mode !== false && !testModeAllows(to, settings.test_mode_allow))
    return { pass: false, reason: 'test_mode_blocked' };

  // 1. suppression — overrides everything. FAIL CLOSED: an unreadable suppression list is a
  //    blocked send, not a free pass (review 2026-07-21 H1 — the one gate that must never fail open).
  if (to) {
    const sup = await A.sbComms(
      `/rest/v1/suppressions?channel=eq.${A.enc(channel)}&value=eq.${A.enc(to)}&select=id&limit=1`, env);
    if (!sup.ok) return { pass: false, reason: 'gate_error:suppression' };
    if (sup.data?.[0]) return { pass: false, reason: 'suppressed' };
  }

  const isMarketing = purpose === 'marketing';
  if (isMarketing) {
    // 2. consent — marketing requires opted_in
    const state = profileId ? await latestConsent(env, profileId, channel, 'marketing') : 'unknown';
    if (state !== 'opted_in') return { pass: false, reason: 'no_consent' };

    const s = settings;
    // 3. frequency cap (marketing sends within window)
    if (profileId) {
      const since = new Date(Date.now() - Number(s.frequency_cap_window_hours || 24) * 3600 * 1000).toISOString();
      const cnt = await A.sbComms(
        `/rest/v1/messages?profile_id=eq.${A.enc(profileId)}&purpose=eq.marketing` +
        `&status=in.(sent,delivered,opened,clicked)&queued_at=gte.${A.enc(since)}&select=id`, env);
      if (!cnt.ok || !Array.isArray(cnt.data)) return { pass: false, reason: 'gate_error:freq_cap' };
      if (cnt.data.length >= Number(s.frequency_cap_per_day || 3))
        return { pass: false, reason: 'freq_cap' };
    }
    // 4. quiet hours. Journey sends defer-and-retry at the boundary (journey-workflow);
    //    everything else surfaces the skip. ALLOWLISTED recipients (test_mode_allow —
    //    internal staff + test numbers, super-admin-managed) BYPASS quiet hours entirely,
    //    regardless of test_mode: an end-to-end send test at 23:00 IST must be able to
    //    reach the tester's own phone tonight, not tomorrow morning. This can never widen
    //    to a customer — the allowlist is the internal-test list by definition.
    if (inQuietHours(Number(s.quiet_hours_start ?? 21), Number(s.quiet_hours_end ?? 9))
        && !testModeAllows(to, s.test_mode_allow))
      return { pass: false, reason: 'quiet_hours' };
  }

  // 5. channel rule
  if (channel === 'email' && (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)))
    return { pass: false, reason: 'invalid_address' };
  if (channel === 'whatsapp') {
    // recipient must look like an E.164 (8–15 digits after stripping '+'/spaces)
    const digits = String(to || '').replace(/[^\d]/g, '');
    if (digits.length < 8 || digits.length > 15) return { pass: false, reason: 'invalid_address' };
    // free-form text is only permitted inside the 24h customer-service window;
    // a template send (hasTemplate) is valid any time. Belt-and-braces with the adapter.
    if (wa && wa.mode === 'text' && wa.window_open !== true)
      return { pass: false, reason: 'window_closed' };
  }

  // 6. warm-up send budget (M9) — marketing only; transactional/utility bypass. Consumed
  // LAST so a unit is never burned on a send that another check would skip (quiet hours,
  // invalid address, cap). Atomic per-IST-day via the consume_send_budget() RPC.
  if (isMarketing) {
    const b = await A.sbComms('/rest/v1/rpc/consume_send_budget', env, { method: 'POST', body: '{}' });
    if (!b.ok) return { pass: false, reason: 'gate_error:budget' };      // don't misdiagnose a 500 as "cap hit"
    if (b.data !== true) return { pass: false, reason: 'budget_exhausted' };
  }

  return { pass: true, reason: null };
}

module.exports = { runGate, inQuietHours, testModeAllows, _clearSettingsCache: () => { _settingsCache = null; } };
