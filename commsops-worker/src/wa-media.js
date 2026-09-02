// WhatsApp SEND-time media ids.
//
// THE PROBLEM. A template media header is sent as `image:{link:<url>}`, which makes Meta fetch
// the asset on EVERY send. That fetch fails asynchronously (error 131053 "Media upload error"):
// the /messages call returns 200 with a wamid, `sent_at` is stamped, and minutes later the
// status webhook flips the message to `failed`. Measured 2026-07-29 on the 1.19MB Order Placed
// banner: 4 of 113 sends (3.5%) — real order confirmations, silently lost. Because the failure
// arrives asynchronously there is nothing to retry synchronously.
//
// THE FIX. Upload each asset to Meta ONCE (`POST /{phone-number-id}/media`) and send
// `image:{id:<media-id>}`. No per-send fetch, so the failure mode disappears — and it stops
// depending on asset size, which is what actually varies here (the 13KB logo header is 0-for-329
// while the 1.19MB banner is 4-for-113).
//
// A media id belongs to the PHONE NUMBER that uploaded it, so the cache key is
// (asset_url, phone_number_id).
//
// EVERY failure path returns null, and the caller then sends the raw link exactly as before.
// That is deliberate: this module can only ever make sending better or leave it unchanged, never
// worse. It is why the feature is safe to run on a live transactional path.

const A = require('./auth.js');

const GRAPH_VERSION = 'v21.0';
const graphBase = (env) => `https://graph.facebook.com/${env.WA_GRAPH_VERSION || GRAPH_VERSION}`;

// Meta retains uploaded media for 30 days. Refresh well before that: a stale id fails the send,
// and the whole point of this module is to not lose sends.
const MAX_AGE_MS = 20 * 86400000;

// WhatsApp caps template header images at 5MB. Refuse to upload above it rather than burn the
// round trip — and the link path would fail for the same reason, so nothing is lost by falling
// back. (Live note 2026-07-29: the Order Cancelled asset is 5,227,518 bytes, ~15KB under the cap.)
const MAX_BYTES = 5 * 1024 * 1024;

const SUPPORTED = new Set(['image/jpeg', 'image/png']);

// ── SHOPIFY SERVES THE FULL-RESOLUTION ORIGINAL, AND IT IS 5-8x OVER META'S CAP ──────────────
// This is the measured cause of the residual 131053 trickle (S332, 2026-09-02). Browse/cart
// abandonment templates take their header from the event's `product_image_url`, which is the raw
// Shopify variant asset. Measured over 30 days: 46 of 47 attributable 131053 failures were assets
// above MAX_BYTES — 7.2MB, 10.6MB, 14.2MB, 26.5MB, 26.6MB and one at 42.8MB. Every one returned
// 200 with a SUPPORTED mime, so nothing upstream looked broken; they were simply enormous.
// uploadMedia refused them as `too_large` -> null -> the caller sent `image:{link}` -> Meta ran the
// same oversized fetch itself and failed it ASYNCHRONOUSLY as 131053, losing the message.
// ⚠️ So the failure was DETERMINISTIC PER VARIANT, not the "~0.4% noise" it was filed as: any
// variant whose image exceeds the cap failed 100% of the time it was sent.
//
// Shopify's CDN resizes on demand via `width=`. 1200px sits above WhatsApp's 1125px recommended
// header width and brought all 12 measured assets under 2.3MB (the 42.8MB one to 1.86MB).
// ⚠️ Both host shapes must match — the SAME asset measured 26.6MB via `cdn.shopify.com` and
// 42.8MB via the storefront's `/cdn/shop/` path, and both appear in live events.
// ⚠️ Never clobber a width/height the caller already chose, and never touch a non-Shopify host.
const HEADER_WIDTH = 1200;
function cdnFetchUrl(assetUrl) {
  try {
    const u = new URL(assetUrl);
    const isShopify = u.hostname === 'cdn.shopify.com' || u.pathname.startsWith('/cdn/shop/');
    if (!isShopify) return assetUrl;
    if (u.searchParams.has('width') || u.searchParams.has('height')) return assetUrl;
    u.searchParams.set('width', String(HEADER_WIDTH));
    return u.toString();
  } catch { return assetUrl; }   // unparseable -> leave it exactly as given
}

// cacheLookup / cacheStore are separated so the send path can be unit-tested without a DB.
async function cacheLookup(env, assetUrl, phoneNumberId) {
  const q = `/rest/v1/wa_media_cache?asset_url=eq.${A.enc(assetUrl)}`
    + `&phone_number_id=eq.${A.enc(phoneNumberId)}&select=media_id,uploaded_at&limit=1`;
  const r = await A.sbComms(q, env);
  if (!r.ok) return null;                       // read blip → treat as a miss → link fallback
  const row = r.data?.[0];
  if (!row?.media_id) return null;
  const age = Date.now() - Date.parse(row.uploaded_at || '');
  if (!Number.isFinite(age) || age > MAX_AGE_MS) return null;   // too old → re-upload
  return row.media_id;
}

async function cacheStore(env, assetUrl, phoneNumberId, mediaId, meta) {
  await A.sbComms('/rest/v1/wa_media_cache?on_conflict=asset_url,phone_number_id', env, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({
      asset_url: assetUrl, phone_number_id: phoneNumberId, media_id: mediaId,
      byte_size: meta?.size ?? null, mime_type: meta?.mime ?? null,
      uploaded_at: new Date().toISOString(),
    }),
  }).catch(() => {});   // a cache-write failure must not fail the send; worst case we re-upload
}

// Drop a cached id — called when a send reports a media error, so the next send re-uploads
// instead of replaying a dead id forever.
async function invalidate(env, phoneNumberId) {
  if (!phoneNumberId) return;
  await A.sbComms(`/rest/v1/wa_media_cache?phone_number_id=eq.${A.enc(phoneNumberId)}`, env,
    { method: 'DELETE' }).catch(() => {});
}

// Upload the asset to Meta and return its media id, or null.
// Every abort path logs WHY and returns null. The null contract is unchanged and load-bearing —
// the caller falls back to the raw link, so this module can only ever help or do nothing. What was
// missing is observability: before this, a refusal was indistinguishable from "no media header",
// and a live asset that Meta silently rejected took four sends and a DB dig to even localise
// (S261). Never throw from here, and never log the bearer token.
function skip(reason, detail) {
  console.log('wa_media_skip', JSON.stringify({ reason, ...detail }));
  return null;
}

async function uploadMedia(env, assetUrl, phoneNumberId) {
  let bytes, mime;
  // The CACHE KEY stays the original assetUrl — same logical asset, so a resized fetch must not
  // fragment the cache or change what `applyMediaIds` matches on.
  const fetchUrl = cdnFetchUrl(assetUrl);
  try {
    const res = await fetch(fetchUrl);
    if (!res.ok) return skip('asset_fetch_failed', { assetUrl, fetchUrl, status: res.status });
    mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    // NB this is the SERVED content-type, not the file extension. A `.webp` URL that Shopify
    // serves as image/png passes; a `.jpg` served as application/octet-stream does not.
    if (!SUPPORTED.has(mime)) return skip('unsupported_mime', { assetUrl, fetchUrl, mime });
    const buf = await res.arrayBuffer();
    if (!buf || buf.byteLength === 0) return skip('empty_asset', { assetUrl, fetchUrl });
    if (buf.byteLength > MAX_BYTES) return skip('too_large', { assetUrl, fetchUrl, bytes: buf.byteLength, max: MAX_BYTES });
    bytes = buf;
  } catch (e) { return skip('asset_fetch_threw', { assetUrl, fetchUrl, error: String(e?.message || e) }); }

  try {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mime);
    // Filename is required by Meta's multipart parser but is otherwise cosmetic.
    form.append('file', new Blob([bytes], { type: mime }), 'header' + (mime === 'image/png' ? '.png' : '.jpg'));
    const res = await fetch(`${graphBase(env)}/${encodeURIComponent(phoneNumberId)}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.WA_TOKEN}` },   // NO Content-Type — FormData sets the boundary
      body: form,
    });
    const data = await res.json().catch(() => ({}));
    // Meta's rejection reason lives in the BODY, not the status — this is the one line that would
    // have answered "why won't it take this image?" without a live tail.
    if (!res.ok || !data?.id) {
      return skip('meta_upload_rejected', {
        assetUrl, phoneNumberId, status: res.status, mime, bytes: bytes.byteLength,
        meta_error: data?.error || data || null,
      });
    }
    return { id: String(data.id), size: bytes.byteLength, mime };
  } catch (e) { return skip('meta_upload_threw', { assetUrl, error: String(e?.message || e) }); }
}

// resolveMediaId(env, url, phoneNumberId) → media id string, or null to fall back to the link.
async function resolveMediaId(env, assetUrl, phoneNumberId) {
  // ⚠️ A missing WA_TOKEN silently disables this ENTIRE feature — every send quietly reverts to
  // the link path that 131053 exists to avoid, with `wa_media_id_enabled` still reading true.
  // That is precisely the shape of failure this logging exists to make impossible.
  if (!env?.WA_TOKEN) return skip('no_wa_token', {});
  if (!assetUrl || !phoneNumberId) return skip('missing_args', { hasUrl: !!assetUrl, hasPhoneId: !!phoneNumberId });
  if (!/^https:\/\//i.test(String(assetUrl))) return skip('not_https', { assetUrl });
  const hit = await cacheLookup(env, assetUrl, phoneNumberId);
  if (hit) return hit;
  const up = await uploadMedia(env, assetUrl, phoneNumberId);
  if (!up) return null;
  await cacheStore(env, assetUrl, phoneNumberId, up.id, up);
  return up.id;
}

// Rewrite a rendered template's media-header parameter from {link} to {id}, in place-ish.
// Returns a NEW components array (never mutates the caller's) or the original on any miss.
async function applyMediaIds(env, components, phoneNumberId) {
  if (!Array.isArray(components) || !components.length) return components;
  const out = [];
  let changed = false;
  for (const c of components) {
    const p = c?.parameters?.[0];
    const kind = p?.type;
    const link = kind && p?.[kind]?.link;
    if (c?.type !== 'header' || !link || !['image', 'video', 'document'].includes(kind)) {
      out.push(c); continue;
    }
    const id = await resolveMediaId(env, link, phoneNumberId);
    if (!id) { out.push(c); continue; }          // fallback: leave the link exactly as rendered
    out.push({ ...c, parameters: [{ type: kind, [kind]: { id } }] });
    changed = true;
  }
  return changed ? out : components;
}

// ── AGENT ATTACHMENTS (Pitstop → WhatsApp, S245) ─────────────────────────────
// A separate path from the template-header one above, in three ways that matter:
//
//  1. NO CACHE. An agent attachment is one-shot — csops hosts each file under a fresh UUID, so
//     a cache lookup can never hit and a cache write would grow wa_media_cache without bound.
//  2. WIDER TYPE SET. Header images are jpeg/png; agents send screenshots and PDFs.
//  3. IT FAILS LOUD. applyMediaIds() falls back to a link on every error because a degraded
//     template send still reaches the customer. There is NO fallback here — a media message IS
//     the media. On failure we return the reason so csops can surface a real error to the agent;
//     silently sending nothing would show as "sent" in the inbox while the customer got nothing.
//
// Cloud API accepts ONLY image/jpeg + image/png as an `image` message (webp is sticker-only and
// gif is unsupported), so anything else we allow rides as a `document` — the file still arrives,
// just as an attachment chip instead of an inline preview. That beats a 400 on the send.
function sendKindFor(mime) {
  const m = String(mime || '').toLowerCase();
  if (m === 'image/jpeg' || m === 'image/png') return 'image';
  if (m === 'image/webp' || m === 'image/gif' || m === 'application/pdf') return 'document';
  return null;
}

// Meta's own caps: image 5MB, document 100MB. csops already refuses >8MB upstream, so the
// document ceiling here just mirrors that rather than inventing a second limit.
const SEND_MAX = { image: 5 * 1024 * 1024, document: 8 * 1024 * 1024 };

async function uploadInlineMedia(env, { url, mime, filename }, phoneNumberId) {
  if (!env?.WA_TOKEN || !phoneNumberId) return { ok: false, error: 'media_not_configured' };
  if (!url || !/^https:\/\//i.test(String(url))) return { ok: false, error: 'media_bad_url' };
  const kind = sendKindFor(mime);
  if (!kind) return { ok: false, error: `media_unsupported_type:${mime || 'unknown'}` };

  let bytes;
  try {
    const res = await fetch(String(url));
    if (!res.ok) return { ok: false, error: `media_fetch_failed:${res.status}` };
    const buf = await res.arrayBuffer();
    if (!buf || buf.byteLength === 0) return { ok: false, error: 'media_empty' };
    if (buf.byteLength > SEND_MAX[kind]) return { ok: false, error: 'media_too_large' };
    bytes = buf;
  } catch (e) { return { ok: false, error: `media_fetch_failed:${e?.message || e}` }; }

  try {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', String(mime));
    form.append('file', new Blob([bytes], { type: String(mime) }), filename || 'attachment');
    const res = await fetch(`${graphBase(env)}/${encodeURIComponent(phoneNumberId)}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.WA_TOKEN}` },   // NO Content-Type — FormData sets the boundary
      body: form,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.id)
      return { ok: false, error: `media_upload_failed:${JSON.stringify(data?.error || data).slice(0, 180)}` };
    return { ok: true, id: String(data.id), kind };
  } catch (e) { return { ok: false, error: `media_upload_failed:${e?.message || e}` }; }
}

// ── INBOUND media (customer → Pitstop, S245) ─────────────────────────────────
// Meta hands us only a media ID; the bytes sit behind a two-step, token-authed fetch and the
// URL expires in minutes. BiteSpeed used to hand Pitstop a ready hosted URL (Chatwoot's
// data_url), so without this an inbound damage photo lands as an unopenable chip — the exact
// dead-chip bug already fixed once for inbound email attachments.
//
// Customer-sent files go to a PRIVATE bucket, matching that email decision: these are things
// customers sent US (IDs, invoices, addresses), not assets we authored. csops mints a signed
// URL per read. Returns null on any failure — the message itself must still reach the inbox.
async function fetchInboundMedia(env, mediaId) {
  if (!env?.WA_TOKEN || !mediaId) return null;
  try {
    const metaRes = await fetch(`${graphBase(env)}/${encodeURIComponent(mediaId)}`, {
      headers: { Authorization: `Bearer ${env.WA_TOKEN}` },
    });
    const meta = await metaRes.json().catch(() => ({}));
    if (!metaRes.ok || !meta?.url) return null;
    // The CDN URL is itself token-authed — a bare GET returns 401.
    const binRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${env.WA_TOKEN}` } });
    if (!binRes.ok) return null;
    const buf = await binRes.arrayBuffer();
    if (!buf || buf.byteLength === 0) return null;
    return { bytes: buf, mime: meta.mime_type || 'application/octet-stream', size: buf.byteLength };
  } catch { return null; }
}

module.exports = {
  resolveMediaId, applyMediaIds, invalidate, MAX_AGE_MS, MAX_BYTES, cdnFetchUrl, HEADER_WIDTH,
  uploadInlineMedia, fetchInboundMedia, sendKindFor,
};
