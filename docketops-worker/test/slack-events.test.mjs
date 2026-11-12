// F9 R7 prep — /slack/events: the url_verification handshake, and the v0 signature gate once the secret is set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { slackEvents, slackSignatureOk } from '../src/slack-core.mjs';

const SECRET = 'test-signing-secret';
const sign = (ts, raw, secret = SECRET) => 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex');
const req = (raw, headers = {}) => new Request('https://docketops.example/slack/events', { method: 'POST', body: raw, headers });

test('url_verification echoes the challenge (no secret needed — Slack checks before one exists)', async () => {
  const r = await slackEvents(req(JSON.stringify({ type: 'url_verification', challenge: 'abc123' })), {});
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'abc123');
});

test('bad JSON → 400; an oversized challenge is not echoed', async () => {
  assert.equal((await slackEvents(req('not json'), {})).status, 400);
  const r = await slackEvents(req(JSON.stringify({ type: 'url_verification', challenge: 'x'.repeat(500) })), {});
  assert.equal(await r.text(), '');
});

test('with the secret set: an event needs a valid, fresh v0 signature', async () => {
  const raw = JSON.stringify({ type: 'event_callback', event: { type: 'app_mention' } });
  const now = Math.floor(Date.now() / 1000);
  const good = await slackEvents(req(raw, { 'x-slack-request-timestamp': String(now), 'x-slack-signature': sign(now, raw) }), { SLACK_DOCKET_SIGNING_SECRET: SECRET });
  assert.equal(good.status, 200);
  const forged = await slackEvents(req(raw, { 'x-slack-request-timestamp': String(now), 'x-slack-signature': sign(now, raw, 'other') }), { SLACK_DOCKET_SIGNING_SECRET: SECRET });
  assert.equal(forged.status, 401);
  const unsigned = await slackEvents(req(raw), { SLACK_DOCKET_SIGNING_SECRET: SECRET });
  assert.equal(unsigned.status, 401);
});

test('signatures older than 5 minutes are refused (replay window)', async () => {
  const raw = '{"type":"event_callback"}';
  const now = 2_000_000_000;
  const old = now - 301;
  const r = new Request('https://x/slack/events', { method: 'POST', body: raw,
    headers: { 'x-slack-request-timestamp': String(old), 'x-slack-signature': sign(old, raw) } });
  assert.equal(await slackSignatureOk(r, raw, SECRET, now), false);
  const fresh = now - 299;
  const r2 = new Request('https://x/slack/events', { method: 'POST', body: raw,
    headers: { 'x-slack-request-timestamp': String(fresh), 'x-slack-signature': sign(fresh, raw) } });
  assert.equal(await slackSignatureOk(r2, raw, SECRET, now), true);
});
