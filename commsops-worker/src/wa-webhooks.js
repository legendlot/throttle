// WhatsApp Cloud API webhook — the inbound + status + quality seam (M14 / WS-A.5).
//   GET  /webhooks/whatsapp  → Meta subscription verification (hub.challenge).
//   POST /webhooks/whatsapp  → statuses (delivery receipts) + inbound customer messages
//                              + template-status / phone-quality updates.
// Signed with X-Hub-Signature-256 (HMAC-SHA256 over the raw body, keyed by WA_APP_SECRET).
//
// Inbound customer messages do THREE things:
//   1. upsert comms.wa_windows (opens the 24h free-form reply window),
//   2. emit a whatsapp_inbound event via /ingest (resolves/creates the profile — substrate),
//   3. forward the normalized payload to csops (Pitstop owns the inbox conversation).
// (3) is best-effort — a csops outage never drops the substrate write or 500s Meta.

const A = require('./auth.js');
const wa = require('./adapters/whatsapp.js');
const { ingest } = require('./ingest.js');
const AL = require('./alerts.js');

// ── signature ──
function hexHmacKey(secret) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}
function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function verifySignature(secret, header, rawBody) {
  if (!header) return false;
  const key = await hexHmacKey(secret);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const expected = `sha256=${toHex(mac)}`;
  // constant-time-ish compare
  if (header.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < header.length; i++) diff |= header.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

// GET verification handshake. Returns {challenge} on success or null.
function verifyWhatsappWebhook(env, url) {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  if (mode === 'subscribe' && env.WA_VERIFY_TOKEN && token === env.WA_VERIFY_TOKEN) return challenge || '';
  return null;
}

// forward normalized inbound to Pitstop (csops). Best-effort, never throws.
async function forwardToCsops(env, messages) {
  if (!env.CSOPS_WA_FORWARD_URL || !env.CSOPS_WA_FORWARD_TOKEN || !messages.length) return;
  try {
    await fetch(env.CSOPS_WA_FORWARD_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.CSOPS_WA_FORWARD_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'relay_whatsapp', messages }),
    });
  } catch (e) { console.log('wa_forward_error', e?.message || String(e)); }
}

async function handleStatuses(env, payload) {
  const updates = wa.parseStatusWebhook(payload);
  for (const u of updates) {
    if (!u.provider_message_id) continue;
    const m = await A.sbComms(
      `/rest/v1/messages?provider=eq.whatsapp&provider_message_id=eq.${A.enc(u.provider_message_id)}` +
      `&select=id,profile_id,channel,to_address&limit=1`, env);
    const msg = m.ok ? m.data?.[0] : null;
    if (msg && u.canonical_status) {
      const patch = { status: u.canonical_status, provider_status: u.canonical_status };
      if (u.canonical_status === 'delivered') patch.delivered_at = u.at;
      if (u.canonical_status === 'opened') patch.read_at = u.at;    // WA 'read' → our canonical 'opened'
      if (u.reason) patch.reason = u.reason;
      if (u.cost != null) patch.cost = u.cost;
      await A.sbComms(`/rest/v1/messages?id=eq.${A.enc(msg.id)}`, env,
        { method: 'PATCH', body: JSON.stringify(patch) });
    }
    if (msg?.profile_id && u.engagement_event) {
      await A.sbComms('/rest/v1/events', env, {
        method: 'POST',
        headers: { Prefer: 'resolution=ignore-duplicates' },
        body: JSON.stringify({
          profile_id: msg.profile_id, name: u.engagement_event, occurred_at: u.at,
          source: 'whatsapp_webhook',
          properties: { provider_message_id: u.provider_message_id, message_id: msg.id, channel: 'whatsapp' },
          idempotency_key: `wa:${u.canonical_status}:${u.provider_message_id}`,
        }),
      });
    }
  }
  return updates.length;
}

async function handleInbound(env, payload) {
  const inbound = wa.parseInbound(payload);
  for (const m of inbound) {
    if (!m.from) continue;
    // 1. open the 24h window
    await A.sbComms('/rest/v1/wa_windows?on_conflict=identifier_value', env, {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ identifier_value: m.from, last_inbound_at: m.ts, updated_at: new Date().toISOString() }),
    });
    // 2. substrate — resolve/create profile + append the inbound event
    await ingest(env, {
      identifiers: [{ type: 'phone', value: `+${wa.toWaId(m.from)}` }],
      name: 'whatsapp_inbound',
      occurred_at: m.ts,
      source: 'whatsapp_webhook',
      idempotency_key: m.provider_message_id ? `wa:inbound:${m.provider_message_id}` : undefined,
      properties: { channel: 'whatsapp', text: m.text, type: m.type, phone_number_id: m.phone_number_id,
                    name: m.name, media: m.media, provider_message_id: m.provider_message_id },
    }).catch((e) => console.log('wa_ingest_error', e?.message || String(e)));
  }
  // 3. hand the conversation to Pitstop
  await forwardToCsops(env, inbound);
  return inbound.length;
}

// template-status + phone-quality updates → write sender metadata + alert on a drop.
async function handleMeta(env, payload) {
  let touched = 0;
  for (const entry of payload?.entry || []) {
    for (const ch of entry?.changes || []) {
      const f = ch?.field; const v = ch?.value || {};
      if (f === 'message_template_status_update') {
        touched++;
        // reflect approval status onto the local template mirror if we can key it
        if (v.message_template_name) {
          await A.sbComms(
            `/rest/v1/templates?channel=eq.whatsapp&content->>meta_name=eq.${A.enc(v.message_template_name)}`, env,
            { method: 'PATCH', body: JSON.stringify({ approval_status: v.event || v.new_template_status || null,
              updated_at: new Date().toISOString() }) }).catch(() => {});
        }
        if (v.event && /REJECTED|DISABLED|PAUSED/i.test(v.event))
          await AL.alert(env, `⚠️ *Relay WA template ${v.event}* — \`${v.message_template_name || '?'}\` (reason: ${v.reason || 'n/a'})`);
      } else if (f === 'phone_number_quality_update') {
        touched++;
        await AL.alert(env, `⚠️ *Relay WA quality change* — number ${v.display_phone_number || '?'}: ${v.event || v.current_limit || 'updated'}`);
      }
    }
  }
  return touched;
}

async function handleWhatsappWebhook(env, request) {
  // Inert until configured: without the app secret we cannot verify Meta's signature, so the
  // route must reject rather than process unsigned payloads (which reach /ingest + the forward).
  if (!env.WA_APP_SECRET) return { ok: false, error: 'wa_not_configured', status: 503 };
  const raw = await request.text();
  const okSig = await verifySignature(env.WA_APP_SECRET, request.headers.get('x-hub-signature-256'), raw).catch(() => false);
  if (!okSig) return { ok: false, error: 'bad_signature', status: 401 };
  let payload; try { payload = JSON.parse(raw); } catch { return { ok: false, error: 'bad_json', status: 400 }; }
  if (payload?.object !== 'whatsapp_business_account') return { ok: true, ignored: true };

  const statuses = await handleStatuses(env, payload);
  const inbound = await handleInbound(env, payload);
  const meta = await handleMeta(env, payload);
  return { ok: true, statuses, inbound, meta };
}

module.exports = { handleWhatsappWebhook, verifyWhatsappWebhook, verifySignature };
