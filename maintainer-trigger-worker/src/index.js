/**
 * maintainer-trigger — LOT Maintainer event trigger
 * maintainer-trigger.afshaan.workers.dev
 *
 * Fires the LOT Maintainer routine the instant a message lands in #bugs or
 * #system-updates, via Slack's Events API → the routine's "Call via API" Fire URL.
 *
 * WHY this exists: Slack Workflow Builder's only message trigger forces a keyword
 * filter, which would silently miss photo-only / free-form bug reports (most of #bugs).
 * The Events API delivers EVERY message with no keyword constraint, so this little
 * relay is the catch-all instant trigger. The hourly cron on the routine stays as the
 * backstop in case Slack ever drops an event — so a missed webhook just means ≤1h, not
 * a lost bug. See ops/EVENT_TRIGGER_SETUP.md + ops/maintainer.md.
 *
 * Flow:  Slack event → verify signature → drop bot/self/system messages →
 *        fire-and-forget POST to the routine (its own debounce + single-flight +
 *        watermark collapse a burst into one cheap run). Always ack 200 in <3s.
 *
 * Secrets (wrangler secret put): SLACK_SIGNING_SECRET, ROUTINE_FIRE_URL, ROUTINE_TOKEN.
 *
 * Slack app setup (api.slack.com/apps → LOT app → Event Subscriptions):
 *   Request URL = https://maintainer-trigger.afshaan.workers.dev   (Slack verifies live)
 *   Subscribe to bot event: message.channels   (app must be in #bugs + #system-updates)
 */

// Channels we watch (public — already in CLAUDE.md / the repo).
const BUGS    = 'C0B6HUJ0F2T'; // #bugs
const SYSUPD  = 'C0B7U98JP5E'; // #system-updates
const WATCH   = new Set([BUGS, SYSUPD]);

// Message subtypes we DROP (edits, deletes, channel-system events, bot posts).
// NOTE: we deliberately ALLOW `undefined` (plain message), `file_share` (photo bug
// reports — the key case!) and `thread_broadcast` (a thread reply also sent to channel).
const DROP_SUBTYPES = new Set([
  'message_changed', 'message_deleted', 'bot_message', 'channel_join', 'channel_leave',
  'channel_topic', 'channel_purpose', 'channel_name', 'channel_archive', 'channel_unarchive',
]);

export default {
  async fetch(req, env, ctx) {
    if (req.method !== 'POST') return new Response('maintainer-trigger ok', { status: 200 });

    const raw = await req.text();

    // 1) Verify the Slack signature before trusting anything in the body.
    if (!(await verifySlackSignature(env.SLACK_SIGNING_SECRET, req.headers, raw))) {
      return new Response('bad signature', { status: 401 });
    }

    let body;
    try { body = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }

    // 2) Slack URL-verification handshake (fired once when you set the Request URL).
    if (body.type === 'url_verification') {
      return json({ challenge: body.challenge });
    }

    // 3) Event callback. Ignore Slack's retries (a fire already happened on the original;
    //    single-flight makes a double-fire harmless, but skipping retries avoids the churn).
    if (body.type === 'event_callback' && !req.headers.get('x-slack-retry-num')) {
      const e = body.event || {};
      const fire =
        e.type === 'message' &&
        WATCH.has(e.channel) &&
        !e.bot_id &&                          // drop bot posts (incl. the Maintainer's own replies)
        !e.app_id &&                          // belt-and-suspenders for app-posted messages
        !DROP_SUBTYPES.has(e.subtype || '');  // keep plain + file_share + thread replies
      if (fire) ctx.waitUntil(fireRoutine(env));
    }

    // 4) Always ack fast (<3s) so Slack doesn't retry/disable the subscription.
    return new Response('ok', { status: 200 });
  },
};

// Fire-and-forget POST to the routine's API trigger. Failures are swallowed — the
// hourly cron is the backstop, so a dropped fire degrades to ≤1h, never a lost bug.
async function fireRoutine(env) {
  if (!env.ROUTINE_FIRE_URL || !env.ROUTINE_TOKEN) return;
  try {
    await fetch(env.ROUTINE_FIRE_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.ROUTINE_TOKEN}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'experimental-cc-routine-2026-04-01',
        'content-type': 'application/json',
      },
      // The routine ignores the payload (fire = wake signal, not a task) and sweeps
      // from its watermark. A static framing line keeps a stray message from being read
      // as a directive (also a mild prompt-injection guard).
      body: JSON.stringify({
        text: 'Fired by a Slack event — new message in #bugs/#system-updates. Sweep from the watermark and triage as a set per ops/maintainer.md.',
      }),
    });
  } catch (_) { /* cron backstops */ }
}

// HMAC-SHA256 verification per Slack's signing spec, with a 5-minute replay window
// and a constant-time compare.
async function verifySlackSignature(secret, headers, rawBody) {
  if (!secret) return false;
  const ts  = headers.get('x-slack-request-timestamp');
  const sig = headers.get('x-slack-signature');
  if (!ts || !sig) return false;

  // Reject stale timestamps (replay protection).
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(Number(ts)) || Math.abs(now - Number(ts)) > 60 * 5) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`v0:${ts}:${rawBody}`));
  const expected = 'v0=' + [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
  return timingSafeEqual(expected, sig);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function json(obj) {
  return new Response(JSON.stringify(obj), { headers: { 'content-type': 'application/json' }, status: 200 });
}
