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
const { detectOptOut, applyOptOut } = require('./optout.js');
const AL = require('./alerts.js');
const WAM = require('./wa-media.js');   // media-id cache invalidation on a 131052/131053

// Canonical message status is monotonic — an out-of-order webhook must never regress it
// (e.g. a late 'delivered' arriving after 'read'/'opened' — review M6). Deliberately
// duplicated in webhooks.js (the Resend status handler): the two files share no util
// module and this guard is tiny enough not to warrant one.
const STATUS_RANK = { queued: 0, sent: 1, delivered: 2, opened: 3, clicked: 4, bounced: 9, failed: 9, suppressed: 9, skipped: 9 };
const isUpgrade = (from, to) => (STATUS_RANK[to] ?? 0) >= (STATUS_RANK[from] ?? 0) || (STATUS_RANK[to] ?? 0) >= 9;

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
  if (!env.CSOPS_WA_FORWARD_TOKEN || !messages.length) return;
  const init = {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CSOPS_WA_FORWARD_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'relay_whatsapp', messages }),
  };
  try {
    // Prefer the service binding. A plain fetch() to csops.workers.dev is the SAME workers.dev
    // zone, which Cloudflare refuses with error 1042 — and because this function swallows its
    // errors, that failure would be invisible: every inbound customer message would silently
    // never reach Pitstop. The URL path stays only as a dev/self-hosted fallback.
    const res = env.CSOPS && typeof env.CSOPS.fetch === 'function'
      ? await env.CSOPS.fetch(new Request('https://internal/webhooks/relay-wa', init))
      : (env.CSOPS_WA_FORWARD_URL ? await fetch(env.CSOPS_WA_FORWARD_URL, init) : null);
    if (!res) { console.log('wa_forward_skipped', 'no CSOPS binding and no CSOPS_WA_FORWARD_URL'); return; }
    // Log a non-2xx: a dropped inbound message is a customer waiting on a reply nobody sees.
    if (!res.ok) console.log('wa_forward_failed', res.status, (await res.text()).slice(0, 160));
  } catch (e) { console.log('wa_forward_error', e?.message || String(e)); }
}

async function handleStatuses(env, payload) {
  const updates = wa.parseStatusWebhook(payload);
  for (const u of updates) {
    if (!u.provider_message_id) continue;
    const m = await A.sbComms(
      `/rest/v1/messages?provider=eq.whatsapp&provider_message_id=eq.${A.enc(u.provider_message_id)}` +
      `&select=id,profile_id,channel,to_address,status&limit=1`, env);
    const msg = m.ok ? m.data?.[0] : null;
    if (msg && u.canonical_status) {
      const patch = { status: u.canonical_status, provider_status: u.canonical_status };
      if (!isUpgrade(msg.status, u.canonical_status)) delete patch.status;   // late 'delivered' after 'read' keeps opened (review M6)
      if (u.canonical_status === 'delivered') patch.delivered_at = u.at;
      if (u.canonical_status === 'opened') patch.read_at = u.at;    // WA 'read' → our canonical 'opened'
      if (u.reason) patch.reason = u.reason;
      if (u.cost != null) patch.cost = u.cost;
      // Persist Meta's pricing verdict. This is the ONLY authoritative per-message signal for
      // whether we were charged and at what category — it was parsed and then dropped, so ₹
      // spend could never be computed. `cost` above stays a billable-MESSAGE COUNT; rupees are
      // derived at read time from comms.channel_rate_card (effective-dated, so a historical
      // send is costed at the rate in force on its send date).
      // `billable` is tri-state on purpose: absent ≠ free. Coercing a missing flag to false
      // would silently price the message at zero.
      if (u.pricing) {
        patch.pricing = u.pricing;
        patch.pricing_category = u.pricing.category || null;
        patch.billable = typeof u.pricing.billable === 'boolean' ? u.pricing.billable : null;
      }
      await A.sbComms(`/rest/v1/messages?id=eq.${A.enc(msg.id)}`, env,
        { method: 'PATCH', body: JSON.stringify(patch) });
      // A MEDIA error is the one failure that can be caused by our own cached media id going
      // bad (Meta expires uploaded media after ~30 days, and an id is only valid for the phone
      // number that uploaded it). Drop that number's cache so the next send re-uploads instead
      // of replaying a dead id. Harmless when the send used a link — the cache is then empty
      // for that number, and re-uploading is cheap. Best-effort: never fail the webhook, which
      // must 200 or Meta redelivers.
      if (typeof u.reason === 'string' && /^wa_13105[23]/.test(u.reason)) {
        await WAM.invalidate(env, u.phone_number_id || null);
      }
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
    // 1. open the 24h window — per (customer, RECEIVING business number): Meta's service
    // window is per WABA number, not per customer (review H5 part 3). m.phone_number_id is
    // the business number this inbound landed on.
    await A.sbComms('/rest/v1/wa_windows?on_conflict=identifier_value,phone_number_id', env, {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ identifier_value: m.from, phone_number_id: m.phone_number_id || '',
                             last_inbound_at: m.ts, updated_at: new Date().toISOString() }),
    });
    // 2. substrate — resolve/create profile + append the inbound event
    const res = await ingest(env, {
      identifiers: [{ type: 'phone', value: `+${wa.toWaId(m.from)}` }],
      name: 'whatsapp_inbound',
      occurred_at: m.ts,
      source: 'whatsapp_webhook',
      idempotency_key: m.provider_message_id ? `wa:inbound:${m.provider_message_id}` : undefined,
      properties: { channel: 'whatsapp', text: m.text, type: m.type, phone_number_id: m.phone_number_id,
                    name: m.name, media: m.media, provider_message_id: m.provider_message_id },
    }).catch((e) => { console.log('wa_ingest_error', e?.message || String(e)); return null; });

    // 2b. honour STOP/START. Our approved marketing templates carry "Reply STOP to
    // unsubscribe" and Meta requires opt-out requests to be respected. Marketing-only —
    // this never blocks the customer's order/shipping updates (see optout.js).
    //
    // NOT wrapped in try/catch and NOT gated on res.deduped, both deliberate:
    //  - errors must propagate so the route 500s and Meta redelivers (a swallowed error
    //    = a silently lost withdrawal, the one failure this feature exists to prevent);
    //  - a redelivery re-runs this while ingest dedups the event, which can write a second
    //    identical opted_out row. Append-only + latest-wins, so that is cosmetic.
    // parseInbound normalises button/interactive replies into m.text, so a tapped
    // "Stop promotions" button lands here too.
    const intent = detectOptOut(m.text);
    if (intent) {
      // We detected a withdrawal but could not resolve the profile — MUST NOT fall through
      // to a 200. ingest() returns {ok:false} WITHOUT profile_id on resolve_failed AND on
      // event_insert_failed (even when identity already resolved), and sbComms never throws
      // on a non-2xx, so the .catch() above cannot see either. Falling through here would
      // silently lose the STOP — the exact failure this feature exists to prevent. Throw so
      // the route 500s and Meta redelivers.
      //
      // This guard is INSIDE `if (intent)` deliberately: an ordinary inbound message whose
      // ingest fails must keep logging and continuing. Throwing for all traffic would turn
      // every transient events-insert blip into a Meta redelivery storm.
      if (!res?.profile_id) {
        throw new Error(`optout_profile_unresolved:${res?.error || 'ingest_failed'}`);
      }
      await applyOptOut(env, {
        profile_id: res.profile_id,
        channel: 'whatsapp',
        purpose: 'marketing',
        state: intent === 'opt_out' ? 'opted_out' : 'opted_in',
        source: 'whatsapp_inbound_keyword',
        evidence: {
          keyword: m.text,
          provider_message_id: m.provider_message_id || null,
          from: m.from,
          received_at: m.ts || null,
        },
      });
    }

    // 2c. WS-B — a BUTTON tap is also a journey reply signal. Emitted as its own
    // `whatsapp_reply` event (in ADDITION to whatsapp_inbound, never instead of it:
    // Pitstop's inbox, the 24h window and any inbound analytics all key off the
    // generic event, and a tap is still a real inbound message).
    //
    // ingest() runs the J1 wait matcher, so this is the entire wake path — an
    // interactive send node parked via #interactiveBranch resolves the moment this
    // lands, and #latestButtonId re-reads properties.button_id to pick the branch.
    //
    // Best-effort, mirroring the whatsapp_inbound call above: a failure here must not
    // 500 the route (Meta would redeliver and re-run the opt-out write). A missed
    // signal is not a lost branch — the interpreter's own DB pre-check re-reads the
    // event on its next transition, and the node times out to `no_reply` regardless.
    if (m.button_id) {
      await ingest(env, {
        identifiers: [{ type: 'phone', value: `+${wa.toWaId(m.from)}` }],
        name: 'whatsapp_reply',
        occurred_at: m.ts,
        source: 'whatsapp_webhook',
        idempotency_key: m.provider_message_id ? `wa:reply:${m.provider_message_id}` : undefined,
        properties: { channel: 'whatsapp', button_id: m.button_id, button_text: m.text,
                      type: m.type, phone_number_id: m.phone_number_id,
                      provider_message_id: m.provider_message_id },
      }).catch((e) => { console.log('wa_reply_ingest_error', e?.message || String(e)); return null; });
    }
  }
  // 2d. park any attachment's bytes somewhere Pitstop can actually open (S245).
  await hostInboundMedia(env, inbound);

  // 3. hand the conversation to Pitstop
  await forwardToCsops(env, inbound);
  return inbound.length;
}

// ── inbound attachments ──────────────────────────────────────────────────────
// Meta gives us a media ID, not a file: the bytes need a token-authed two-step fetch and the
// CDN URL expires within minutes. BiteSpeed used to hand Pitstop a ready-hosted Chatwoot URL,
// so without this every inbound damage photo arrives as a dead chip — the same unopenable-chip
// bug already fixed once for inbound email attachments, and support is the channel where photos
// matter most.
//
// PRIVATE bucket, deliberately: these are files customers sent US. That mirrors the
// cs-email-attachments decision rather than the public cs-inbox-media bucket, which holds
// assets WE authored. csops mints a short-lived signed URL per read.
const INBOUND_BUCKET = 'cs-wa-media';
const INBOUND_MAX_BYTES = 16 * 1024 * 1024;   // above Cloud API's largest inbound; guards Worker memory
const INBOUND_MAX_PER_BATCH = 8;              // subrequest budget — 2 fetches + 1 upload per file
const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'application/pdf': 'pdf', 'video/mp4': 'mp4', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3',
  'audio/aac': 'aac', 'audio/amr': 'amr',
};

async function hostInboundMedia(env, messages) {
  if (!env?.SUPABASE_SERVICE_ROLE_KEY || !env?.SUPABASE_URL) return;
  let handled = 0;
  for (const m of messages) {
    const id = m?.media?.id;
    if (!id) continue;
    // Every failure below is recorded on the message and then skipped. The conversation text
    // must reach Pitstop regardless — a missing photo is a degraded message, a dropped forward
    // is a customer waiting on a reply nobody can see.
    if (handled >= INBOUND_MAX_PER_BATCH) { m.media.host_error = 'batch_limit'; continue; }
    handled++;
    const got = await WAM.fetchInboundMedia(env, id);
    if (!got) { m.media.host_error = 'fetch_failed'; continue; }
    if (got.size > INBOUND_MAX_BYTES) { m.media.host_error = 'too_large'; continue; }
    const mime = String(m.media.mime_type || got.mime || '').split(';')[0].toLowerCase();
    const path = `${wa.toWaId(m.from)}/${id}.${MIME_EXT[mime] || 'bin'}`;
    try {
      const up = await fetch(`${env.SUPABASE_URL}/storage/v1/object/${INBOUND_BUCKET}/${path}`, {
        method: 'POST',
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': mime || 'application/octet-stream',
          'x-upsert': 'true',   // a Meta redelivery re-uploads the same id → same path, no dupes
        },
        body: got.bytes,
      });
      if (!up.ok) { m.media.host_error = `upload_${up.status}`; continue; }
      m.media.storage_bucket = INBOUND_BUCKET;
      m.media.storage_path = path;
      m.media.size = got.size;
      if (!m.media.mime_type) m.media.mime_type = mime;
    } catch (e) { m.media.host_error = `upload_error:${(e?.message || e).toString().slice(0, 60)}`; }
  }
}

// Merge Meta's quality/limit state onto the matching whatsapp sender_identity's metadata.
// Matched on display_phone_number, compared digits-only because Meta reports it formatted
// ("91 98802 12323") while sender_identities.address is E.164 ("+919880212323").
async function persistQuality(env, v) {
  const digits = (s) => String(s || '').replace(/\D/g, '');
  const target = digits(v.display_phone_number);
  if (!target) return;
  const r = await A.sbComms('/rest/v1/sender_identities?channel=eq.whatsapp&select=id,address,metadata', env);
  if (!r.ok) return;
  const row = (r.data || []).find((s) => digits(s.address) === target);
  if (!row) return;
  const metadata = {
    ...(row.metadata || {}),
    quality_rating: v.current_quality_rating || v.event || null,
    messaging_limit: v.current_limit || null,
    quality_updated_at: new Date().toISOString(),
  };
  await A.sbComms(`/rest/v1/sender_identities?id=eq.${A.enc(row.id)}`, env,
    { method: 'PATCH', body: JSON.stringify({ metadata }) });
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
        // PERSIST, don't just alert. Meta's quality rating + messaging limit gate throughput
        // (a drop = throttling), so deliverability_health reads them off sender metadata.
        // Previously this branch only Slack-alerted and the state was lost the moment the
        // message scrolled — nothing could show "what is our quality right now?".
        await persistQuality(env, v).catch(() => {});
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

module.exports = { handleWhatsappWebhook, verifyWhatsappWebhook, verifySignature, handleInbound, handleStatuses };
