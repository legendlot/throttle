import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTicket, withRetry, dashboardKey, announcementsKey, sidebarFromMe, validSidebar, freshness, istStamp } from './load.js';
import { docketopsGet, docketopsPost, isForbidden, readJson } from './docketopsFetch.js';

// ── ticket ──
test('ticket: only the newest request may land', () => {
  const t = createTicket();
  const a = t.next();
  const b = t.next();
  assert.equal(t.isCurrent(a), false);   // an older answer arriving late is dropped
  assert.equal(t.isCurrent(b), true);
  t.drop();                              // unmount: nothing in flight applies
  assert.equal(t.isCurrent(b), false);
});

// ── retry ──
test('withRetry: a second attempt after the wait; the value when it lands', async () => {
  let calls = 0; const waits = [];
  const v = await withRetry(async () => { calls++; if (calls === 1) throw new Error('blip'); return 'ok'; },
    { retries: 1, delayMs: 2000, wait: async (ms) => { waits.push(ms); } });
  assert.equal(v, 'ok');
  assert.equal(calls, 2);
  assert.deepEqual(waits, [2000]);
});
test('withRetry: still failing → rejects with the last error (never resolves to an empty list)', async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw new Error('down ' + calls); }, { retries: 1, wait: async () => {} }), /down 2/);
  assert.equal(calls, 2);
});

// ── keys ──
test('cache keys carry what the response depends on', () => {
  assert.equal(dashboardKey(''), 'docket:dashboard:org');
  assert.equal(dashboardKey(null), 'docket:dashboard:org');
  assert.equal(dashboardKey('s1'), 'docket:dashboard:s1');
  assert.notEqual(dashboardKey('s1'), dashboardKey('s2'));
  assert.equal(announcementsKey(false), 'docket:announcements:live');
  assert.equal(announcementsKey(true), 'docket:announcements:past');
});

// ── the sidebar projection: nothing that enables an action is cached ──
test('sidebarFromMe keeps only what the sidebar paints', () => {
  const me = {
    spaces: [{ id: 's1', name: 'Ops', is_private: true, is_owner: true, task_count: 3 }], programs: [{ id: 'p1', name: 'X' }],
    announcements_unread: '2', can_view_dashboard: true, can_announce: { everyone: true, department_ids: [] },
    default_space_id: 's1', employee_id: 'e1', department_id: 'd1',
  };
  const s = sidebarFromMe(me);
  assert.deepEqual(Object.keys(s).sort(), ['announcements_unread', 'programs', 'spaces']);
  assert.equal(s.announcements_unread, 2);
  for (const k of ['can_view_dashboard', 'can_announce', 'default_space_id', 'employee_id', 'department_id']) assert.equal(k in s, false);
  assert.deepEqual(sidebarFromMe({}), { spaces: [], programs: [], announcements_unread: 0 });
  assert.throws(() => sidebarFromMe(null), /Unexpected getMe reply/);
  assert.equal(validSidebar(s), true);
  assert.equal(validSidebar({ spaces: 'x', programs: [] }), false);
  assert.equal(validSidebar(null), false);
});

// ── freshness ──
test('freshness: updating / stale / as of', () => {
  const now = Date.parse('2026-11-14T10:00:00Z');
  const at = Date.parse('2026-11-14T09:30:00Z');   // 15:00 IST
  assert.equal(istStamp(at, now), '15:00');
  assert.deepEqual(freshness([{ updatedAt: at }], now), { text: 'As of 15:00', warn: false });
  assert.deepEqual(freshness([{ updatedAt: at, refreshing: true }], now), { text: 'Updating… (showing 15:00)', warn: false });
  assert.deepEqual(freshness([{ updatedAt: at, error: new Error('x') }], now), { text: "Couldn't refresh — showing 15:00", warn: true });
  assert.deepEqual(freshness([{ loading: true }], now), { text: 'Updating…', warn: false });
  assert.equal(istStamp(Date.parse('2026-11-12T15:34:00Z'), now), '12 Nov 21:04');
});

// ── the fetch client: a 502 HTML body is a failed load with a status, never a SyntaxError ──
function stubFetch(status, body) {
  globalThis.fetch = async () => ({ ok: status >= 200 && status < 300, status, text: async () => body });
}
test('docketopsGet: 502 HTML → Error with status, not SyntaxError', async () => {
  stubFetch(502, '<html><body>Bad gateway</body></html>');
  const e = await docketopsGet('getMe', {}, 't').then(() => null, x => x);
  assert.ok(e instanceof Error);
  assert.notEqual(e.name, 'SyntaxError');
  assert.equal(e.status, 502);
  assert.equal(e.detail, null);
  assert.match(e.message, /getMe failed \(502\)/);
});
test('docketopsGet: 403 forbidden → message stays the worker code, isForbidden true', async () => {
  stubFetch(403, JSON.stringify({ ok: false, error: 'forbidden' }));
  const e = await docketopsGet('getDashboard', { space_id: 's1' }, 't').then(() => null, x => x);
  assert.equal(e.message, 'forbidden');
  assert.equal(e.status, 403);
  assert.deepEqual(e.detail, { ok: false, error: 'forbidden' });
  assert.equal(isForbidden(e), true);
  assert.equal(isForbidden(new Error('x')), false);
  assert.equal(isForbidden(null), false);
});
test('docketopsGet: a 200 with an unreadable body is a failure, not undefined data', async () => {
  stubFetch(200, '');
  await assert.rejects(docketopsGet('getTasks', {}, 't'), /unreadable reply/);
});
test('docketopsGet: success returns data.data (contract unchanged)', async () => {
  stubFetch(200, JSON.stringify({ ok: true, data: [1, 2] }));
  assert.deepEqual(await docketopsGet('getTasks', {}, 't'), [1, 2]);
});
test('docketopsPost: 502 HTML → Error with status; 409 keeps the refusal body in detail', async () => {
  stubFetch(502, '<html>');
  const e = await docketopsPost('updateTask', { id: 'x' }, 't').then(() => null, x => x);
  assert.equal(e.status, 502);
  assert.notEqual(e.name, 'SyntaxError');
  stubFetch(409, JSON.stringify({ ok: false, error: 'waiting_on', waiting_on: [{ id: 'b' }] }));
  const e2 = await docketopsPost('changeStatus', { id: 'x' }, 't').then(() => null, x => x);
  assert.equal(e2.message, 'waiting_on');
  assert.equal(e2.status, 409);
  assert.deepEqual(e2.detail.waiting_on, [{ id: 'b' }]);
});
test('readJson: non-object JSON and a throwing body read are "no body"', async () => {
  assert.equal(await readJson({ text: async () => '42' }), null);
  assert.equal(await readJson({ text: async () => { throw new Error('reset'); } }), null);
});
