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

// ── Per-channel quiet hours (S268) ──────────────────────────────────────────────
// One global pair could not serve every channel: promotional SMS in India is deliverable
// 10:00–21:00 only (TCCCPR, scrubbed at the carrier), WhatsApp is outside TCCCPR, and email
// is not a telecom resource at all. Minute precision because the column is a `time`.
const _IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
function istMinutes() {
  const d = new Date(Date.now() + _IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
// 'HH:MM' | 'HH:MM:SS' → minutes since IST midnight. null on anything unparseable, so a
// malformed row falls back rather than silently resolving to 00:00 (= quiet all day).
function toMinutes(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (!isFinite(h) || !isFinite(min) || h > 23 || min > 59) return null;
  return h * 60 + min;
}
function inQuietWindow(startMin, endMin, nowMin) {
  // start === end would mean a zero-length window; treat as "never quiet" rather than
  // "always quiet" — the latter would silently halt a channel forever.
  if (startMin === endMin) return false;
  return startMin > endMin ? (nowMin >= startMin || nowMin < endMin)   // wraps midnight
                           : (nowMin >= startMin && nowMin < endMin);
}

let _cqhCache = null;
let _cqhAt = 0;
// Returns { ok:true, rows } or { ok:false }. ⚠️ The distinction is load-bearing and was a REAL
// BUG in the first cut of this: "unreadable" must NOT collapse into "no row for this channel".
// The global fallback pair is 22:00–08:00, which is MORE PERMISSIVE than SMS's own 21:00–10:00 —
// so silently falling back on a read failure would let SMS send at 21:30 and at 09:00, both
// outside the TCCCPR window. A table we cannot read fails CLOSED instead, matching the freq-cap
// precedent above ("a DB error must BLOCK, never pass" — gate-failclosed.test.js). Blocking
// marketing for a minute is recoverable; a non-compliant SMS is not.
async function getChannelQuietHours(env) {
  if (_cqhCache && (Date.now() - _cqhAt) < SETTINGS_TTL_MS) return _cqhCache;
  let r;
  // sbProfile does not catch a fetch rejection, so a transport failure throws. Catch it here so
  // it becomes the same explicit fail-closed signal as a non-2xx, rather than an exception that
  // escapes runGate from a step that previously made no network call at all.
  try { r = await A.sbComms('/rest/v1/channel_quiet_hours?select=*', env); }
  catch (_) { r = { ok: false }; }
  if (!r.ok || !Array.isArray(r.data)) return { ok: false };   // NOT cached — retry next send
  _cqhCache = { ok: true, rows: Object.fromEntries(r.data.map((x) => [x.channel, x])) };
  _cqhAt = Date.now();
  return _cqhCache;
}

// Resolution order, deliberately: row + enabled → that window · row + disabled → NO quiet
// hours · no row (or table unreadable) → the global settings pair. The fallback direction
// matters — a channel added later must arrive GUARDED, because the failure that actually
// reaches customers is sending at 3am, not skipping a send.
function resolveQuietWindow(rows, channel, settings) {
  const row = rows && rows[channel];
  if (row) {
    if (!row.enabled) return null;                       // channel is exempt
    const s = toMinutes(row.start_time), e = toMinutes(row.end_time);
    if (s != null && e != null) return { startMin: s, endMin: e, source: `channel:${channel}` };
    // malformed row → fall through to the global pair rather than trusting a bad value
  }
  const gs = Number(settings.quiet_hours_start ?? 21), ge = Number(settings.quiet_hours_end ?? 9);
  return { startMin: gs * 60, endMin: ge * 60, source: 'global' };
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

// The recipients a TEST send may reach: test_mode_allow (super-admin, may carry @domain
// patterns) ∪ test_allowlist (builder-managed via addTestAllowlist, exact addresses only).
// Two lists on purpose — widening TEST reach must never widen the crown-jewel send lock.
function testUnion(settings) {
  const a = Array.isArray(settings.test_mode_allow) ? settings.test_mode_allow : [];
  const b = Array.isArray(settings.test_allowlist) ? settings.test_allowlist : [];
  return a.concat(b);
}

// Is `to` an allowed TEST-send recipient? (used by sendTest / sendCampaignTest call sites)
async function testRecipientAllowed(env, to) {
  const settings = await getSettings(env);
  return testModeAllows(to, testUnion(settings));
}

// runGate(env, {profileId, channel, purpose, to, wa?, isTest?}) → {pass, reason}
// wa (WhatsApp only): {mode:'template'|'text', window_open:boolean, hasTemplate:boolean}
// isTest: a deliberate test send (sendTest / sendCampaignTest). Test sends are HARD-LOCKED
// to the test union (enforced here as defense-in-depth, not only at the call sites) and in
// exchange bypass consent / frequency cap / quiet hours — safe precisely because they can
// only ever reach internal/test addresses. Suppression + channel rules still apply.
async function runGate(env, { profileId, channel, purpose, to, wa, isTest }) {
  const settings = await getSettings(env);

  // 0a. TEST-send recipient lock — before everything, regardless of test_mode.
  if (isTest && !testModeAllows(to, testUnion(settings)))
    return { pass: false, reason: 'test_recipient_not_allowlisted' };

  // 0. TEST MODE — global send lock, ahead of everything. Default ON (fail-safe).
  // Until a super-admin disables it, NO send (any channel, any purpose, incl. test
  // sends + transactional) reaches an address off the allowlist. The crown-jewel guard
  // against ever emailing a real customer before sign-off. (A test send may additionally
  // use the builder-managed test_allowlist — it already passed the 0a lock above.)
  if (settings.test_mode !== false && !testModeAllows(to, isTest ? testUnion(settings) : settings.test_mode_allow))
    return { pass: false, reason: 'test_mode_blocked' };

  // 1. suppression — overrides everything. FAIL CLOSED: an unreadable suppression list is a
  //    blocked send, not a free pass (review 2026-07-21 H1 — the one gate that must never fail open).
  //    RCS also checks the SMS list: with_fallback is the only vendor send path, so every RCS
  //    send carries a live SMS leg to the same number — a DND-suppressed SMS number must not be
  //    reachable through the RCS door.
  if (to) {
    const supCh = channel === 'rcs' ? 'in.(rcs,sms)' : `eq.${A.enc(channel)}`;
    const sup = await A.sbComms(
      `/rest/v1/suppressions?channel=${supCh}&value=eq.${A.enc(to)}&select=id&limit=1`, env);
    if (!sup.ok) return { pass: false, reason: 'gate_error:suppression' };
    if (sup.data?.[0]) return { pass: false, reason: 'suppressed' };
  }

  // Test sends skip the marketing gates (consent / freq cap / quiet hours) AND the send
  // budget: a test must verify rendering + delivery on demand, and it is already locked
  // to internal/test recipients by 0a — there is no customer to protect from it.
  const isMarketing = purpose === 'marketing' && !isTest;
  // S274 — 'service': a message the CUSTOMER'S OWN action triggered, sent to the person who
  // just interacted with us (the CSAT survey after an agent closes their conversation). It is
  // deliberately its own purpose rather than reusing either neighbour:
  //   · NOT 'marketing' — marketing demands opted_in consent, so a support customer who never
  //     opted into marketing would silently never be surveyed, which biases the score toward
  //     the marketing-consenting subset. It would also burn M9 send budget meant for campaigns
  //     and compete with them under the 3/day frequency cap.
  //   · NOT 'utility'/'transactional' — those bypass quiet hours outright, and 14.5% of WhatsApp
  //     conversation closes land between 21:00 and 01:00 IST (measured 2026-08-13, 601 of 4,140).
  //     Surveying someone at midnight is worse than not surveying them.
  // So: bypasses consent + frequency cap + send budget, RESPECTS quiet hours and (like every
  // purpose, without exception) suppression. Journey sends defer-and-retry at the quiet-hours
  // boundary rather than dropping, so those 601 are delayed to the morning, not lost.
  const isService = purpose === 'service' && !isTest;
  const quietHoursApply = isMarketing || isService;
  if (isMarketing) {
    // 2. consent — marketing requires opted_in
    let state;
    if (channel === 'rcs') {
      // D2/D3 (spec 2026-08-03 §7, F7). An RCS send requires consent on BOTH `rcs` AND `sms`,
      // and `rcs` RESOLVES THROUGH the SMS opt-in when no rcs-specific consent exists.
      //
      // ⚠️ These two checks COLLAPSE TO ONE today — with zero collected rcs consent, the rcs
      // call resolves to the sms opt-in and "require both" evaluates the same row twice. That
      // is deliberate, not redundancy to simplify away: D2 (require both) is the DURABLE rule
      // and starts doing real work the day `rcs` gains its own consent axis; D3 (the resolver)
      // is the CURRENT bridge, visible here rather than baked in as a 10,602-row backfill that
      // would masquerade as collected consent. An explicit rcs opt-OUT wins over the resolver.
      let rcsState = profileId ? await latestConsent(env, profileId, 'rcs', 'marketing') : 'unknown';
      if (rcsState === 'unknown') {
        rcsState = profileId ? await latestConsent(env, profileId, 'sms', 'marketing') : 'unknown';   // D3
      }
      const smsState = profileId ? await latestConsent(env, profileId, 'sms', 'marketing') : 'unknown'; // D2
      state = (rcsState === 'opted_in' && smsState === 'opted_in') ? 'opted_in' : rcsState;
    } else {
      state = profileId ? await latestConsent(env, profileId, channel, 'marketing') : 'unknown';
    }
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
  }

  if (quietHoursApply) {
    // 4. quiet hours. Journey sends defer-and-retry at the boundary (journey-workflow);
    //    everything else surfaces the skip. ALLOWLISTED recipients (test_mode_allow —
    //    internal staff + test numbers, super-admin-managed) BYPASS quiet hours entirely,
    //    regardless of test_mode: an end-to-end send test at 23:00 IST must be able to
    //    reach the tester's own phone tonight, not tomorrow morning. This can never widen
    //    to a customer — the allowlist is the internal-test list by definition.
    //    S268: the window is now PER CHANNEL (a null window means the channel is exempt —
    //    email, by decision). The allowlist bypass and the skip reason are unchanged, so
    //    journey defer-and-retry keys off exactly the same signal as before.
    // NB read `settings` directly, not the `s` alias — that alias is scoped to the
    // marketing block above, and quiet hours now also serves 'service' sends (S274).
    const cqh = await getChannelQuietHours(env);
    if (!cqh.ok) return { pass: false, reason: 'gate_error:quiet_hours' };
    const win = resolveQuietWindow(cqh.rows, channel, settings);
    if (win && inQuietWindow(win.startMin, win.endMin, istMinutes())
        && !testModeAllows(to, settings.test_mode_allow))
      return { pass: false, reason: 'quiet_hours' };
  }

  // 5. channel rule
  if (channel === 'email' && (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)))
    return { pass: false, reason: 'invalid_address' };
  // RCS takes the stored E.164 unchanged (spec §6b rule 4) — a bare-10-digit or malformed
  // recipient is refused here, before the adapter's own identical check can burn a send row.
  if (channel === 'rcs' && !/^\+\d{8,14}$/.test(String(to || '')))
    return { pass: false, reason: 'invalid_address' };
  if (channel === 'whatsapp') {
    // recipient must look like an E.164 (8–15 digits after stripping '+'/spaces)
    const digits = String(to || '').replace(/[^\d]/g, '');
    if (digits.length < 8 || digits.length > 15) return { pass: false, reason: 'invalid_address' };
    // free-form text is only permitted inside the 24h customer-service window;
    // a template send (hasTemplate) is valid any time. Belt-and-braces with the adapter.
    // `interactive` (reply-buttons, no template) is a SESSION message exactly like text and
    // carries the same restriction — listing it explicitly rather than inverting the test on
    // `hasTemplate`, so a future mode has to opt IN to being sendable outside the window.
    // 'media' (agent attachment, S245) is a session message exactly like the other two. It is
    // listed here rather than inferred, per the note above — a new mode must opt IN to being
    // sendable outside the window, and this one must not be.
    if (wa && (wa.mode === 'text' || wa.mode === 'interactive' || wa.mode === 'media') && wa.window_open !== true)
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

module.exports = { runGate, getSettings, inQuietHours, testModeAllows, testRecipientAllowed, testUnion,
  // S268 per-channel quiet hours — exported for the journey park boundary + unit tests.
  getChannelQuietHours, resolveQuietWindow, inQuietWindow, toMinutes, istMinutes,
  _clearSettingsCache: () => { _settingsCache = null; _cqhCache = null; } };
