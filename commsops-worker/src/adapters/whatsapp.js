// WhatsApp adapter — Meta WhatsApp Cloud API (Graph). The second channel adapter.
// Mirrors the email contract:
//   send(rendered, env)          → {provider_message_id, status, reason, cost?, raw}
//   parseStatusWebhook(payload)  → [{provider_message_id, canonical_status, engagement_event, at, reason, cost?, to, phone_number_id}]
//   parseInbound(payload)        → [{provider_message_id, from, wa_id, name, text, type, media?, ts, phone_number_id}]
//
// Two send modes, decided upstream by renderWhatsapp:
//   template — {mode:'template', template:{name, language, components}} — valid ANY time.
//   text     — {mode:'text', text} — free-form; valid ONLY inside the 24h customer window.
//              The adapter refuses text unless rendered.window_open === true (belt-and-braces;
//              gate.js also blocks it, so a bug in either layer still can't leak a window-closed text).
//
// Rendered carries the routing bits send.js copies off the sender identity:
//   rendered.to (E.164, no '+'), rendered.phone_number_id, rendered.window_open.

const WAM = require('../wa-media.js');   // send-time media ids (131053 fix)
const GATE = require('../gate.js');      // settings (the wa_media_id_enabled flag)

const GRAPH_VERSION = 'v21.0';

function graphBase(env) {
  return `https://graph.facebook.com/${env.WA_GRAPH_VERSION || GRAPH_VERSION}`;
}

// E.164 for the Graph `to` field: digits only, no leading '+'.
function toWaId(to) {
  return String(to || '').replace(/[^\d]/g, '');
}

async function send(rendered, env) {
  const to = toWaId(rendered.to);
  const phoneId = rendered.phone_number_id;
  if (!to) return { provider_message_id: null, status: 'failed', reason: 'no_recipient' };
  if (!phoneId) return { provider_message_id: null, status: 'failed', reason: 'no_phone_number_id' };
  if (!env.WA_TOKEN) return { provider_message_id: null, status: 'failed', reason: 'no_wa_token' };

  let payload;
  if (rendered.mode === 'template') {
    const t = rendered.template || {};
    if (!t.name) return { provider_message_id: null, status: 'failed', reason: 'no_template_name' };
    // MEDIA HEADER: prefer a Meta-hosted media id over a link Meta must fetch per send.
    // A `link` header makes Meta download the asset on EVERY send, and that download fails
    // ASYNCHRONOUSLY (131053) — the API returns 200 + a wamid, then the status webhook flips the
    // message to failed, so there is nothing to retry and the message is simply lost. Measured
    // 2026-07-29: 4 of 113 Order Placed sends, i.e. real order confirmations.
    //
    // Gated on `settings.wa_media_id_enabled` (default FALSE) because this is a live
    // transactional path and the Meta upload cannot be exercised from a test run. Every failure
    // inside applyMediaIds returns the components untouched, so with the flag on and the upload
    // broken the behaviour is exactly today's link send — never worse.
    let components = Array.isArray(t.components) ? t.components : [];
    try {
      const s = await GATE.getSettings(env);
      if (s?.wa_media_id_enabled === true) components = await WAM.applyMediaIds(env, components, phoneId);
    } catch { /* flag/settings unreadable → keep the link path */ }
    payload = {
      messaging_product: 'whatsapp', to, type: 'template',
      template: {
        name: t.name,
        language: { code: t.language || 'en' },
        ...(components.length ? { components } : {}),
      },
    };
  } else if (rendered.mode === 'interactive') {
    // Interactive reply-buttons, free-form (NOT a template) — the second-step confirm that a
    // COD→prepaid cancel branch needs ("Are you sure?" → Yes / No). Same 24h-window rule as
    // text: it is a session message, so the customer must have messaged us first — which in
    // a journey they always have, by tapping the button on the step before.
    //
    // Meta caps this at THREE buttons, 20 chars of title each, and requires a stable `id`
    // per button: that id is what comes back on `interactive.button_reply.id`, and it is what
    // the journey graph routes on. Titles are truncated rather than rejected — a silent
    // 400 from Meta mid-journey is worse than a clipped label.
    if (rendered.window_open !== true)
      return { provider_message_id: null, status: 'skipped', reason: 'window_closed' };
    const bodyText = rendered.text;
    const btns = Array.isArray(rendered.buttons) ? rendered.buttons.slice(0, 3) : [];
    if (!bodyText) return { provider_message_id: null, status: 'failed', reason: 'empty_text' };
    if (!btns.length) return { provider_message_id: null, status: 'failed', reason: 'interactive_no_buttons' };
    payload = {
      messaging_product: 'whatsapp', to, type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: bodyText },
        action: {
          buttons: btns.map((b, i) => ({
            type: 'reply',
            reply: { id: String(b.id || b.text || `btn_${i}`).slice(0, 256),
                     title: String(b.text || b.id || `Option ${i + 1}`).slice(0, 20) },
          })),
        },
      },
    };
  } else {
    // free-form text — only inside the 24h window
    if (rendered.window_open !== true)
      return { provider_message_id: null, status: 'skipped', reason: 'window_closed' };
    const bodyText = rendered.text;
    if (!bodyText) return { provider_message_id: null, status: 'failed', reason: 'empty_text' };
    payload = {
      messaging_product: 'whatsapp', to, type: 'text',
      text: { preview_url: rendered.preview_url !== false, body: bodyText },
    };
  }

  let res, data;
  try {
    res = await fetch(`${graphBase(env)}/${phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.WA_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    data = await res.json().catch(() => ({}));
  } catch (e) {
    return { provider_message_id: null, status: 'failed', reason: `wa_fetch_error:${e?.message || e}`, raw: null };
  }

  if (!res.ok) {
    const g = data?.error || {};
    // 131047 = re-engagement outside window, 131026 = undeliverable, 132000 = template mismatch, etc.
    return {
      provider_message_id: null, status: 'failed',
      reason: g.code ? `wa_${g.code}:${g.message || ''}`.slice(0, 200) : `wa_http_${res.status}`,
      raw: data,
    };
  }
  return {
    provider_message_id: data?.messages?.[0]?.id || null,
    status: 'sent',
    reason: null,
    raw: data,
  };
}

// ── Status webhook (delivery receipts) ──
// Cloud API status → our canonical message status.
const STATUS_MAP = { sent: 'sent', delivered: 'delivered', read: 'opened', failed: 'failed' };
// status → emitted engagement event name (for the events stream), or null.
const EVENT_MAP = { delivered: 'whatsapp_delivered', read: 'whatsapp_read' };

// A WA webhook envelope may batch many changes; each change.value carries statuses[] and/or messages[].
function eachChangeValue(payload) {
  const out = [];
  for (const entry of payload?.entry || []) {
    for (const ch of entry?.changes || []) {
      if (ch?.value) out.push(ch.value);
    }
  }
  return out;
}

function parseStatusWebhook(payload) {
  const updates = [];
  for (const value of eachChangeValue(payload)) {
    for (const s of value.statuses || []) {
      const canonical = STATUS_MAP[s.status] || null;
      if (!canonical) continue;
      // per-conversation billing lands on the status webhook's pricing object.
      // Billable means Meta SAID billable. category-presence is not a price signal —
      // {billable:false, category:'service'} is every free service-window message, i.e. most
      // of the support number's traffic (review H4). Absent billable = unpriced (tri-state).
      const priced = s.pricing?.billable === true;
      updates.push({
        provider_message_id: s.id || null,
        canonical_status: canonical,
        engagement_event: EVENT_MAP[s.status] || null,
        at: s.timestamp ? new Date(Number(s.timestamp) * 1000).toISOString() : new Date().toISOString(),
        reason: s.status === 'failed'
          ? (s.errors?.[0]?.code ? `wa_${s.errors[0].code}:${s.errors[0].title || ''}`.slice(0, 200) : 'failed')
          : null,
        cost: priced ? 1 : null,               // conversation count (Meta bills per conversation, not per message)
        pricing: s.pricing || null,
        to: s.recipient_id || null,
        // Which of our numbers sent it — needed to invalidate that number's media cache on a
        // media error (a Meta media id is only valid for the phone number that uploaded it).
        phone_number_id: value?.metadata?.phone_number_id || null,
      });
    }
  }
  return updates;
}

// ── Inbound (customer messages) ──
// Normalize to the contract Pitstop's csops handler consumes. One row per inbound message.
function parseInbound(payload) {
  const inbound = [];
  for (const value of eachChangeValue(payload)) {
    const phoneId = value?.metadata?.phone_number_id || null;
    const contacts = value?.contacts || [];
    const nameFor = (waId) => contacts.find((c) => c.wa_id === waId)?.profile?.name || null;
    for (const m of value.messages || []) {
      if (!m || m.type === undefined) continue;
      const base = {
        provider_message_id: m.id || null,
        from: m.from || null,
        wa_id: m.from || null,
        name: nameFor(m.from),
        type: m.type,
        ts: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : new Date().toISOString(),
        phone_number_id: phoneId,
        text: null,
        media: null,
        button_id: null,
      };
      if (m.type === 'text') base.text = m.text?.body || '';
      else if (m.type === 'button') {
        // Template quick-reply tap. `payload` is the postback we set at send time via a
        // {component:'button', sub_type:'quick_reply', param_type:'payload'} mapping slot;
        // when the template is sent WITHOUT a payload parameter Meta echoes the button
        // LABEL as the payload. Fall back to `text` so both shapes yield a branchable id.
        base.text = m.button?.text || '';
        base.button_id = m.button?.payload || m.button?.text || null;
      } else if (m.type === 'interactive') {
        // Free-form interactive message tap (24h window only) — id is author-defined.
        const r = m.interactive?.button_reply || m.interactive?.list_reply || null;
        base.text = r?.title || '';
        base.button_id = r?.id || null;
      } else if (['image', 'video', 'audio', 'document', 'sticker'].includes(m.type)) {
        const media = m[m.type] || {};
        base.media = { id: media.id || null, mime_type: media.mime_type || null, caption: media.caption || null, filename: media.filename || null };
        base.text = media.caption || '';
      }
      inbound.push(base);
    }
  }
  return inbound;
}

module.exports = { send, parseStatusWebhook, parseInbound, toWaId };
