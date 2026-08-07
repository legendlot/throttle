// Cashfree webhook receiver (POST /webhook/cashfree). The paid/failed outcome of a
// Relay-minted payment link arrives here → mapped to a substrate event via /ingest →
// the J1 wait_response matcher wakes the parked journey instance (paid / failed
// branch). Structurally identical to Odo's /webhook/razorpay, minus the fact recompute.
//
// SECURITY: HMAC-SHA256 signature (unlike Shopflo, which had none). Cashfree sends
// x-webhook-signature = base64(HMAC-SHA256(x-webhook-timestamp + rawBody, CLIENT_SECRET)).
// Verified over the RAW body BEFORE parse; a bad/absent signature is rejected. Inert
// (503) until CASHFREE_CLIENT_ID/_SECRET are set, so the route is a no-op pre-creds.
//
// DISCOVERY MODE: we have not yet observed a real Cashfree PAYMENT_LINK_EVENT on the
// wire (docs vs wire have drifted before — see the Shopflo build). So any event we
// cannot confidently map — unknown type/status, non-terminal status, or missing
// identity — is captured raw into comms.webhook_captures (source 'cashfree') and
// ack'd 200, so the exact shape is inspectable and the mapper can be corrected off a
// real sample rather than lost. Mapper bugs never 500 back (avoids a retry storm).
const A = require('./auth.js');
const { ingest } = require('./ingest.js');
const CF = require('./cashfree.js');

// Capture a raw event (headers minus signature/cookie + body) for discovery.
async function capture(env, request, body, reason) {
  const hdrs = {};
  for (const [k, v] of request.headers) {
    const lk = k.toLowerCase();
    if (lk === 'x-webhook-signature' || lk === 'cookie' || lk === 'authorization') continue;
    hdrs[k] = v;
  }
  await A.sbComms('/rest/v1/webhook_captures', env, {
    method: 'POST', body: JSON.stringify({ source: 'cashfree', headers: { ...hdrs, _reason: reason || null }, body }),
  }).catch((e) => { console.log('cashfree_capture_error', e?.message || String(e)); });
}

async function handleCashfreeWebhook(env, request) {
  if (!CF.isConfigured(env)) return { ok: false, error: 'cashfree_not_configured', status: 503 };

  const raw = await request.text();
  const sig = request.headers.get('x-webhook-signature') || '';
  const ts = request.headers.get('x-webhook-timestamp') || '';
  const good = await CF.verifyWebhook(env, ts, raw, sig);
  if (!good) {
    // CAPTURE THE REJECTION. Previously this returned 401 with no trace, which made the one
    // failure mode that silently kills C2P payments — a rotated CLIENT_SECRET — completely
    // indistinguishable from "nobody paid". Measured 2026-08-07: zero Cashfree captures since
    // 2026-07-29 20:55 across 8 payment links, and there was no way to tell whether Cashfree had
    // stopped calling or we had started rejecting. Silence must never be ambiguous on a money path.
    //
    // ⚠️ Body is TRUNCATED and the response is still 401. This path is reachable by anyone who
    // finds the URL, so it must not become an unbounded write primitive for unauthenticated
    // callers — enough to recognise a real Cashfree payload and its timestamp, not enough to be
    // worth abusing.
    await capture(env, request, { _rejected: true, _excerpt: String(raw || '').slice(0, 512) },
                  `bad_signature:ts=${ts ? 'present' : 'absent'},sig=${sig ? 'present' : 'absent'}`)
      .catch(() => {});
    console.log('cashfree_bad_signature', { ts_present: !!ts, sig_present: !!sig, bytes: (raw || '').length });
    return { ok: false, error: 'bad_signature', status: 401 };
  }

  let body;
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = { _unparsed: raw }; }

  // Payment-Link events are detected by the link fields under `data` (NOT a top-level
  // `type` — a real Cashfree test event has none). Anything else that reaches this route
  // (e.g. a PG payment webhook mis-pointed here) → capture for visibility, ack.
  if (!CF.isPaymentLinkEvent(body)) {
    await capture(env, request, body, `not_a_link_event:${(body && body.type) || 'none'}`);
    return { ok: true, captured: true, mapped: false };
  }

  let envlp;
  try {
    envlp = CF.mapPaymentLinkEvent(body);
  } catch (e) {
    await capture(env, request, body, `map_error:${e?.message || String(e)}`).catch(() => {});
    console.log('cashfree_map_error', e?.message || String(e));
    return { ok: true, error_captured: true };
  }

  // Non-terminal status (ACTIVE/PARTIALLY_PAID) or no usable identity → nothing to signal
  // yet; capture so the real payload shape is visible during bring-up, then ack.
  if (!envlp) {
    const link = CF.linkOf(body);
    await capture(env, request, body, `unmapped_status:${link && link.link_status}`);
    return { ok: true, mapped: false, link_status: (link && link.link_status) || null };
  }

  const r = await ingest(env, envlp);
  if (!r.ok) {
    await capture(env, request, body, `ingest_error:${r.error}`);
    return { ok: false, error: r.error, status: 400 };
  }
  return { ok: true, emitted: envlp.name, profile_id: r.profile_id, deduped: r.deduped };
}

module.exports = { handleCashfreeWebhook };
