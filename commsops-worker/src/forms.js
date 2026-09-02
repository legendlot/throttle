// The capture spine (S331, SP1) — embeddable website forms and, later, surveys.
// Spec: docs/superpowers/specs/2026-09-02-relay-capture-spine-design.md
//
// This is commsops' FIRST unauthenticated public write surface. `/ingest` is token-authed
// and must never be exposed; everything the open internet can reach lives behind /f/* with
// origin-scoped CORS (bot-web.js corsHeaders), a Turnstile challenge verified server-side,
// and a honeypot. Modelled deliberately on subscribe.js — read that file first.
//
// ⚠️ NOTHING HERE SENDS. Capture writes rows and emits an event; a human activating a
// journey is the only thing that ever produces a message. One switch, in one place.
const SHOP = require('./shopify.js');

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Pure + unit-tested. Returns {ok:false,error} or the normalized submission.
function validateSubmission(form, body) {
  if (!form || !form.active) return { ok: false, error: 'form_inactive' };
  if (!body || typeof body !== 'object') return { ok: false, error: 'bad_json' };
  // Honeypot: a visually-hidden "website" field — humans leave it empty, bots fill every
  // input. The caller reports success so the bot learns nothing (same lie as subscribe.js).
  if (body.website) return { ok: false, error: 'honeypot' };

  const fields = Array.isArray(form.fields) ? form.fields : [];

  // Only declared keys survive. An undeclared key is dropped, never stored — the payload is
  // author-defined, so accepting arbitrary keys would let anyone write anything into jsonb.
  const payload = {};
  for (const f of fields) {
    const raw = body[f.key];
    const val = raw === undefined || raw === null ? '' : String(raw).trim().slice(0, 2000);
    if (f.required && !val) return { ok: false, error: `missing_field:${f.key}` };
    if (val) payload[f.key] = val;
  }

  const email = payload.email ? payload.email.toLowerCase() : null;
  if (email && !EMAIL_RE.test(email)) return { ok: false, error: 'bad_email' };
  const phone = payload.phone ? (SHOP.normalizePhone(payload.phone) || null) : null;
  if (!email && !phone) return { ok: false, error: 'email_or_phone_required' };
  if (email) payload.email = email;
  if (phone) payload.phone = phone;

  let channels = Array.isArray(body.channels)
    ? body.channels.filter((c) => ['email', 'whatsapp'].includes(c))
    : [];
  if (!channels.length) channels = [email && 'email', phone && 'whatsapp'].filter(Boolean);
  // Never record consent for a channel we cannot reach.
  channels = channels.filter((c) => (c === 'email' ? !!email : !!phone));
  if (!channels.length) return { ok: false, error: 'no_usable_channel' };

  return {
    ok: true, slug: form.slug, email, phone, channels, payload,
    source_url: body.source_url ? String(body.source_url).slice(0, 500) : null,
  };
}

// The identity+content key that makes a submission distinct.
//
// ⚠️ IDENTITY ALONE IS WRONG. Back-in-stock is per-PRODUCT: one customer notifying on five
// SKUs is five legitimate submissions, and a key of `slug:email` would collapse them to one
// and silently lose four alerts. `dedupe_keys` names the content fields that participate.
// An empty dedupe_keys means "never dedupe" (null), which the partial UNIQUE index treats
// as always-distinct — correct for a survey, where every response is its own row.
function dedupeKey(form, v) {
  // Defensive: the handler only calls this after v.ok, but a rejected submission has no
  // .payload and reading through it throws a TypeError rather than failing cleanly.
  if (!v || !v.ok || !v.payload) return null;
  const keys = Array.isArray(form.dedupe_keys) ? form.dedupe_keys : [];
  if (!keys.length) return null;
  const identity = v.email || v.phone;
  return [form.slug, identity, ...keys.map((k) => v.payload[k] || '')].join(':');
}

module.exports = { validateSubmission, dedupeKey };
