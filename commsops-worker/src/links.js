// Phase-B first-party link redirect — `https://<short-host>/r/<code>` → 302 → target.
//
// Exists because two things Phase A (src/tracking.js) structurally cannot do:
//   1. A WhatsApp URL-button's base is frozen at Meta APPROVAL and the template variable is only
//      a suffix appended to it, so there is no send-time hook to rewrite the resolved link.
//   2. `link_clicked` has 0 events ever on every non-email channel — nothing we own sits between
//      the customer's tap and the destination.
// Both reduce to the same missing primitive: a link we own and can resolve per recipient.
//
// The code is a CAPABILITY, not an identifier. It maps to one customer's cart or order, so it is
// random, expiring, and carries no personal data in the path. Never make it sequential or derive
// it from a message/profile id.
const A = require('./auth.js');
const { appendUtm } = require('./tracking.js');

// Base62. No punctuation, so the code needs no escaping anywhere in a URL path, and no `-`/`_`
// that a mail client or WhatsApp might treat as a word boundary when linkifying.
const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const CODE_LENGTH = 22;   // ~131 bits — spec floor is 16 chars

// Where an unresolvable code lands. A customer who taps a real link must never see an error page.
const FALLBACK_URL = 'https://legendoftoys.com';

// Default lifetime. Cart and browse links are stale long before this; the expiry exists to bound
// the capability, not to model the offer.
const DEFAULT_TTL_DAYS = 30;

/**
 * Unguessable link code. Takes NO arguments by design — nothing about the customer can end up
 * in the path even by a later caller's mistake.
 *
 * Rejection-sampled rather than `byte % 62`: 256 = 4*62 + 8, so a plain modulo would favour the
 * first 8 characters by ~1.25x and shrink the real keyspace. Bytes >= 248 are redrawn.
 */
function newLinkCode() {
  const out = [];
  const buf = new Uint8Array(CODE_LENGTH * 2);
  while (out.length < CODE_LENGTH) {
    crypto.getRandomValues(buf);
    for (let i = 0; i < buf.length && out.length < CODE_LENGTH; i++) {
      if (buf[i] < 248) out.push(CODE_ALPHABET[buf[i] % 62]);
    }
  }
  return out.join('');
}

/**
 * The configured short host, e.g. `https://go.legendoftoys.com`. NULL is the OFF switch for the
 * whole feature: no host ⇒ no minting ⇒ every button behaves exactly as it does today. That is
 * what lets this ship and sit inert before the DNS exists, and be switched on with one UPDATE
 * rather than a deploy.
 *
 * Fail-soft on an unreadable settings row — the send path must never be lost to an attribution
 * lookup (same rule as `utm_defaults` in send.js).
 */
async function getLinkBaseUrl(env) {
  try {
    const s = await A.sbComms('/rest/v1/settings?id=eq.1&select=link_base_url&limit=1', env);
    const v = (s.ok && s.data?.[0]?.link_base_url) || null;
    return v ? String(v).replace(/\/+$/, '') : null;
  } catch { return null; }
}

/**
 * Mint one code bound to (target, message, recipient). Returns the code, or null if the feature
 * is off / the target is unusable — callers treat null as "leave the link alone".
 *
 * ⚠️ A THROWN error here is different from a null and must stay that way. Null means "not
 * redirect-backed, carry on"; a throw means the link genuinely could not be created, and for a
 * template already approved as `/r/{{1}}` there is no untracked link to fall back to — the button
 * would land on the homepage instead of the customer's cart. send.js turns that into a failed
 * send, which is visible and retried, rather than invisible damage.
 */
async function mintLink(env, { baseUrl, target, utm, messageId, profileId, channel, ttlDays } = {}) {
  if (!baseUrl || !target) return null;
  let parsed;
  try { parsed = new URL(target); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  const code = newLinkCode();
  const expires = new Date(Date.now() + (ttlDays || DEFAULT_TTL_DAYS) * 86400_000).toISOString();
  const row = {
    code, target_url: target, utm: utm || null,
    message_id: messageId || null, profile_id: profileId || null,
    channel: channel || null, expires_at: expires,
  };

  // One retry. A code collision is not a real risk at 131 bits; this covers a transient
  // PostgREST/network blip, which is the only realistic failure of a single small insert.
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await A.sbComms('/rest/v1/links', env, {
      method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row),
    }).catch((e) => ({ ok: false, data: String(e?.message || e) }));
    if (r.ok) return code;
    if (attempt === 1) throw new Error(`link_mint_failed:${JSON.stringify(r.data)}`);
  }
  return null;
}

/** Look up a code. Returns the row, or null for unknown/expired/malformed. */
async function resolveLink(env, code) {
  if (!code || !/^[A-Za-z0-9]{8,64}$/.test(code)) return null;
  const r = await A.sbComms(
    `/rest/v1/links?code=eq.${encodeURIComponent(code)}` +
    `&select=code,target_url,utm,message_id,profile_id,channel,created_at,expires_at,click_count,first_clicked_at&limit=1`, env
  ).catch(() => ({ ok: false }));
  const row = (r.ok && r.data?.[0]) || null;
  if (!row) return null;
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) return null;
  return row;
}

/**
 * The destination for a resolved row, with its stored utm applied.
 *
 * ⚠️ `appendUtm` is host-scoped and that is KEPT deliberately: a third-party target (the Shopflo
 * checkout the cart-recovery templates point at, a carrier tracking page) is returned pristine.
 * Tagging someone else's URL would not reach GA4 anyway — attribution happens on legendoftoys.com —
 * and rewriting a payment or tracking link is exactly the kind of thing that breaks silently.
 * Those targets still get the CLICK recorded, which is the win for them.
 */
function targetFor(row) {
  if (!row?.target_url) return FALLBACK_URL;
  return appendUtm(row.target_url, row.utm || {});
}

// Link-preview fetchers and other non-humans. WhatsApp, Slack, Telegram and every mail client
// prefetch URLs to build a card; each of those would otherwise register as a click.
const BOT_UA = /(bot|crawler|spider|preview|facebookexternalhit|whatsapp|slackbot|telegram|twitterbot|discord|linkedinbot|embedly|curl|wget|python-requests|headless|monitor|pingdom|uptime)/i;

/**
 * Does this hit count as a real click? Pure, so the rule is testable without a request.
 *
 * Without this the click-through rate reads high and the number quietly becomes useless — worse
 * than having no number at all. Three filters:
 *   - not a GET (HEAD is a prefetch probe by definition),
 *   - a known bot/preview user-agent,
 *   - landing within a second of the message being sent — no human taps that fast, so it is the
 *     sending platform building its own preview.
 * A filtered hit STILL REDIRECTS. This decides counting only.
 */
function countsAsClick({ method, ua, sentAt, now } = {}) {
  if ((method || 'GET').toUpperCase() !== 'GET') return false;
  if (ua && BOT_UA.test(ua)) return false;
  if (sentAt) {
    const t = Date.parse(sentAt);
    if (Number.isFinite(t) && (now || Date.now()) - t < 1000) return false;
  }
  return true;
}

/**
 * Record a counted click: increment the row and emit `link_clicked`.
 *
 * Best-effort by contract — the caller runs this via ctx.waitUntil, never awaited before the 302.
 * A failed analytics write must never cost the customer their click.
 *
 * ⚠️ The event name is `link_clicked`, channel-agnostic. S189 renamed it precisely so WhatsApp and
 * SMS clicks land in the same place as email's Resend-sourced ones. Never `wa_clicked`/`sms_clicked`.
 */
async function recordClick(env, row) {
  const first = !row.first_clicked_at ? { first_clicked_at: new Date().toISOString() } : {};
  await A.sbComms(`/rest/v1/links?code=eq.${encodeURIComponent(row.code)}`, env, {
    method: 'PATCH',
    body: JSON.stringify({ click_count: Number(row.click_count || 0) + 1, ...first }),
  }).catch((e) => console.log('link_click_count_error', String(e?.message || e)));

  if (!row.profile_id) return;   // events are profile-scoped; an unbound link has nowhere to land
  await A.sbComms('/rest/v1/events', env, {
    method: 'POST',
    body: JSON.stringify({
      profile_id: row.profile_id,
      name: 'link_clicked',
      source: 'relay_redirect',
      properties: {
        url: row.target_url, channel: row.channel || null,
        message_id: row.message_id || null, code: row.code,
      },
    }),
  }).catch((e) => console.log('link_clicked_event_error', String(e?.message || e)));
}

/**
 * Reproduce what Meta does to a URL button: substitute the ONE trailing `{{1}}` with the resolved
 * suffix parameter. `targetBase` is the button's real destination — i.e. exactly what its approved
 * `url` is today, copied across at opt-in time — so migrating a template is a copy, not a rewrite.
 *
 * A static button (no `{{1}}`) ignores the suffix rather than concatenating onto it. A variable
 * button with no suffix resolves to the bare base: a customer must never be shown a literal
 * `{{1}}`.
 */
function buildButtonTarget(targetBase, suffix) {
  if (!targetBase) return null;
  if (!targetBase.includes('{{1}}')) return targetBase;
  return targetBase.replace('{{1}}', suffix == null ? '' : String(suffix));
}

/**
 * Rewrite redirect-backed URL-button parameters in a rendered WhatsApp template's components,
 * IN PLACE, replacing each suffix with a freshly minted code.
 *
 * The opt-in is `template.content.buttons[i].target_base` — authoring-side only, never sent to
 * Meta. A button without it is left completely alone, which is what allows templates to migrate
 * one at a time behind their own Meta re-approval (S241: never edit a template a live journey
 * depends on).
 *
 * `mint` is injected so the whole rule is unit-testable without a database.
 *
 * ⚠️ A mint failure is DELIBERATELY allowed to propagate. Once a template is approved as
 * `/r/{{1}}` there is no untracked link to fall back to, so a swallowed failure would deliver a
 * cart-recovery message whose only CTA drops the customer on the homepage — invisible damage that
 * later reads as a conversion problem. The caller turns this into a failed send instead.
 */
async function applyButtonRedirects(components, { template, baseUrl, mint } = {}) {
  if (!baseUrl || !Array.isArray(components)) return components;
  const buttons = template?.content?.buttons;
  if (!Array.isArray(buttons) || !buttons.length) return components;

  for (const comp of components) {
    if (comp?.type !== 'button') continue;
    if ((comp.sub_type || 'url') !== 'url') continue;      // quick_reply carries a payload, not a link
    const spec = buttons[Number(comp.index ?? 0)];
    if (!spec?.target_base) continue;                       // not opted in — today's behaviour exactly
    const param = (comp.parameters || []).find((p) => p.type === 'text');
    const target = buildButtonTarget(spec.target_base, param?.text);
    if (!target) continue;
    const code = await mint(target);
    if (!code) continue;
    if (param) param.text = code;
    else (comp.parameters = comp.parameters || []).push({ type: 'text', text: code });
  }
  return components;
}

module.exports = {
  newLinkCode, getLinkBaseUrl, mintLink, resolveLink, targetFor, countsAsClick, recordClick,
  buildButtonTarget, applyButtonRedirects,
  CODE_ALPHABET, CODE_LENGTH, FALLBACK_URL, DEFAULT_TTL_DAYS, BOT_UA,
};
