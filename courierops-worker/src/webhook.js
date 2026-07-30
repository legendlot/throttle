// POST /webhooks/delhivery — Delhivery ScanPush receiver (I/O layer; mappers live in scanpush.js).
//
// ⏱️ THE 500 ms RULE IS THE WHOLE DESIGN. Delhivery's requirement doc: "In case webhook api response
// time > 500 ms, there will be a timeout at Delhivery end and client might missed the shipment
// scans." A dropped scan is NOT retried — it is gone. So this handler is ACK-FIRST: it authenticates
// (pure string compare, no I/O), parses, and RETURNS 200 immediately, then does every database write
// inside ctx.waitUntil() after the response has been sent. Never add an `await` of a DB/network call
// before the Response is returned.
//
// SECURITY: Delhivery offers no HMAC — only custom headers we specify — so this is the same low-trust
// posture as the Shopflo receiver. Two factors:
//   1. shared bearer token in `X-Delhivery-Token` (DELHIVERY_WEBHOOK_TOKEN)
//   2. optional source-IP allowlist from their published PROD ranges (DELHIVERY_IP_ALLOWLIST)
// Worst case for a forgery is a bogus row in a capture table that writes nothing downstream.
//
// INERT UNTIL CONFIGURED: with no DELHIVERY_WEBHOOK_TOKEN set, the route is a 503 no-op, NOT an open
// endpoint — so deploying this ahead of Delhivery's go-live changes nothing.
import { parseScanPushBatch, tokenMatches } from './scanpush.js';

const SUPABASE_URL = 'https://jkxcnjabmrkteanzoofj.supabase.co';

async function sb(key, path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...(opts.prefer ? { Prefer: opts.prefer } : {}),
      ...opts.headers,
    },
  });
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, data: text ? JSON.parse(text) : null }; }
  catch { return { ok: res.ok, status: res.status, data: text }; }
}

function enc(v) { return encodeURIComponent(String(v)); }

// Headers minus anything credential-bearing — the capture table is for shape discovery, and a
// captured secret would outlive the debugging that wanted it.
function safeHeaders(request) {
  const out = {};
  for (const [k, v] of request.headers) {
    const lk = k.toLowerCase();
    if (lk === 'x-delhivery-token' || lk === 'authorization' || lk === 'cookie') continue;
    out[k] = v;
  }
  return out;
}

function ipAllowed(env, request) {
  const raw = (env.DELHIVERY_IP_ALLOWLIST || '').trim();
  if (!raw) return true;                                  // unset = no IP factor, token only
  const ip = request.headers.get('CF-Connecting-IP') || '';
  return raw.split(',').map((s) => s.trim()).filter(Boolean).includes(ip);
}

/**
 * The deferred work: resolve each scan to a shipment and record it. Runs AFTER the 200 has gone
 * back to Delhivery, so its latency is irrelevant to them. Must never throw out of waitUntil.
 */
async function persistScans(env, scans, request, rawBody) {
  const key = env.SUPABASE_SERVICE_KEY;
  if (!key) { console.error('scanpush: SUPABASE_SERVICE_KEY missing — scan dropped'); return; }
  const headers = safeHeaders(request);
  const apply = String(env.DELHIVERY_SCANPUSH_APPLY || '') === 'true';

  // Resolve every AWB in ONE query (never a fetch per scan — batching rule).
  // AWBs are alphanumeric; anything else is not a waybill and is dropped rather than quoted into
  // the filter — that keeps the PostgREST `in.()` list injection-proof without fragile escaping.
  const awbs = [...new Set(
    scans.map((s) => s.awb).filter((a) => a && /^[A-Za-z0-9-]{4,}$/.test(a))
  )];
  const byAwb = new Map();
  if (awbs.length) {
    const r = await sb(key,
      `/rest/v1/ecom_shipments?select=id,tracking_number,lifecycle,emitted_lifecycles`
      + `&tracking_number=in.(${awbs.map(enc).join(',')})&limit=${awbs.length * 2}`);
    if (r.ok && Array.isArray(r.data)) for (const row of r.data) byAwb.set(String(row.tracking_number), row);
    else console.error('scanpush: shipment lookup failed', r.status, r.data);
  }

  const rows = scans.map((s) => {
    const match = s.awb ? byAwb.get(s.awb) : null;
    let note = null;
    if (!s.awb) note = 'no AWB in payload';
    else if (!match) note = 'AWB not found in ecom_shipments';
    else if (!s.lifecycle) note = 'scan status not classifiable — mapper needs this code';
    else if (!apply) note = 'discovery mode (DELHIVERY_SCANPUSH_APPLY not set)';
    return {
      courier: 'delhivery',
      awb: s.awb, status: s.status, status_type: s.statusType, nsl_code: s.nslCode,
      status_location: s.statusLocation, instructions: s.instructions,
      reference_no: s.referenceNo, status_at: s.statusAt,
      mapped_lifecycle: s.lifecycle,
      matched_shipment_id: match ? match.id : null,
      applied: false,
      apply_note: note,
      headers, body: rawBody,
    };
  });

  // return=representation so the inserted rows come back WITH their ids — the apply loop below
  // needs them to stamp `applied`, and the local objects have no id (the DB generates it).
  const ins = await sb(key, '/rest/v1/courier_scan_captures',
    { method: 'POST', body: JSON.stringify(rows), prefer: 'return=representation' });
  if (!ins.ok) { console.error('scanpush: capture insert failed', ins.status, ins.data); return; }
  // Fall back to the local rows if representation is ever absent: the apply still runs, only the
  // `applied` stamp is skipped (its `r.id` guard). Applying matters; the audit flag does not.
  const saved = (Array.isArray(ins.data) && ins.data.length === rows.length) ? ins.data : rows;

  console.log(`scanpush: captured ${rows.length}`,
    `matched=${rows.filter((r) => r.matched_shipment_id).length}`,
    `unmapped=${rows.filter((r) => !r.mapped_lifecycle).length}`,
    `apply=${apply}`);

  if (!apply) return;   // DISCOVERY MODE — nothing downstream is touched

  // APPLY MODE: advance ecom_shipments.lifecycle so commsops' existing emitter picks the
  // transition up on its next tick. We deliberately do NOT emit events here — `emitted_lifecycles`
  // over there is the single idempotency guard, and it is what stops this feed and the Uniware
  // poller from both firing order_delivered for the same shipment.
  //
  // ⚠️ `lifecycle` ALONE IS NOT ENOUGH FOR THE EMITTER (fixed 2026-07-29). commsops'
  // occurredAt() needs to know WHEN the transition happened, and for in_transit /
  // out_for_delivery / rto it read `uniware_updated_at` — a column only the Uniware poller
  // writes. So a ScanPush transition was dated by Uniware's stale last-touch stamp, fell below
  // `courier_emit_from`, and was dropped as `stale`: 150 of 153 live rto rows, silently. Only
  // `delivered` escaped, because it has its own real stamp below. We cannot stamp
  // `uniware_updated_at` here — odoops writes it from Uniware's own `updated` field and uses it
  // as a poll cursor — so this feed stamps `lifecycle_changed_at`, which occurredAt() now
  // prefers (migration 0036). Use the SCAN's own timestamp, not now(): the courier telling us
  // late must not read as a fresh event.
  for (const r of saved) {
    if (!r.matched_shipment_id || !r.mapped_lifecycle) continue;
    const cur = byAwb.get(r.awb);
    if (cur && cur.lifecycle === r.mapped_lifecycle) continue;      // no transition, nothing to do
    const now = new Date().toISOString();
    const patch = {
      lifecycle: r.mapped_lifecycle,
      courier_status: r.status,
      updated_at: now,
      lifecycle_changed_at: r.status_at || now,
    };
    if (r.mapped_lifecycle === 'delivered' && r.status_at) patch.delivered_at = r.status_at;
    const u = await sb(key, `/rest/v1/ecom_shipments?id=eq.${enc(r.matched_shipment_id)}`,
      { method: 'PATCH', body: JSON.stringify(patch) });
    if (!u.ok) { console.error('scanpush: lifecycle patch failed', r.awb, u.status, u.data); continue; }
    // Stamp `applied` — it was hardcoded `false` on insert and never set true, so it read false on
    // all 4,930 rows even where the scan HAD advanced the shipment, and nearly caused a false
    // "ScanPush isn't working" call at go-live. A column that always says no is worse than no
    // column. Now it means exactly one thing: this scan changed `ecom_shipments.lifecycle`.
    // Best-effort — a failed stamp must never look like a failed apply, so it only logs.
    if (r.id) {
      const a = await sb(key, `/rest/v1/courier_scan_captures?id=eq.${enc(r.id)}`,
        { method: 'PATCH', body: JSON.stringify({ applied: true, apply_note: `lifecycle → ${r.mapped_lifecycle}` }) });
      if (!a.ok) console.error('scanpush: applied stamp failed', r.awb, a.status);
    }
  }
}

export async function handleDelhiveryScanPush(request, env, ctx) {
  // --- everything before the Response is pure/in-memory: no awaited I/O ---
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (!env.DELHIVERY_WEBHOOK_TOKEN) return json({ error: 'not_configured' }, 503);
  if (!tokenMatches(request.headers.get('X-Delhivery-Token'), env.DELHIVERY_WEBHOOK_TOKEN)) {
    return json({ error: 'unauthorised' }, 401);
  }
  if (!ipAllowed(env, request)) return json({ error: 'forbidden' }, 403);

  let rawBody;
  try { rawBody = await request.json(); }
  catch { return json({ error: 'invalid_json' }, 400); }

  let scans = [];
  try { scans = parseScanPushBatch(rawBody); }
  catch (e) { console.error('scanpush: parse failed', e?.message || e); }

  // Ack FIRST. Even a scan we could not parse is acked and captured — a 4xx would make Delhivery
  // treat it as a failed push, and we would rather hold the payload and fix the mapper.
  ctx.waitUntil(
    persistScans(env, scans.length ? scans : [{ awb: null, status: null, lifecycle: null }], request, rawBody)
      .catch((e) => console.error('scanpush: persist failed', e?.message || e))
  );
  return json({ ok: true, received: scans.length }, 200);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}
