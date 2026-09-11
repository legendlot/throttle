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
    let val = raw === undefined || raw === null ? '' : String(raw).trim().slice(0, 2000);
    // A checkbox is a boolean, not free text: `false` / 'false' / 'off' / '0' is UNTICKED and must
    // fail `required` (String(false) is 'false', which is truthy — an untick would otherwise
    // satisfy a required "I agree to receive…" box and store "false" as consent evidence).
    // Ticked normalises to 'true' so the stored evidence has one shape.
    // A checkbox WITH `options` is a multi-select list (schema: `options?`), not a boolean —
    // it keeps its comma-joined values; an empty array is empty.
    if (f.type === 'checkbox' && !f.options) val = (Array.isArray(raw) ? raw.length > 0 : /^(true|on|1|yes)$/i.test(val)) ? 'true' : '';
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
  // ⚠️ DEDUPE. `consent` is an append-only ledger, so a repeated channel is a repeated
  // ROW: `channels: Array(500).fill('email')` in one public POST wrote 500 identical
  // opted_in rows. A Set is the whole fix; insertion order survives it, so email stays first.
  channels = [...new Set(channels)];
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
//
// ⛔ THE WORD "NON-REVERSIBLE" WAS FALSE UNTIL S342, AND THE REASON IS WORTH KEEPING.
// A plain SHA-256 of an IP is not a one-way function in any useful sense: the entire IPv4
// space is 2^32 values, so an attacker with the column simply hashes all 4.3 billion and
// reads the addresses straight back — minutes on a laptop. Truncating to 8 bytes does not
// help; it only adds collisions. A hash is only non-reversible when the INPUT space is large,
// and an IP's is tiny. So the digest is keyed with a secret salt, which is what actually
// makes it irreversible to anyone without `FORM_IP_HASH_SALT`.
//
// ⚠️ FAILS CLOSED, deliberately: with no salt configured we store NOTHING rather than quietly
// falling back to the reversible form. Losing an abuse-triage hint is recoverable; silently
// persisting de-anonymisable PII under a comment promising the opposite is not.
// ⚠️ Rotating the salt makes existing hashes incomparable with new ones (same IP, different
// value). That is acceptable — this is a triage hint with no historical claim on it — but it
// means the column must never be used for anything that assumes stability across a rotation.
async function hashIp(ip, env) {
  if (!ip) return null;
  const salt = env && env.FORM_IP_HASH_SALT;
  // Log once rather than degrading in silence: with no salt we store nothing, which on the
  // wire is indistinguishable from "no IP was sent". A fumbled rotation or a fresh environment
  // would otherwise kill abuse triage with no signal anywhere.
  if (!salt) { console.log('form_ip_hash_salt_missing', JSON.stringify({ had_ip: true })); return null; }
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${ip}`));
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

  // ⚠️ EXACTLY ONE identifier goes to resolve_identity. NEVER both.
  //
  // `phone` and `email` are BOTH strong types in comms.resolve_identity (0049). Hand it two
  // strong identifiers that resolve to two DIFFERENT existing profiles and it calls
  // merge_profiles: identifiers/events/consent/suppressions are reassigned and the losing
  // profile row is DELETED. `is_verified` is stored but never consulted in that decision, so
  // `is_verified:false` buys nothing here. On an unauthenticated endpoint that is a stranger
  // holding a destructive merge primitive — and it does not even need an attacker: a SHARED
  // HOUSEHOLD PHONE (two family members, two emails, one WhatsApp number) fuses two real
  // customer profiles and deletes one.
  //
  // Same rule and the same reason as bot-web.js:78-80. Email first because dedupeKey()'s
  // identity precedence is email-first, so the resolved profile and the dedupe key agree.
  const primary = v.email ? { type: 'email', value: v.email, is_verified: false }
                          : { type: 'phone', value: v.phone, is_verified: false };
  const secondary = v.email && v.phone
    ? { type: 'phone', value: v.phone, is_verified: false } : null;

  const key = dedupeKey(form, v);

  // Event first — ingest resolves/creates the profile and runs journey-trigger matching.
  // ⚠️ This EMITS; it does not send. A journey a human activated is the only sender.
  const r = await ingest(env, {
    identifiers: [primary],
    name: 'form_submitted',
    properties: { form: v.slug, kind: form.kind, channels: v.channels, source_url: v.source_url, ...v.payload },
    source: 'website_form',
    idempotency_key: key ? `form:${key}` : null,
  });
  // ⚠️ `r.error` is raw PostgREST text — constraint names, and the failing row itself
  // ("Key (idempotency_key)=(form:bis:a@b.com:SKU1) already exists"), i.e. the submitter's
  // own email echoed to whoever made the request. This endpoint is unauthenticated, so the
  // detail goes to the log (`wrangler tail | grep form_ingest_failed`) and the caller gets a
  // generic 502. 502, not 400: the submission was well-formed; OUR write is what failed.
  if (!r.ok) {
    console.log('form_ingest_failed', JSON.stringify({ form: v.slug, error: r.error }));
    return { ok: false, error: 'capture_failed', status: 502 };
  }
  const profileId = r.profile_id;

  // The OTHER identifier is attached directly, never through the resolver, so it can never
  // force a merge (see the `primary`/`secondary` note above).
  // ⚠️ `on_conflict=type,value` is REQUIRED, exactly as on form_submissions below: the unique
  // constraint here is identifiers_type_value_uniq (0001), and without naming it PostgREST
  // infers the PRIMARY KEY — a fresh uuid — so ignore-duplicates never fires and a phone that
  // already belongs to SOMEONE ELSE raises a raw 23505 instead of being quietly left alone.
  // Leaving it alone is the point: we attach an identifier, we never steal one.
  if (secondary) {
    const ir = await A.sbComms('/rest/v1/identifiers?on_conflict=type,value', env, {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates' },
      body: JSON.stringify({
        profile_id: profileId, type: secondary.type, value: secondary.value,
        is_verified: false, source: 'website_form',
      }),
    });
    // Best-effort: a missing secondary identifier is a lesser fault than losing the capture.
    A.checkWrite('form_identifier_attach_failed', ir, { form: v.slug, type: secondary.type });
  }

  const needsConfirm = form.requires_confirmation === true;
  const confirmToken = needsConfirm ? crypto.randomUUID().replace(/-/g, '') : null;

  // ⭐ ONE TRANSACTION: the submission row and its consent rows land together or not at all
  // (comms.form_capture, migration 0073 — S377, capture-spine residual (e)). They used to be
  // separate calls, consent first, so a failed insert left a consent claim with no submission
  // (its DPDP evidence) and two simultaneous FIRST submits could both write consent.
  // The function keeps every rule the JS used to enforce — read its header before changing them:
  //   • REPEAT SUBMIT (S342): an exact repeat is `deduped` and writes nothing (`consent` is an
  //     append-only evidence ledger; N submits used to leave N identical opted_in rows).
  //   • ⛔ CHANNEL-AWARE (S342 hostile review): channels are NOT in dedupeKey(), so a repeat that
  //     ADDS "also tell me on WhatsApp" widens the stored channels and records consent for the
  //     NEW channel only — a key-only short-circuit left the phone with no whatsapp consent.
  //   • Consent NOW only for a single requested alert, as `service` (gate.js §S274: bypasses
  //     consent + frequency cap, RESPECTS quiet hours and suppression). An ongoing marketing
  //     enrolment (`requires_confirmation`) writes none until /f/confirm — p_consent_purpose NULL.
  //   • `channels` persists the channels the customer CHOSE (0060) — presence is not choice.
  const evidence = {
    form: v.slug, source_url: v.source_url, consent_copy_version: form.consent_copy_version,
    turnstile_ok: true, ua: request.headers.get('user-agent') || null,
    at: new Date().toISOString(),
  };
  const sr = await A.sbComms('/rest/v1/rpc/form_capture', env, {
    method: 'POST',
    body: JSON.stringify({
      p_form_id: form.id, p_profile_id: profileId, p_payload: v.payload, p_dedupe_key: key,
      p_channels: v.channels, p_source_url: v.source_url, p_ip_hash: await hashIp(ip, env),
      p_confirm_token: confirmToken,
      p_consent_purpose: needsConfirm ? null : 'service',
      p_consent_source: `website_form:${v.slug}`, p_evidence: evidence,
    }),
  });
  // Rolled back as a whole, so the customer can simply submit again. Detail goes to the log
  // only — this endpoint is unauthenticated and PostgREST errors echo the failing row.
  if (!sr || sr.ok !== true || !sr.data) {
    console.log('form_submission_insert_failed', JSON.stringify({
      form: v.slug, status: sr?.status ?? null, detail: sr?.data ?? null,
    }));
    return { ok: false, error: 'capture_failed', status: 502 };
  }
  if (sr.data.deduped) return { ok: true, deduped: true };

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

  // ⭐ ONE TRANSACTION (comms.form_confirm, migration 0073 — S377). It locks the submission row
  // (FOR UPDATE), stamps confirmed_at and writes the consent rows together, which retires both
  // holes the old claim-then-write-then-rollback sequence had: (i) a partial consent failure
  // re-wrote the rows that HAD landed on the retry, and (ii) a failed rollback left confirmed_at
  // set with no consent, so the next click answered "You are subscribed" with nothing behind it.
  // A concurrent confirm (double-click, mail-client prefetch) waits on the lock and answers
  // `already`. Rules kept in the function: consent is `marketing` (an ongoing enrolment), one row
  // per channel the customer CHOSE (0060) — the field-presence fallback is for pre-0060 rows only.
  const r = await A.sbComms('/rest/v1/rpc/form_confirm', env, {
    method: 'POST', body: JSON.stringify({ p_token: tok }),
  });
  // Rolled back as a whole: nothing was stamped, so the link stays valid and a click retries.
  if (!r || r.ok !== true || !r.data) {
    console.log('form_confirm_failed', JSON.stringify({ status: r?.status ?? null, detail: r?.data ?? null }));
    return { ok: false, error: 'confirm_failed', status: 502 };
  }
  if (r.data.error === 'invalid_token') return { ok: false, error: 'invalid_token', status: 404 };
  if (r.data.already) return { ok: true, confirmed: true, already: true };
  return { ok: true, confirmed: true };
}

module.exports = { validateSubmission, dedupeKey, verifyTurnstile, handleFormSubmit, handleFormConfirm };
