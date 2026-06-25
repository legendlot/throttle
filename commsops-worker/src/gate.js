// THE central send gate — one gate, every channel, every purpose. Fixed order
// (PRD §5.4): suppression → consent → frequency cap → quiet hours → channel rule.
// Transactional/utility bypass consent+cap+quiet-hours, but NEVER suppression.
const A = require('./auth.js');
const { latestConsent } = require('./consent.js');

let _settingsCache = null;
async function getSettings(env) {
  if (_settingsCache) return _settingsCache;
  const r = await A.sbComms('/rest/v1/settings?id=eq.1&select=*&limit=1', env);
  _settingsCache = (r.ok && r.data?.[0]) || {
    frequency_cap_per_day: 3, frequency_cap_window_hours: 24,
    quiet_hours_start: 21, quiet_hours_end: 9,
  };
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

// runGate(env, {profileId, channel, purpose, to}) → {pass, reason}
async function runGate(env, { profileId, channel, purpose, to }) {
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

    const s = await getSettings(env);
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
