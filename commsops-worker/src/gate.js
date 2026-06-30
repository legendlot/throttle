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
function testModeAllows(to, allow) {
  const addr = (to || '').toLowerCase().trim();
  if (!addr) return false;
  const list = Array.isArray(allow) ? allow : [];
  return list.some((pat) => {
    const p = String(pat || '').toLowerCase().trim();
    if (!p) return false;
    return p[0] === '@' ? addr.endsWith(p) : addr === p;
  });
}

// runGate(env, {profileId, channel, purpose, to}) → {pass, reason}
async function runGate(env, { profileId, channel, purpose, to }) {
  const settings = await getSettings(env);

  // 0. TEST MODE — global send lock, ahead of everything. Default ON (fail-safe).
  // Until a super-admin disables it, NO send (any channel, any purpose, incl. test
  // sends + transactional) reaches an address off the allowlist. The crown-jewel guard
  // against ever emailing a real customer before sign-off.
  if (settings.test_mode !== false && !testModeAllows(to, settings.test_mode_allow))
    return { pass: false, reason: 'test_mode_blocked' };

  // 1. suppression — overrides everything
  if (to) {
    const sup = await A.sbComms(
      `/rest/v1/suppressions?channel=eq.${A.enc(channel)}&value=eq.${A.enc(to)}&select=id&limit=1`, env);
    if (sup.ok && sup.data?.[0]) return { pass: false, reason: 'suppressed' };
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
      if (cnt.ok && Array.isArray(cnt.data) && cnt.data.length >= Number(s.frequency_cap_per_day || 3))
        return { pass: false, reason: 'freq_cap' };
    }
    // 4. quiet hours (defer, don't drop — surfaced as a skip reason in v1)
    if (inQuietHours(Number(s.quiet_hours_start ?? 21), Number(s.quiet_hours_end ?? 9)))
      return { pass: false, reason: 'quiet_hours' };
  }

  // 5. channel rule
  if (channel === 'email' && (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)))
    return { pass: false, reason: 'invalid_address' };

  return { pass: true, reason: null };
}

module.exports = { runGate, inQuietHours, _clearSettingsCache: () => { _settingsCache = null; } };
