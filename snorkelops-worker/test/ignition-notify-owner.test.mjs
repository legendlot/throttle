// Reann #2 S5 — ignitionNotifyOwner: Snorkel DMs the Ignition deal owner when Finance holds or
// rejects a creator payment. The REAL worker is driven through its own fetch handler; Supabase
// (PostgREST + Auth admin) and Slack are stubbed behind global fetch.
// Run: node --test snorkelops-worker/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/index.js'), 'utf8');
const worker = (await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src))).default;

const REF = '11111111-0000-4000-8000-000000000001';
const OWNER = '22222222-0000-4000-8000-000000000002';
const ENG = '33333333-0000-4000-8000-000000000003';
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json' } });

function world({ request = { request_no: 'PAY-0042', status: 'held', amount_to_pay: 15000, held_reason: 'Invoice <missing> GST & PAN', rejection_note: null },
                 email = 'himani@legendoftoys.com', slackUser = 'U123',
                 deal = { engagement_id: ENG }, eng = { engagement_no: 'IGN-2026-00815', poc_user_id: OWNER } } = {}) {
  const log = { slack: [], authReads: [], filters: [], profiles: [] };
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    if (u.hostname === 'slack.com') {
      const method = u.pathname.replace('/api/', '');
      if (method === 'users.lookupByEmail') return json(slackUser ? { ok: true, user: { id: slackUser } } : { ok: false, error: 'users_not_found' });
      const body = JSON.parse(init.body || '{}');
      log.slack.push({ method, body });
      if (method === 'conversations.open') return json({ ok: true, channel: { id: 'D999' } });
      if (method === 'chat.postMessage') return json({ ok: true });
      return json({ ok: false, error: 'unexpected ' + method });
    }
    if (u.pathname === '/rest/v1/deal_payment_requests' || u.pathname === '/rest/v1/engagements') {
      log.profiles.push([u.pathname, init.headers?.['Accept-Profile'], u.search]);
      const row = u.pathname.endsWith('engagements') ? eng : deal;
      return json(row ? [row] : []);
    }
    if (u.pathname.startsWith('/auth/v1/admin/users/')) {
      log.authReads.push(u.pathname.split('/').pop());
      return email == null ? json({}, 404) : json({ id: OWNER, email });
    }
    if (u.pathname === '/rest/v1/payment_requests') {
      log.filters.push(u.search);
      return json(request ? [request] : []);
    }
    throw new Error('fake: unexpected ' + u.href);
  };
  const env = { SUPABASE_SERVICE_KEY: 'k', IGNITION_INTERNAL_TOKEN: 'tok', SLACK_BOT_TOKEN: 'xoxb' };
  const call = async (data, token = 'tok') => {
    const res = await worker.fetch(new Request('https://snorkelops.test/internal/ignition', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ action: 'ignitionNotifyOwner', data }),
    }), env, { waitUntil() {} });
    return { status: res.status, body: await res.json() };
  };
  return { log, call };
}
const input = (o = {}) => ({ source_ref: REF, ...o });

test('held: DMs the deal\'s OWN owner (read from Ignition) with Snorkel\'s reason, escaped, and the deal link — caller fields ignored', async () => {
  const w = world();
  const r = await w.call(input({ owner_user_id: '99999999-0000-4000-8000-000000000009', engagement_id: '99999999-0000-4000-8000-000000000008',
    engagement_no: 'x\n<!channel>', text: 'arbitrary message' }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data, { sent: true, reason: null });
  const post = w.log.slack.find(x => x.method === 'chat.postMessage');
  assert.equal(post.body.channel, 'D999');
  assert.match(post.body.text, /^IGN-2026-00815: creator payment PAY-0042 \(₹15,000\) was put on hold by Finance: Invoice &lt;missing&gt; GST &amp; PAN\n/);
  assert.ok(post.body.text.endsWith(`https://ignition.legendoftoys.com/engagements/detail/?id=${ENG}`));
  assert.ok(w.log.filters[0].includes(`source_system=eq.ignition`) && w.log.filters[0].includes(`source_ref=eq.${REF}`));
  assert.deepEqual(w.log.authReads, [OWNER]);
  assert.deepEqual(w.log.profiles.map(p => p[1]), ['ignition', 'ignition']);
  assert.ok(w.log.profiles[0][2].includes(`id=eq.${REF}`) && w.log.profiles[1][2].includes(`id=eq.${ENG}`));
  assert.ok(!post.body.text.includes('arbitrary') && !post.body.text.includes('channel'));
});

test('a held reason with newlines and Slack control syntax stays one escaped line', async () => {
  const w = world({ request: { request_no: 'PAY-9', status: 'held', amount_to_pay: 1, held_reason: 'a\n<!channel> <https://x.co|click>' } });
  await w.call(input());
  const t = w.log.slack.find(x => x.method === 'chat.postMessage').body.text;
  assert.equal(t.split('\n').length, 2);
  assert.ok(t.includes('a &lt;!channel&gt; &lt;https://x.co|click&gt;'));
});

test('no Ignition row or no owner on the deal → sent:false, nothing looked up in Slack', async () => {
  for (const [o, reason] of [[{ deal: null }, 'no_deal'], [{ eng: { engagement_no: 'IGN-1', poc_user_id: null } }, 'no_owner']]) {
    const w = world(o);
    const r = await w.call(input());
    assert.deepEqual(r.body.data, { sent: false, reason });
    assert.equal(w.log.slack.length, 0); assert.equal(w.log.authReads.length, 0);
  }
});

test('rejected: uses the rejection note', async () => {
  const w = world({ request: { request_no: 'PAY-7', status: 'rejected', amount_to_pay: 500, held_reason: null, rejection_note: 'Duplicate' } });
  const r = await w.call(input());
  assert.equal(r.body.data.sent, true);
  assert.match(w.log.slack.find(x => x.method === 'chat.postMessage').body.text, /was rejected by Finance: Duplicate/);
});

test('a request that is not held/rejected sends nothing', async () => {
  const w = world({ request: { request_no: 'PAY-1', status: 'approved', amount_to_pay: 1 } });
  const r = await w.call(input());
  assert.deepEqual(r.body.data, { sent: false, reason: 'not_held_or_rejected' });
  assert.equal(w.log.slack.length, 0);
});

test('a non-LOT or missing owner email sends nothing', async () => {
  for (const email of ['someone@gmail.com', null]) {
    const w = world({ email });
    const r = await w.call(input());
    assert.deepEqual(r.body.data, { sent: false, reason: 'no_lot_email' });
    assert.equal(w.log.slack.length, 0);
  }
});

test('no Slack account for the owner → sent:false, no DM opened', async () => {
  const w = world({ slackUser: null });
  const r = await w.call(input());
  assert.deepEqual(r.body.data, { sent: false, reason: 'no_slack_user' });
  assert.equal(w.log.slack.length, 0);
});

test('bad ids → 400 before any read; unknown request → 404; no token → 401', async () => {
  let w = world();
  let r = await w.call(input({ source_ref: 'x' }));
  assert.equal(r.status, 400); assert.equal(w.log.filters.length, 0);
  w = world({ request: null });
  r = await w.call(input());
  assert.equal(r.status, 404);
  w = world();
  r = await w.call(input(), null);
  assert.equal(r.status, 401); assert.equal(w.log.slack.length, 0);
});
