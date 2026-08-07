// WA sender quality — PULL Meta's per-number quality signal onto sender_identities.metadata.
//
// WHY A PULL WHEN A PUSH ALREADY EXISTS. `wa-webhooks.js persistQuality()` writes exactly these
// keys from the `phone_number_quality_update` webhook, and it is correct. But Meta only pushes
// that field on a TRANSITION, so a WABA whose rating has not moved since the handler shipped
// never emits one — which is why `quality_rating` / `messaging_limit` / `quality_updated_at` were
// NULL on all 6 whatsapp senders on 2026-08-07 despite 1,323 `wa_131049` declines in 30 days on
// the marketing number. A push tells you when it CHANGES; only a pull tells you what it IS.
// The two paths are complementary and both write the same keys — `quality_source` records which
// one last touched a row.
//
// ⚠️ MATCHED ON phone_number_id, NOT ON THE DISPLAY NUMBER. The webhook path has to compare
// digits-only because Meta's webhook payload carries a formatted `display_phone_number`
// ("91 98802 12323") and no id. The pull starts from our own `metadata.phone_number_id`, so it
// can address the exact node and skip the fuzzy match entirely. Digits are used only as a
// fallback for a sender row that predates phone_number_id being stored.
//
// ⚠️ `messaging_limit_tier` IS NOT RETURNED BY THE PHONE-NUMBER NODE. Measured 2026-07-27 on two
// numbers and recorded in wa-templates.js: requesting it is ACCEPTED (no error, so a fallback
// never trips) and the field is silently omitted from the response. It is requested here anyway
// ONLY because it sits in the optional EXT set that already has a fallback, so it costs nothing
// and starts working by itself if Meta ever ships it. Do NOT read its absence as a bug, and do
// NOT go hunting for it again — the daily-cap tier is read in WhatsApp Manager, or it arrives via
// the webhook's `current_limit`. This is precisely why the merge below never writes a null over
// an existing value: the webhook is the only source of `messaging_limit`, and a pull that
// blanked it would destroy the better signal.

const A = require('./auth.js');

const graphBase = (env) => `https://graph.facebook.com/${env.WA_GRAPH_VERSION || 'v21.0'}`;

// Proven-good on the phone-number node (wa-templates.js NUM_FIELDS_BASE, measured 2026-07-27).
const NUM_FIELDS_BASE = 'id,display_phone_number,quality_rating,status';
// Optional extras. Graph rejects the WHOLE request if ANY single field is FORBIDDEN — the trap
// that dragged the harmless WABA fields down with the BSP-only ones — so these are a separate
// attempt with a fallback to BASE, never appended to the request we depend on.
const NUM_FIELDS_EXT = `${NUM_FIELDS_BASE},throughput,messaging_limit_tier`;

const digits = (s) => String(s || '').replace(/\D/g, '');

async function fetchNumber(env, phoneNumberId) {
  const get = async (fields) => {
    const res = await fetch(
      `${graphBase(env)}/${encodeURIComponent(phoneNumberId)}?fields=${fields}`,
      { headers: { Authorization: `Bearer ${env.WA_TOKEN}` } });
    return { res, data: await res.json().catch(() => ({})) };
  };
  let { res, data } = await get(NUM_FIELDS_EXT);
  if (!res.ok) ({ res, data } = await get(NUM_FIELDS_BASE));   // one forbidden extra must not lose the lot
  if (!res.ok) return { ok: false, error: data?.error?.message || `http_${res.status}` };
  return { ok: true, data };
}

/**
 * Pull quality for every active whatsapp sender and merge it onto metadata.
 * Best-effort per sender: one unreachable number never aborts the sweep.
 * Returns a summary — callers log it, they do not branch on it.
 */
async function pullSenderQuality(env) {
  if (!env.WA_TOKEN) return { ok: false, error: 'no_wa_token' };

  const r = await A.sbComms(
    '/rest/v1/sender_identities?channel=eq.whatsapp&status=eq.active&select=id,address,metadata', env);
  if (!r.ok) return { ok: false, error: 'sender_read_failed' };

  const out = { checked: 0, updated: 0, changed: 0, failed: 0, senders: [] };
  const now = new Date().toISOString();

  for (const row of (r.data || [])) {
    const meta = row.metadata || {};
    const pnid = meta.phone_number_id || null;
    if (!pnid) { out.failed++; out.senders.push({ address: row.address, error: 'no_phone_number_id' }); continue; }

    out.checked++;
    const got = await fetchNumber(env, pnid);
    if (!got.ok) { out.failed++; out.senders.push({ address: row.address, error: got.error }); continue; }

    const d = got.data || {};
    // Sanity-check the node we got back actually belongs to this sender. A wrong
    // phone_number_id in metadata would otherwise silently stamp one number's rating onto
    // another — the failure mode that is impossible to spot once written.
    if (d.display_phone_number && digits(d.display_phone_number) !== digits(row.address)) {
      out.failed++;
      out.senders.push({ address: row.address, error: `id_mismatch:${d.display_phone_number}` });
      continue;
    }

    const rating = d.quality_rating || null;
    const limit = d.messaging_limit_tier || null;   // expected absent — see the header note

    // Merge only what we actually received. Writing a null here would clobber the webhook's
    // `messaging_limit`, which is the ONLY source for it.
    const next = { ...meta };
    let changed = false;
    if (rating && rating !== meta.quality_rating) { next.quality_rating = rating; changed = true; }
    if (limit && limit !== meta.messaging_limit) { next.messaging_limit = limit; changed = true; }
    if (d.throughput?.level && d.throughput.level !== meta.throughput_level) {
      next.throughput_level = d.throughput.level; changed = true;
    }

    // `quality_updated_at` means WHEN THE VALUE LAST CHANGED, so a poll that confirms an
    // unchanged rating must not refresh it — otherwise a rating that has been GREEN for three
    // months reads as though it moved five minutes ago, and the one question the field exists
    // to answer ("how long has it been like this?") becomes unanswerable. `quality_checked_at`
    // carries the freshness of the read. The webhook only ever fires on a real transition, so
    // its existing `quality_updated_at = now` stays correct.
    next.quality_checked_at = now;
    if (changed) next.quality_updated_at = now;
    next.quality_source = 'graph_pull';

    const up = await A.sbComms(`/rest/v1/sender_identities?id=eq.${A.enc(row.id)}`, env,
      { method: 'PATCH', body: JSON.stringify({ metadata: next }) });
    if (!up.ok) { out.failed++; out.senders.push({ address: row.address, error: 'patch_failed' }); continue; }

    out.updated++;
    if (changed) out.changed++;
    out.senders.push({ address: row.address, quality: rating || 'none', limit: limit || null, changed });
  }
  return { ok: true, ...out };
}

/**
 * Cron entry point. Throttled to hourly off `settings.wa_quality_pulled_at` — quality moves on
 * the order of days, the cron ticks every 5 minutes, and each pull is one Graph call PER SENDER.
 * Unthrottled this would be ~1,700 Graph calls/day to re-read a value that almost never moves.
 * Claim-then-work (conditional PATCH) so overlapping ticks cannot double-pull.
 */
async function pullSenderQualityIfDue(env, { minIntervalMin = 60 } = {}) {
  const cutoff = new Date(Date.now() - minIntervalMin * 60 * 1000).toISOString();
  const claim = await A.sbComms(
    `/rest/v1/settings?id=eq.1&or=(wa_quality_pulled_at.is.null,wa_quality_pulled_at.lt.${A.enc(cutoff)})`, env,
    { method: 'PATCH', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ wa_quality_pulled_at: new Date().toISOString() }) });
  if (!claim.ok || !Array.isArray(claim.data) || claim.data.length === 0) return { skipped: true };
  return pullSenderQuality(env);
}

module.exports = { pullSenderQuality, pullSenderQualityIfDue };
