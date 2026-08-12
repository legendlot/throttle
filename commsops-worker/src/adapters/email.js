// Email adapter — Resend. The ONLY channel-specific send code in v1.
// Contract: send(rendered,env) → {provider_message_id,status,raw};
//           parseStatusWebhook(payload) → [{provider_message_id,canonical_status,at,reason}].

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

module.exports = { send, parseStatusWebhook, bounceReason, BOUNCE_REASON };
