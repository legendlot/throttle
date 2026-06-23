/**
 * maintainer-trigger — LOT Maintainer event trigger + burst/single-flight coordinator
 * maintainer-trigger.afshaan.workers.dev
 *
 * Fires the LOT Maintainer routine when a message lands in #bugs or #system-updates,
 * via Slack's Events API → the routine's "Call via API" Fire URL. A Durable Object
 * coordinates so that:
 *   1) a BURST of messages collapses into ONE fire (a 5-minute collection window), and
 *   2) only ONE run is ever in flight (single-flight). Messages that arrive during a run
 *      are queued and fired the moment the run signals completion to /done.
 *
 * WHY a Worker at all: Slack Workflow Builder's only message trigger forces a mandatory
 * keyword filter, which would silently miss photo-only / free-form bug reports. The Events
 * API delivers EVERY message with no keyword constraint. See ops/EVENT_TRIGGER_SETUP.md.
 *
 * WHY a Durable Object: a stateless Worker can't "wait 5 minutes" or remember whether a run
 * is active. A DO gives consistent state + an Alarm (the timer). It is the single coordinator
 * (one named instance, "maintainer-singleton").
 *
 * The "loop completer": the routine has no native completion callback, so we build one — at
 * end-of-run the Maintainer POSTs /done (bearer DONE_TOKEN). That releases the single-flight
 * lock and fires any batch that queued during the run. A safety LEASE (see below) releases the
 * lock even if /done never arrives (crashed/timed-out run), so it can never deadlock; the hourly
 * cron on the routine is the final backstop underneath everything.
 *
 * Secrets (wrangler secret put): SLACK_SIGNING_SECRET, ROUTINE_FIRE_URL, ROUTINE_TOKEN, DONE_TOKEN.
 *
 * Slack app ("Claude Bug fetcher") → Event Subscriptions: Request URL = this worker, bot event
 * message.channels (scope channels:history), app in #bugs + #system-updates.
 */

// Channels we watch (public — already in CLAUDE.md / the repo).
const BUGS   = 'C0B6HUJ0F2T'; // #bugs
const SYSUPD = 'C0B7U98JP5E'; // #system-updates
const WATCH  = new Set([BUGS, SYSUPD]);

// Message subtypes we DROP (edits, deletes, channel-system events, bot posts).
// We deliberately ALLOW `undefined` (plain message), `file_share` (photo bug reports —
// the key case!) and `thread_broadcast` (a thread reply also sent to the channel).
const DROP_SUBTYPES = new Set([
  'message_changed', 'message_deleted', 'bot_message', 'channel_join', 'channel_leave',
  'channel_topic', 'channel_purpose', 'channel_name', 'channel_archive', 'channel_unarchive',
]);

const WINDOW_MS = 5 * 60 * 1000;   // burst collection window: collect for 5 min, then fire once
const LEASE_MS  = 30 * 60 * 1000;  // single-flight safety lease — auto-release if /done never comes

// ── Entry Worker ────────────────────────────────────────────────────────────
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    // Run-completion callback from the routine (the "loop completer").
    if (url.pathname === '/done' && req.method === 'POST') {
      if (!env.DONE_TOKEN) return new Response('done auth not configured', { status: 503 });
      if ((req.headers.get('authorization') || '') !== `Bearer ${env.DONE_TOKEN}`) {
        return new Response('unauthorized', { status: 401 });
      }
      await coordinator(env).fetch('https://do/done', { method: 'POST' });
      return new Response('ok', { status: 200 });
    }

    if (req.method !== 'POST') return new Response('maintainer-trigger ok', { status: 200 });

    const raw = await req.text();

    // Verify the Slack signature before trusting anything in the body.
    if (!(await verifySlackSignature(env.SLACK_SIGNING_SECRET, req.headers, raw))) {
      return new Response('bad signature', { status: 401 });
    }

    let body;
    try { body = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }

    // Slack URL-verification handshake (once, when you set the Request URL).
    if (body.type === 'url_verification') return json({ challenge: body.challenge });

    // Event callback. Ignore Slack retries (single-flight makes a double harmless, but skip churn).
    if (body.type === 'event_callback' && !req.headers.get('x-slack-retry-num')) {
      const e = body.event || {};
      const relevant =
        e.type === 'message' &&
        WATCH.has(e.channel) &&
        !e.bot_id &&                          // drop bot posts (incl. the Maintainer's own replies)
        !e.app_id &&
        !DROP_SUBTYPES.has(e.subtype || '');  // keep plain + file_share + thread replies
      if (relevant) ctx.waitUntil(coordinator(env).fetch('https://do/notify', { method: 'POST' }));
    }

    // Always ack fast (<3s) so Slack doesn't retry/disable the subscription.
    return new Response('ok', { status: 200 });
  },
};

function coordinator(env) {
  return env.COORDINATOR.get(env.COORDINATOR.idFromName('maintainer-singleton'));
}

// ── The coordinator Durable Object ───────────────────────────────────────────
// State (storage keys):
//   leaseUntil : epoch ms a run holds the single-flight lock until (0 = no run active)
//   fireOwed   : a fire is pending (a message arrived that hasn't been fired yet)
// The single Alarm is the timer: it ends a collection window, or (post-fire) acts as the
// lease-expiry safety re-check.
export class MaintainerCoordinator {
  constructor(state, env) { this.state = state; this.env = env; }

  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/notify') return this.onNotify();
    if (path === '/done')   return this.onDone();
    return new Response('ok');
  }

  async active(now) { return ((await this.state.storage.get('leaseUntil')) || 0) > now; }

  // A message arrived → a fire is owed. If idle and no window open yet, open a 5-min window.
  // If a run is active, the owed flag rides until the run finishes (/done) or the lease lapses.
  async onNotify() {
    const now = Date.now();
    await this.state.storage.put('fireOwed', true);
    if (!(await this.active(now)) && (await this.state.storage.getAlarm()) == null) {
      await this.state.storage.setAlarm(now + WINDOW_MS);
    }
    return new Response('ok');
  }

  // Run finished → release the lock + cancel its safety alarm. If messages queued during the
  // run, fire that batch immediately (the "fire the next batch when the previous completes").
  async onDone() {
    await this.state.storage.put('leaseUntil', 0);
    await this.state.storage.deleteAlarm();
    if (await this.state.storage.get('fireOwed')) await this.fireNow(Date.now());
    return new Response('ok');
  }

  async alarm() {
    const now = Date.now();
    if (await this.active(now)) {           // a run is still in flight — wait for it
      const lease = (await this.state.storage.get('leaseUntil')) || 0;
      await this.state.storage.setAlarm(lease + 1000);   // re-check just after the lease would lapse
      return;
    }
    if (!(await this.state.storage.get('fireOwed'))) return;  // nothing pending (spent safety alarm)
    await this.fireNow(now);                // window elapsed (or lease lapsed) → fire the batch
  }

  // Take the single-flight lock and fire. Sets a safety alarm at lease-expiry so a crashed run
  // (one that never calls /done) still releases + drains any newly-owed messages.
  async fireNow(now) {
    await this.state.storage.put('fireOwed', false);
    await this.state.storage.put('leaseUntil', now + LEASE_MS);
    await this.state.storage.setAlarm(now + LEASE_MS + 1000);
    await fireRoutine(this.env);
  }
}

// ── Fire the routine (fire-and-forget; cron backstops a failure) ─────────────
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
      // The routine ignores the payload (fire = wake signal) and sweeps from its watermark.
      body: JSON.stringify({
        text: 'Fired by a Slack event (debounced) — new messages in #bugs/#system-updates. Sweep from the watermark and triage as a set per ops/maintainer.md. POST /done on this worker when the run is complete.',
      }),
    });
  } catch (_) { /* cron backstops */ }
}

// ── Slack request-signature verification (HMAC-SHA256, 5-min replay window) ──
async function verifySlackSignature(secret, headers, rawBody) {
  if (!secret) return false;
  const ts  = headers.get('x-slack-request-timestamp');
  const sig = headers.get('x-slack-signature');
  if (!ts || !sig) return false;

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
