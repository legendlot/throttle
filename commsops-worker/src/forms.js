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
const A = require('./auth.js');
const { ingest } = require('./ingest.js');
const { recordConsent } = require('./consent.js');

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

const TURNSTILE_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// ⚠️ FAILS CLOSED on every abnormal path — empty token, network error, non-200, missing
// secret. This is the only thing standing between the open internet and a profile write,
// and a challenge that passes when it cannot reach its verifier is not a challenge at all.
// (Same posture as gate.js's suppression/freq-cap reads: an unreadable check BLOCKS.)
async function verifyTurnstile(env, token, ip) {
  if (!env || !env.TURNSTILE_SECRET) return false;
  if (!token) return false;
  try {
    const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
    if (ip) body.set('remoteip', ip);
    const r = await fetch(TURNSTILE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!r.ok) return false;
    const j = await r.json();
    return j && j.success === true;
  } catch {
    return false;
  }
}

// A stable, non-reversible client hint for abuse triage. NOT an identifier and never joined
// on — a raw IP in a jsonb column is PII we have no use for.
async function hashIp(ip) {
  if (!ip) return null;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function handleFormSubmit(env, request) {
  let body; try { body = await request.json(); } catch { return { ok: false, error: 'bad_json', status: 400 }; }
  const slug = String((body && body.form) || '').toLowerCase().trim();
  if (!slug) return { ok: false, error: 'form_required', status: 400 };

  // ⚠️ ORDER MATTERS. The challenge is verified BEFORE the form is even looked up, so an
  // unchallenged request cannot use this endpoint to probe which form slugs exist.
  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (!(await verifyTurnstile(env, body.turnstile_token, ip))) {
    return { ok: false, error: 'challenge_failed', status: 403 };
  }

  const fr = await A.sbComms(
    `/rest/v1/forms?slug=eq.${A.enc(slug)}&active=is.true&select=*&limit=1`, env);
  const form = fr.ok ? fr.data?.[0] : null;
  if (!form) return { ok: false, error: 'form_not_found', status: 404 };

  const v = validateSubmission(form, body);
  if (!v.ok) {
    if (v.error === 'honeypot') return { ok: true, submitted: true };   // lie to bots
    return { ok: false, error: v.error, status: 400 };
  }

  const identifiers = [];
  if (v.email) identifiers.push({ type: 'email', value: v.email, is_verified: false });
  if (v.phone) identifiers.push({ type: 'phone', value: v.phone, is_verified: false });

  const key = dedupeKey(form, v);

  // Event first — ingest resolves/creates the profile and runs journey-trigger matching.
  // ⚠️ This EMITS; it does not send. A journey a human activated is the only sender.
  const r = await ingest(env, {
    identifiers,
    name: 'form_submitted',
    properties: { form: v.slug, kind: form.kind, channels: v.channels, source_url: v.source_url, ...v.payload },
    source: 'website_form',
    idempotency_key: key ? `form:${key}` : null,
  });
  if (!r.ok) return { ok: false, error: r.error, status: 400 };
  const profileId = r.profile_id;

  const needsConfirm = form.requires_confirmation === true;
  const confirmToken = needsConfirm ? crypto.randomUUID().replace(/-/g, '') : null;

  // Consent NOW only when this is a single requested alert. An ongoing marketing enrolment
  // writes nothing until the person confirms — an unconfirmed submission must never become
  // a sendable audience.
  if (!needsConfirm) {
    const evidence = {
      form: v.slug, source_url: v.source_url, consent_copy_version: form.consent_copy_version,
      turnstile_ok: true, ua: request.headers.get('user-agent') || null,
      at: new Date().toISOString(),
    };
    for (const channel of v.channels) {
      // `service`, not `marketing`: gate.js:181 — bypasses consent + frequency cap, RESPECTS
      // quiet hours and suppression. Exactly the semantics a requested alert wants.
      await recordConsent(env, {
        profile_id: profileId, channel, purpose: 'service', state: 'opted_in',
        source: `website_form:${v.slug}`, evidence,
      });
    }
  }

  // ⚠️ `on_conflict` IS REQUIRED, not decoration. Without it PostgREST infers the PRIMARY KEY,
  // which is a fresh uuid on every insert — so no conflict is ever detected, ignore-duplicates
  // never fires, and the unique index raises a raw 23505 instead of a silent no-op.
  await A.sbComms(key ? '/rest/v1/form_submissions?on_conflict=form_id,dedupe_key'
                      : '/rest/v1/form_submissions', env, {
    method: 'POST',
    headers: key ? { Prefer: 'resolution=ignore-duplicates' } : {},
    body: JSON.stringify({
      form_id: form.id, profile_id: profileId, payload: v.payload, dedupe_key: key,
      source_url: v.source_url, ip_hash: await hashIp(ip), turnstile_ok: true,
      confirm_token: confirmToken,
    }),
  });

  return { ok: true, submitted: true, slug: v.slug, channels: v.channels };
}

// The second half of confirmed opt-in. Until this runs, a marketing enrolment has a
// submission row and NO consent row, so it cannot be sent to by anything.
//
// ⚠️ The consent written here is `marketing`, not `service`: the person is enrolling in
// ongoing sends, which is exactly what `marketing` gates (purposes.js needsOptIn). Only a
// single alert the customer requested is `service`.
async function handleFormConfirm(env, token) {
  const tok = String(token || '').trim();
  if (!tok) return { ok: false, error: 'invalid_token', status: 400 };

  const sr = await A.sbComms(
    `/rest/v1/form_submissions?confirm_token=eq.${A.enc(tok)}` +
    `&select=*,forms(slug,consent_copy_version)&limit=1`, env);
  const sub = sr.ok ? sr.data?.[0] : null;
  if (!sub) return { ok: false, error: 'invalid_token', status: 404 };

  // Idempotent: a second click is a no-op, not a second consent row.
  if (sub.confirmed_at) return { ok: true, confirmed: true, already: true };

  const now = new Date().toISOString();
  const evidence = {
    form: sub.forms?.slug || null, source_url: sub.source_url || null,
    consent_copy_version: sub.forms?.consent_copy_version ?? null,
    submitted_at: sub.submitted_at || null, confirmed_at: now, turnstile_ok: true,
  };
  const channels = [sub.payload?.email && 'email', sub.payload?.phone && 'whatsapp'].filter(Boolean);
  for (const channel of channels) {
    await recordConsent(env, {
      profile_id: sub.profile_id, channel, purpose: 'marketing', state: 'opted_in',
      source: `website_form:${sub.forms?.slug || 'unknown'}`, evidence, captured_at: now,
    });
  }

  await A.sbComms(`/rest/v1/form_submissions?id=eq.${A.enc(sub.id)}`, env, {
    method: 'PATCH', body: JSON.stringify({ confirmed_at: now }),
  });
  return { ok: true, confirmed: true };
}

module.exports = { validateSubmission, dedupeKey, verifyTurnstile, handleFormSubmit, handleFormConfirm };
