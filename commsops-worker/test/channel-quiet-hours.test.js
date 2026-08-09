// test/channel-quiet-hours.test.js — per-channel marketing quiet windows (S268).
//
// The behaviour worth locking down is not "does it block at night" — it is the three
// resolution branches and, above all, WHICH DIRECTION each failure mode falls in:
//   • unreadable table  → FAIL CLOSED. The global fallback (22:00–08:00) is MORE PERMISSIVE
//     than SMS's own (21:00–10:00), so falling back on a read error would let SMS send at
//     21:30 and 09:00 — outside the TCCCPR window. That was a real bug in the first cut.
//   • row present, disabled → no quiet hours at all (email, by decision 2026-08-09).
//   • no row for the channel → the global pair, so a channel added later arrives GUARDED.
const assert = require('assert');
const A = require('../src/auth.js');
const GATE = require('../src/gate.js');
const G = require('../src/journey-graph.js');
const { runGate, resolveQuietWindow, inQuietWindow, toMinutes, _clearSettingsCache } = GATE;

let pass = 0, fail = 0;
const t = (n, f) => Promise.resolve().then(f).then(
  () => { pass++; console.log('  ok  ', n); },
  (e) => { fail++; console.log('  FAIL', n, '\n        ', e.message); });

const M = (h, m = 0) => h * 60 + m;
const ROWS = {
  email:    { channel: 'email',    enabled: false, start_time: '22:00', end_time: '08:00' },
  sms:      { channel: 'sms',      enabled: true,  start_time: '21:00', end_time: '10:00' },
  whatsapp: { channel: 'whatsapp', enabled: true,  start_time: '22:00', end_time: '08:00' },
  broken:   { channel: 'broken',   enabled: true,  start_time: 'oops',  end_time: '10:00' },
};
const SETTINGS = { quiet_hours_start: 22, quiet_hours_end: 8 };

const orig = A.sbComms;
function mockDb({ cqhOk = true, cqhRows = Object.values(ROWS), settings = {} } = {}) {
  const s = { test_mode: false, test_mode_allow: [], frequency_cap_per_day: 3,
    frequency_cap_window_hours: 24, quiet_hours_start: 22, quiet_hours_end: 8, ...settings };
  A.sbComms = async (path) => {
    if (path.startsWith('/rest/v1/settings')) return { ok: true, data: [s] };
    if (path.startsWith('/rest/v1/channel_quiet_hours'))
      return cqhOk ? { ok: true, data: cqhRows } : { ok: false, status: 500, data: 'boom' };
    if (path.startsWith('/rest/v1/suppressions')) return { ok: true, data: [] };
    if (path.startsWith('/rest/v1/consent')) return { ok: true, data: [{ state: 'opted_in' }] };
    if (path.startsWith('/rest/v1/messages')) return { ok: true, data: [] };
    if (path.includes('consume_send_budget')) return { ok: true, data: true };
    return { ok: true, data: [] };
  };
  _clearSettingsCache();
}

(async () => {
  // ── resolution branches (pure) ────────────────────────────────────────────────
  await t('a disabled row means NO quiet hours, not a 00:00 window', async () => {
    assert.strictEqual(resolveQuietWindow(ROWS, 'email', SETTINGS), null);
  });
  await t('an enabled row uses its own window', async () => {
    assert.deepStrictEqual(resolveQuietWindow(ROWS, 'sms', SETTINGS),
      { startMin: M(21), endMin: M(10), source: 'channel:sms' });
  });
  await t('a channel with NO row falls back to global (arrives guarded)', async () => {
    assert.deepStrictEqual(resolveQuietWindow(ROWS, 'push', SETTINGS),
      { startMin: M(22), endMin: M(8), source: 'global' });
  });
  await t('a malformed time falls back rather than resolving to 00:00', async () => {
    // 00:00 would be "quiet all day" — a channel silently halted forever.
    assert.deepStrictEqual(resolveQuietWindow(ROWS, 'broken', SETTINGS),
      { startMin: M(22), endMin: M(8), source: 'global' });
  });

  // ── window maths ──────────────────────────────────────────────────────────────
  await t('SMS and WhatsApp genuinely diverge at 09:00 — the whole point', async () => {
    assert.strictEqual(inQuietWindow(M(21), M(10), M(9)), true,  'SMS still quiet at 09:00');
    assert.strictEqual(inQuietWindow(M(22), M(8),  M(9)), false, 'WhatsApp sending at 09:00');
  });
  await t('and again at 21:30, the other end', async () => {
    assert.strictEqual(inQuietWindow(M(21), M(10), M(21, 30)), true);
    assert.strictEqual(inQuietWindow(M(22), M(8),  M(21, 30)), false);
  });
  await t('a zero-length window is NEVER quiet, never always-quiet', async () => {
    assert.strictEqual(inQuietWindow(M(9), M(9), M(9)), false);
  });
  await t('minute precision is honoured at the boundary', async () => {
    assert.strictEqual(inQuietWindow(M(21, 30), M(10), M(21, 29)), false);
    assert.strictEqual(inQuietWindow(M(21, 30), M(10), M(21, 30)), true);
  });
  await t('unparseable times are rejected, not coerced', async () => {
    assert.strictEqual(toMinutes('nope'), null);
    assert.strictEqual(toMinutes('25:00'), null);
    assert.strictEqual(toMinutes('21:00:00'), M(21));
  });

  // ── the failure direction that matters ────────────────────────────────────────
  await t('UNREADABLE table FAILS CLOSED — never silently onto the looser global window', async () => {
    mockDb({ cqhOk: false });
    const g = await runGate({}, { profileId: 'P', channel: 'sms', purpose: 'marketing', to: '+919000000000' });
    assert.strictEqual(g.pass, false);
    assert.ok(String(g.reason).startsWith('gate_error'), `expected gate_error, got ${g.reason}`);
  });
  await t('an exempt channel passes the quiet-hours step at any hour', async () => {
    mockDb({});
    const g = await runGate({}, { profileId: 'P', channel: 'email', purpose: 'marketing', to: 'c@gmail.com' });
    assert.notStrictEqual(g.reason, 'quiet_hours');
  });
  await t('transactional bypasses quiet hours entirely, unchanged', async () => {
    mockDb({});
    const g = await runGate({}, { profileId: 'P', channel: 'sms', purpose: 'transactional', to: '+919000000000' });
    assert.notStrictEqual(g.reason, 'quiet_hours');
  });

  // ── park boundary parity ──────────────────────────────────────────────────────
  await t('the minute helper matches the hour helper on an exact hour', async () => {
    const now = Date.UTC(2026, 7, 9, 15, 30, 0);   // 21:00 IST
    assert.strictEqual(G.msUntilIstMinute(now, M(10)), G.msUntilIstHour(now, 10));
  });
  await t('park lands at the CHANNEL boundary, not one global hour', async () => {
    const now = Date.UTC(2026, 7, 9, 15, 30, 0);   // 21:00 IST
    const sms = G.msUntilIstMinute(now, M(10));    // 13h
    const wa  = G.msUntilIstMinute(now, M(8));     // 11h
    assert.ok(sms > wa, 'SMS must wait longer than WhatsApp');
    assert.strictEqual(Math.round((sms - wa) / 3600000), 2);
  });

  A.sbComms = orig;
  console.log(fail ? `\n${fail} FAILED` : `\nall ${pass} passed`);
  if (fail) process.exit(1);
})();
