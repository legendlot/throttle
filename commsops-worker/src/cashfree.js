// Cashfree Payment Gateway — Payment Links seam (J3 COD→prepaid pay-link).
//
// Cashfree is LOT's CURRENT payment gateway (Razorpay = legacy, being deprecated —
// Odo's payment funnel still reads it). Relay mints a hosted payment link, sends it
// through OUR OWN WhatsApp/email journey (so it flows through the send gate + TEST
// MODE) rather than Cashfree's native SMS/email notify, and learns the outcome from
// the PAYMENT_LINK_EVENT webhook → /ingest → the J1 wait_response matcher (paid /
// failed as a signal, NOT adapter polling — same shape as Odo's /webhook/razorpay).
//
// This module is PURE where it can be (webhook verify + mappers are unit-testable, no
// network) plus the one I/O call (createPaymentLink). Entirely INERT until the
// CASHFREE_CLIENT_ID/_SECRET secrets exist — createPaymentLink returns
// {ok:false,error:'cashfree_not_configured'} and the webhook route 503s.
//
// Env:
//  - CASHFREE_CLIENT_ID / CASHFREE_CLIENT_SECRET — Merchant-Dashboard API keys. The
//    client secret ALSO signs the webhook (Cashfree reuses it as the webhook secret).
//  - CASHFREE_ENV — 'production' → api.cashfree.com, else sandbox.cashfree.com (default).
//  - CASHFREE_API_VERSION — optional, defaults to the pinned version below.
const SHOP = require('./shopify.js'); // reuse normalizePhone (E.164, +91 default)

const CF_API_VERSION = '2025-01-01';

// Sandbox by default — a payments integration is NEVER first-tested against prod.
// Flip CASHFREE_ENV=production only after the sandbox round-trip is proven.
function baseUrl(env) {
  return String(env.CASHFREE_ENV || '').toLowerCase() === 'production'
    ? 'https://api.cashfree.com'
    : 'https://sandbox.cashfree.com';
}

function isConfigured(env) {
  return !!(env && env.CASHFREE_CLIENT_ID && env.CASHFREE_CLIENT_SECRET);
}

function num(v) { const n = Number(v); return isFinite(n) ? n : null; }

// ── Mint a payment link ─────────────────────────────────────────────────────────
// opts: { amount, currency?, purpose, linkId?, phone, email?, name?, notes?,
//         notifyUrl?, returnUrl?, expiryTime?, notifySms?, notifyEmail? }
// Returns { ok, link_url, link_id, cf_link_id, link_status, raw } or { ok:false, error, status, raw }.
async function createPaymentLink(env, opts = {}) {
  if (!isConfigured(env)) return { ok: false, error: 'cashfree_not_configured' };

  const phone = SHOP.normalizePhone(opts.phone);
  if (!phone) return { ok: false, error: 'customer_phone_required' };
  const amount = num(opts.amount);
  if (amount == null || amount <= 0) return { ok: false, error: 'link_amount_required' };

  // Our own link_id doubles as the idempotency key so a retried mint is a no-op
  // (Cashfree 409s a duplicate link_id). Callers pass a deterministic id, e.g.
  // `relay-<enrolment>-<step>` — Cashfree limits it to [A-Za-z0-9_-], max 50.
  const linkId = opts.linkId
    ? String(opts.linkId).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 50)
    : null;

  const body = {
    ...(linkId ? { link_id: linkId } : {}),
    link_amount: amount,
    link_currency: opts.currency || 'INR',
    link_purpose: String(opts.purpose || 'Payment').slice(0, 500),
    customer_details: {
      customer_phone: phone,
      ...(opts.email ? { customer_email: String(opts.email).toLowerCase().trim() } : {}),
      ...(opts.name ? { customer_name: String(opts.name).slice(0, 100) } : {}),
    },
    // We deliver the link ourselves (through Relay's gate) — suppress Cashfree's
    // native notify unless a caller explicitly opts in.
    link_notify: { send_sms: !!opts.notifySms, send_email: !!opts.notifyEmail },
    // link_notes carries the reconciliation refs (order id, enrolment) — echoed back
    // verbatim on the webhook so the paid signal can convert the right order.
    ...(opts.notes && typeof opts.notes === 'object' ? { link_notes: opts.notes } : {}),
    ...(opts.expiryTime ? { link_expiry_time: opts.expiryTime } : {}),
    // link_meta.notify_url is the PER-LINK webhook: Cashfree POSTs the payment-link
    // lifecycle (paid/expired/cancelled) HERE, NOT to the global PG webhook. Default it
    // to our own /webhook/cashfree so every Relay-minted link self-wires its callback.
    link_meta: {
      notify_url: opts.notifyUrl || `${env.PUBLIC_BASE_URL || 'https://commsops.afshaan.workers.dev'}/webhook/cashfree`,
      ...(opts.returnUrl ? { return_url: opts.returnUrl } : {}),
    },
  };

  const headers = {
    'Content-Type': 'application/json',
    'x-api-version': env.CASHFREE_API_VERSION || CF_API_VERSION,
    'x-client-id': env.CASHFREE_CLIENT_ID,
    'x-client-secret': env.CASHFREE_CLIENT_SECRET,
    ...(linkId ? { 'x-idempotency-key': linkId } : {}),
  };

  let res, txt;
  try {
    res = await fetch(`${baseUrl(env)}/pg/links`, { method: 'POST', headers, body: JSON.stringify(body) });
    txt = await res.text();
  } catch (e) {
    return { ok: false, error: `cashfree_fetch_failed: ${e?.message || String(e)}` };
  }
  let data = {}; try { data = txt ? JSON.parse(txt) : {}; } catch { data = { _raw: txt }; }
  if (!res.ok) {
    return { ok: false, error: (data && (data.message || data.code)) || `cashfree_${res.status}`, status: res.status, raw: data };
  }
  return {
    ok: true,
    link_url: data.link_url || null,
    link_id: data.link_id || linkId || null,
    cf_link_id: data.cf_link_id || null,
    link_status: data.link_status || null,
    raw: data,
  };
}

// ── Webhook verification ─────────────────────────────────────────────────────────
// Cashfree signs: base64( HMAC-SHA256( x-webhook-timestamp + rawBody, CLIENT_SECRET ) ),
// sent as x-webhook-signature. Verify over the RAW body, before JSON.parse.
async function computeSignature(secret, timestamp, rawBody) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(timestamp) + String(rawBody)));
  // base64 of the raw bytes
  let bin = ''; const bytes = new Uint8Array(sig);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// The webhook signing key: prefer a dedicated CASHFREE_WEBHOOK_SECRET (the newer
// "Add Webhook Endpoint" flow can generate a per-endpoint secret distinct from the API
// client secret), falling back to the client secret (legacy / per-link notify_url path).
function webhookSecret(env) {
  return env.CASHFREE_WEBHOOK_SECRET || env.CASHFREE_CLIENT_SECRET || '';
}
async function verifyWebhook(env, timestamp, rawBody, signature) {
  const secret = webhookSecret(env);
  if (!secret || !signature || !timestamp) return false;
  const expected = await computeSignature(secret, timestamp, rawBody);
  return timingSafeEqual(expected, String(signature));
}

// ── Webhook → /ingest mapping (PURE) ─────────────────────────────────────────────
// Cashfree wraps the link object either directly under `data` or under `data.link`
// depending on API version — read defensively. Anything we cannot confidently map
// (unknown type/status, missing identity) is captured raw for discovery by the handler.
function linkOf(body) {
  const d = (body && body.data) || {};
  return (d.link && typeof d.link === 'object') ? d.link : d;
}

// link_status → the substrate event a wait_response can key on. Terminal only:
//  PAID → payment_link_paid ; EXPIRED/CANCELLED/USER_DROPPED → payment_link_failed.
//  ACTIVE/PARTIALLY_PAID are non-terminal → null (captured, not emitted).
function eventForStatus(status) {
  const s = String(status || '').toUpperCase();
  if (s === 'PAID') return 'payment_link_paid';
  if (s === 'EXPIRED' || s === 'CANCELLED' || s === 'USER_DROPPED' || s === 'FAILED') return 'payment_link_failed';
  return null;
}

function identsFromLink(link) {
  const cd = (link && link.customer_details) || {};
  const out = [];
  const email = cd.customer_email;
  if (email) out.push({ type: 'email', value: String(email).toLowerCase().trim(), is_verified: false });
  const ph = SHOP.normalizePhone(cd.customer_phone);
  if (ph) out.push({ type: 'phone', value: ph, is_verified: false });
  return out;
}

// Build the /ingest envelope for a Cashfree PAYMENT_LINK_EVENT, or null if it is
// non-terminal / has no usable identity (→ handler captures it for discovery).
function mapPaymentLinkEvent(body) {
  const link = linkOf(body);
  const name = eventForStatus(link.link_status);
  if (!name) return null;
  const identifiers = identsFromLink(link);
  if (!identifiers.length) return null;

  const linkId = link.link_id != null ? String(link.link_id) : (link.cf_link_id != null ? String(link.cf_link_id) : '');
  const props = {
    link_id: link.link_id != null ? String(link.link_id) : null,
    cf_link_id: link.cf_link_id != null ? String(link.cf_link_id) : null,
    link_status: link.link_status || null,
    link_amount: num(link.link_amount),
    link_amount_paid: num(link.link_amount_paid),
    currency: link.link_currency || null,
    link_purpose: link.link_purpose || null,
    // link_notes echoes back our reconciliation refs (order id / enrolment) verbatim.
    link_notes: (link.link_notes && typeof link.link_notes === 'object') ? link.link_notes : null,
    source_surface: 'cashfree',
  };
  return {
    identifiers,
    name,
    occurred_at: body && body.event_time ? String(body.event_time) : null,
    properties: props,
    source: 'cashfree',
    // Distinct status transitions each ingest once; a webhook retry dedups.
    idempotency_key: `cashfree:link:${linkId}:${String(link.link_status || '').toUpperCase()}`,
  };
}

module.exports = {
  CF_API_VERSION, baseUrl, isConfigured, createPaymentLink,
  computeSignature, verifyWebhook, timingSafeEqual,
  linkOf, eventForStatus, identsFromLink, mapPaymentLinkEvent,
};
