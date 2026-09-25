// Email adapter — Resend. The ONLY channel-specific send code in v1.
// Contract: send(rendered,env) → {provider_message_id,status,raw};
//           parseStatusWebhook(payload) → [{provider_message_id,canonical_status,at,reason}].

// ── Resend rate limiting (S337) ────────────────────────────────────────────────────────────
// ⛔ RESEND ALLOWS 10 REQUESTS/SECOND AND WE HAD NO PACING AT ALL, so campaign fan-out simply
// outran it. Measured 2026-09-03: **2,556 emails were never sent** across three campaign days
// (22 Aug 1,209 · 23 Aug 633 · 26 Aug 714), every one failing with Resend's
// "Too many requests. You can only make 10 requests per second." — one per distinct address,
// i.e. 2,556 customers silently received nothing while the campaign reported itself sent.
//
// ⚠️ WHY IT WAS MISSED: campaigns.js's SEND_CONCURRENCY was tuned entirely against WHATSAPP
// constraints — the long note there reasons about Meta 131048/130429, per-number throughput and
// Supabase capacity, and concludes "we have never once been rate-limited". That is true OF
// WHATSAPP. Email rides the same pool with a vendor ceiling two orders of magnitude tighter, and
// nothing in that analysis was ever re-run for it. A per-channel limit belongs in the channel
// adapter, not in a shared pool constant — which is why the fix lives here and protects EVERY
// email path (campaigns, journeys, transactional, test sends), not just the campaign fan-out.
//
// Pacing is per-isolate. The broadcast consumer is max_batch_size=1 and self-chains; measured
// S400 (2026-09-25), even a 6-SHARD campaign ran its chains in one isolate, so this one pacer is
// effectively campaign-wide (~8.3/s averaged across all shards). Concurrent journey/transactional
// isolates share Resend's 10/s ceiling with it, and that is where the residual 429s come from:
// the Upshift sale email still lost ~2,400 of ~88k sends (≈1.5/min at 8.5/s) to "Too many
// requests" after three ≤2s retries. S400 hardening, all here:
//   · 5 retries (was 3), 400·2^n capped 4s or Retry-After capped 5s, + 0–300ms jitter so
//     isolates rejected in the same second do not retry in the same one;
//   · a 429 sets an isolate-wide HOLD that every sender waits out — including ones already
//     sleeping toward a claimed slot — because it means the ceiling is hit, not one recipient.
// ⛔ Do NOT "fix" this by widening the slot per shard: tried in throttle 660cb84c and it cut the
// campaign from 8.5/s to 1.4/s because the shards share this pacer (campaigns.js note).
const RESEND_MIN_INTERVAL_MS = 120;      // ~8.3/s — deliberate headroom under the 10/s ceiling
const RESEND_MAX_RETRIES = 5;
let nextSlotAt = 0;
let holdUntil = 0;                       // set by a 429; every sender waits it out

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reserve the next send slot. Claiming `nextSlotAt` BEFORE awaiting is what makes this work under
// concurrency: every caller takes a distinct slot at claim time, so N concurrent senders serialise
// into an evenly spaced queue rather than all sleeping the same interval and firing together.
async function paceResend() {
  // A slot claimed BEFORE a 429 landed would otherwise fire straight into the rejection window.
  // So after waking, a sender still inside the hold RE-CLAIMS a slot — and since the 429 pushed
  // nextSlotAt to holdUntil, the re-claimed slots are spaced after the hold instead of every held
  // sender firing in the same instant when it lifts (Codex review S400 #1).
  for (;;) {
    const now = Date.now();
    const at = Math.max(now, nextSlotAt);
    nextSlotAt = at + RESEND_MIN_INTERVAL_MS;
    if (at > now) await sleep(at - now);
    if (Date.now() >= holdUntil) return;
  }
}

// Resend answers 429 for its MONTHLY QUOTA too ("You have reached your monthly email sending
// quota." — 1,652 rows on the 2026-09-25 Upshift send). That is not a rate: retrying cannot help,
// and holding the isolate would stall every journey/transactional email behind a wall that will
// not move today (hostile review S400 #3). Fail it at once, with Resend's own reason.
const isQuota429 = (data) => /quota/i.test(`${data?.name || ''} ${data?.message || ''}`);

// Wait after a 429. Retry-After when Resend sends one, else exponential; capped so one recipient
// can never stall a campaign page past the invocation budget (5 retries: ≤ ~27s with Retry-After,
// ~12s without, plus pacing — a 75-recipient page stays far inside the 15-min consumer limit), plus
// 0–300ms jitter so six shards that were rejected in the same second do not retry in the same one.
function backoffMs(attempt, retryAfterHeader, rand = Math.random) {
  const ra = Number(retryAfterHeader);
  const base = Number.isFinite(ra) && ra > 0
    ? Math.min(ra * 1000, 5000)
    : Math.min(400 * (2 ** attempt), 4000);
  return base + Math.floor(rand() * 300);
}

async function send(rendered, env) {
  const body = {
    from: rendered.from,                    // "Legend of Toys <hello@comms.legendoftoys.com>"
    to: Array.isArray(rendered.to) ? rendered.to : [rendered.to],
    subject: rendered.subject,
    html: rendered.html,
  };
  if (rendered.text) body.text = rendered.text;
  if (rendered.reply_to) body.reply_to = rendered.reply_to;
  if (rendered.unsubscribe_url) {
    body.headers = {
      'List-Unsubscribe': `<${rendered.unsubscribe_url}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    };
  }
  let res, data;
  for (let attempt = 0; ; attempt++) {
    await paceResend();
    try {
      res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      data = await res.json().catch(() => ({}));
    } catch (e) {
      // A network failure must surface as a failed RESULT — a throw here escapes send() with no
      // messages row and (pre-Task-1) a permanently burned dedup key (review H2).
      return { provider_message_id: null, status: 'failed',
               reason: `resend_network:${String(e?.message || e).slice(0, 140)}`, raw: null };
    }
    // 429 is RETRYABLE and used to be recorded as a permanent failure — that is how 2,556 sends
    // became 2,556 customers who got nothing. Retry a bounded number of times, honouring
    // Retry-After when Resend sends it, then fall through and report the failure honestly.
    if (res.status !== 429 || isQuota429(data)) break;
    const waitMs = backoffMs(attempt, res.headers.get('retry-after'));
    // Push the shared slot back too: a 429 means the CEILING is hit, not this one recipient, so
    // the other pool workers in this isolate must stop claiming slots for the same window —
    // otherwise they fire straight into the same rejection while this one waits. Set on EVERY
    // rate 429, including this recipient's last one (Codex review S400 #2: the final 429 used to
    // break out first and leave the others unwarned).
    holdUntil = Math.max(holdUntil, Date.now() + waitMs);
    nextSlotAt = Math.max(nextSlotAt, holdUntil);
    if (attempt >= RESEND_MAX_RETRIES) break;
    await sleep(waitMs);
  }
  return {
    provider_message_id: data?.id || null,
    status: res.ok ? 'sent' : 'failed',
    reason: res.ok ? null : (data?.message || data?.name || `resend_${res.status}`),
    raw: data,
  };
}

// Resend webhook event.type → our canonical message status.
const STATUS_MAP = {
  'email.sent': 'sent',
  'email.delivered': 'delivered',
  'email.delivery_delayed': 'sent',
  'email.opened': 'opened',
  'email.clicked': 'clicked',
  'email.bounced': 'bounced',
  'email.complained': 'failed',
};
// Resend event.type → emitted engagement event name (for the events stream), or null.
const EVENT_MAP = {
  'email.delivered': 'email_delivered',
  'email.opened': 'email_opened',
  'email.clicked': 'link_clicked',   // channel-agnostic click primitive (SMS/WA reuse it via the Phase-B redirect)
  'email.bounced': 'email_bounced',
  'email.complained': 'opted_out',
};

// A bounce is NOT automatically permanent, and treating it as one is expensive.
//
// ⚠️ This read `reason: 'hard_bounce'` for EVERY `email.bounced` until 2026-08-12, discarding
// Resend's own `data.bounce.type`. The handler suppresses on `hard_bounce`, and per gate.js
// suppression is the ONE gate transactional/utility cannot bypass — so a customer whose inbox
// was momentarily FULL was permanently cut off from order confirmations and shipping updates
// on the strength of one marketing send. Observed live: `akshaabbasi2329@gmail.com` suppressed
// 2026-08-11 on a bounce whose payload said `type: "Transient"`, `subType: "MailboxFull"`, with
// Resend's own message reading "you might be able to send to the same recipient in the future".
//
// SES/Resend bounce types: Permanent (mailbox does not exist — genuinely dead) · Transient
// (full/throttled/deferred — retryable) · Undetermined. **Only Permanent suppresses.**
// Undetermined deliberately does NOT: one ambiguous bounce is far weaker evidence than the cost
// of silently losing a real customer's transactional mail.
const BOUNCE_REASON = { Permanent: 'hard_bounce', Transient: 'soft_bounce', Undetermined: 'undetermined_bounce' };

function bounceReason(payload) {
  const t = payload?.data?.bounce?.type;
  // Unknown/absent → treat as undetermined, never as permanent. A shape change on the vendor
  // side must fail toward keeping the customer reachable, not toward silently dropping them.
  return BOUNCE_REASON[t] || 'undetermined_bounce';
}

function parseStatusWebhook(payload) {
  const type = payload?.type;
  const pmid = payload?.data?.email_id || payload?.data?.id || null;
  if (!type || !pmid) return [];
  const b = payload?.data?.bounce || null;
  return [{
    provider_message_id: pmid,
    canonical_status: STATUS_MAP[type] || null,
    engagement_event: EVENT_MAP[type] || null,
    at: payload?.created_at || new Date().toISOString(),
    reason: type === 'email.bounced' ? bounceReason(payload)
          : type === 'email.complained' ? 'complaint' : null,
    // Persisted onto messages.reason so a bounce is diagnosable from the DB alone. It was NULL
    // on all 7 suppressed rows, so classifying them after the fact needed a payload pasted out
    // of the Resend dashboard — which is not a process.
    bounce_type: b?.type || null,
    bounce_subtype: b?.subType || null,
    to: payload?.data?.to?.[0] || null,
    clicked_url: type === 'email.clicked' ? (payload?.data?.click?.link || null) : null,
  }];
}

module.exports = { send, parseStatusWebhook, bounceReason, BOUNCE_REASON, backoffMs,
  _resetPacing: () => { nextSlotAt = 0; holdUntil = 0; } };
