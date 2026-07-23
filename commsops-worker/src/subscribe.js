// Public mailing-list / "notify me" signup seam (S232) — the website's launch-list forms
// post here (same publishable PIXEL_TOKEN the storefront pixel already embeds; the
// server-to-server INGEST_TOKEN can never live in browser JS).
//
// One submission produces three durable things:
//   1. a `list_signup` event {list} — the journey trigger (filter list=<slug> for an
//      instant "you're on the list" confirmation), idempotent per (list, identifier)
//      so re-submits never re-fire the journey;
//   2. explicit opted-in marketing consent per usable channel — the STRONGEST consent
//      class we hold; the form payload itself is the DPDP s.6(10) evidence;
//   3. a `list:<slug>` profile attribute (value = signup date) — the segment key for
//      launch-day broadcasts ("attr list:drift2-launch is not empty").
const A = require('./auth.js');
const { ingest } = require('./ingest.js');
const { recordConsent } = require('./consent.js');
const SHOP = require('./shopify.js');

const LIST_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Pure + unit-tested. Returns {ok:false,error} or the normalized signup.
function validateSignup(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'bad_json' };
  // Honeypot: a visually-hidden "website" field — humans leave it empty, bots fill
  // every input. Report success so the bot learns nothing.
  if (body.website) return { ok: false, error: 'honeypot' };
  const list = String(body.list || '').toLowerCase().trim();
  if (!LIST_RE.test(list)) return { ok: false, error: 'bad_list' };
  const email = body.email ? String(body.email).toLowerCase().trim() : null;
  if (email && !EMAIL_RE.test(email)) return { ok: false, error: 'bad_email' };
  const phone = SHOP.normalizePhone(body.phone) || null;
  if (!email && !phone) return { ok: false, error: 'email_or_phone_required' };
  let channels = Array.isArray(body.channels)
    ? body.channels.filter((c) => ['email', 'whatsapp', 'sms'].includes(c))
    : [];
  if (!channels.length) channels = [email && 'email', phone && 'whatsapp'].filter(Boolean);
  // Never record consent for a channel we can't reach: whatsapp/sms need the phone, email the email.
  channels = channels.filter((c) => (c === 'email' ? !!email : !!phone));
  if (!channels.length) return { ok: false, error: 'no_usable_channel' };
  return {
    ok: true, list, email, phone, channels,
    name: body.name ? String(body.name).trim().slice(0, 120) : null,
    source_url: body.source_url ? String(body.source_url).slice(0, 500) : null,
  };
}

async function handleSubscribe(env, request) {
  if (!env.PIXEL_TOKEN) return { ok: false, error: 'signup_unconfigured', status: 503 };
  let body; try { body = await request.json(); } catch { return { ok: false, error: 'bad_json', status: 400 }; }
  if (!body || body.token !== env.PIXEL_TOKEN) return { ok: false, error: 'unauthorised', status: 401 };
  const v = validateSignup(body);
  if (!v.ok) {
    if (v.error === 'honeypot') return { ok: true, subscribed: true };   // lie to bots
    return { ok: false, error: v.error, status: 400 };
  }

  const identifiers = [];
  if (v.email) identifiers.push({ type: 'email', value: v.email, is_verified: false });
  if (v.phone) identifiers.push({ type: 'phone', value: v.phone, is_verified: false });

  // Event first — ingest resolves/creates the profile (and runs journey-trigger matching).
  const r = await ingest(env, {
    identifiers, name: 'list_signup',
    properties: { list: v.list, channels: v.channels, source_url: v.source_url, source_surface: 'website_form' },
    source: 'website_form',
    idempotency_key: `signup:${v.list}:${v.email || v.phone}`,
  });
  if (!r.ok) return { ok: false, error: r.error, status: 400 };
  const profileId = r.profile_id;

  // Explicit form opt-in per channel. recordConsent's fail-closed guard applies as usual;
  // a signup is genuinely allowed to flip an earlier opt-out back on — the person just
  // asked us to message them.
  const evidence = {
    list: v.list, source_url: v.source_url,
    ua: request.headers.get('user-agent') || null, at: new Date().toISOString(),
  };
  for (const channel of v.channels) {
    await recordConsent(env, {
      profile_id: profileId, channel, purpose: 'marketing', state: 'opted_in',
      source: `website_form:${v.list}`, evidence,
    });
  }

  // Attribute stamp (read-modify-write, same pattern as the set_attr action node).
  const pr = await A.sbComms(`/rest/v1/profiles?id=eq.${A.enc(profileId)}&select=attributes,display_name&limit=1`, env);
  const attrs = (pr.ok && pr.data?.[0]?.attributes) || {};
  attrs[`list:${v.list}`] = new Date().toISOString().slice(0, 10);
  const patch = { attributes: attrs, updated_at: new Date().toISOString() };
  if (v.name && !(pr.ok && pr.data?.[0]?.display_name)) patch.display_name = v.name;   // fill-when-empty only
  await A.sbComms(`/rest/v1/profiles?id=eq.${A.enc(profileId)}`, env, { method: 'PATCH', body: JSON.stringify(patch) });

  return { ok: true, subscribed: true, list: v.list, channels: v.channels };
}

module.exports = { handleSubscribe, validateSignup };
