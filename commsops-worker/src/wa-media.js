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
async function uploadMedia(env, assetUrl, phoneNumberId) {
  let bytes, mime;
  try {
    const res = await fetch(assetUrl);
    if (!res.ok) return null;
    mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!SUPPORTED.has(mime)) return null;
    const buf = await res.arrayBuffer();
    if (!buf || buf.byteLength === 0 || buf.byteLength > MAX_BYTES) return null;
    bytes = buf;
  } catch { return null; }

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
    if (!res.ok || !data?.id) return null;
    return { id: String(data.id), size: bytes.byteLength, mime };
  } catch { return null; }
}

// resolveMediaId(env, url, phoneNumberId) → media id string, or null to fall back to the link.
async function resolveMediaId(env, assetUrl, phoneNumberId) {
  if (!env?.WA_TOKEN || !assetUrl || !phoneNumberId) return null;
  if (!/^https:\/\//i.test(String(assetUrl))) return null;
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

module.exports = { resolveMediaId, applyMediaIds, invalidate, MAX_AGE_MS, MAX_BYTES };
