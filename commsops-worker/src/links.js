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

/**
 * Look up a code. Returns the row, or null for unknown / expired / retired / malformed.
 *
 * The charset here spans BOTH kinds: mixed-case base62 for a minted recipient code, and lower-case
 * with `-` for a campaign slug. Hence `[A-Za-z0-9-]` rather than the mint alphabet.
 */
async function resolveLink(env, code) {
  if (!code || !/^[A-Za-z0-9][A-Za-z0-9-]{1,63}$/.test(code)) return null;
  const r = await A.sbComms(
    `/rest/v1/links?code=eq.${encodeURIComponent(code)}` +
    `&select=code,kind,target_url,utm,message_id,profile_id,channel,created_at,expires_at,active,click_count,first_clicked_at&limit=1`, env
  ).catch(() => ({ ok: false }));
  const row = (r.ok && r.data?.[0]) || null;
  if (!row) return null;
  if (row.active === false) return null;    // retired — 302s to the fallback, never a 404
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

// ── Per-click detail (0042) ──────────────────────────────────────────────────
// These are pure so the whole classification is testable without a request.

// The IST day for a moment. Extracted rather than inlined because the daily rollup and the
// per-day visitor hash MUST agree on which day a click belongs to — computing it twice from
// two expressions is how they would silently drift apart at the midnight boundary.
function istDayOf(now) {
  return new Date((now instanceof Date ? now.getTime() : now) + 5.5 * 3600_000)
    .toISOString().slice(0, 10);
}

// `?s=` on the incoming URL, from the QR image. WHITELISTED, never free text: this value is
// entirely caller-controllable, so an open string would let anyone write arbitrary data into the
// analytics table by hand-crafting a URL. It is a label and nothing more — see countsAsClick,
// which it must never influence.
const CLICK_SOURCES = new Set(['qr', 'link']);
function clickSource(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  return CLICK_SOURCES.has(s) ? s : null;
}

// HOST ONLY, deliberately. A full referrer can carry search terms or a private page path, and we
// have no reason to keep either — "which site sent them" is the whole question.
function refererHost(referer) {
  if (!referer) return null;
  try { return new URL(String(referer)).hostname || null; } catch { return null; }
}

/**
 * Coarse device/os/browser buckets from a user agent.
 *
 * Deliberately crude: a UA-parsing library would be a dependency, a bundle cost and a maintenance
 * tail for a question ("was this a phone?") that only needs three buckets. Order matters in the
 * browser ladder — Edge, Opera, Samsung and Chrome UAs all contain "Safari", and Chrome's contains
 * "Safari" too, so the specific engines must be tested BEFORE the generic ones.
 */
function parseUa(ua) {
  const s = ua ? String(ua) : '';
  if (!s) return { device: null, os: null, browser: null };
  // Android tablets are identified by the ABSENCE of "Mobile", which is the documented convention.
  const tablet = /iPad|Tablet|PlayBook|Silk/i.test(s) || (/Android/i.test(s) && !/Mobile/i.test(s));
  const mobile = !tablet && /Mobi|iPhone|iPod|Android|Windows Phone/i.test(s);
  return {
    device: tablet ? 'tablet' : mobile ? 'mobile' : 'desktop',
    os: /iPhone|iPad|iPod|iOS/i.test(s) ? 'iOS'
      : /Android/i.test(s) ? 'Android'
      : /Windows/i.test(s) ? 'Windows'
      : /Mac OS X|Macintosh/i.test(s) ? 'macOS'
      : /Linux/i.test(s) ? 'Linux' : null,
    browser: /Edg[A-Z]?\//i.test(s) ? 'Edge'
      : /OPR\/|Opera/i.test(s) ? 'Opera'
      : /SamsungBrowser/i.test(s) ? 'Samsung Internet'
      : /Firefox\/|FxiOS/i.test(s) ? 'Firefox'
      : /Chrome\/|CriOS/i.test(s) ? 'Chrome'
      : /Safari\//i.test(s) ? 'Safari' : null,
  };
}

/**
 * A per-DAY visitor key. Enables "how many distinct people clicked today" without storing anything
 * that identifies anyone.
 *
 * ⚠️ The IST day is part of the hash INPUT, which is the entire privacy property: the same person
 * hashes to a different value tomorrow, so these keys cannot be joined across days to build a
 * history of one person. The link code is also mixed in, so the same person on two links does not
 * collide either. NO IP IS EVER STORED — only this digest.
 *
 * Consequence for the UI: a lifetime "unique visitors" number is NOT derivable and must not be
 * shown. Per-day uniques are honest; summing them is not.
 */
async function visitorKey({ code, ip, ua, istDay } = {}) {
  if (!code || (!ip && !ua)) return null;
  const bytes = new TextEncoder().encode(`${istDay || ''}|${code}|${ip || ''}|${ua || ''}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].slice(0, 16)
    .map((b) => b.toString(16).padStart(2, '0')).join('');
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
async function recordClick(env, row, meta = {}) {
  const now = new Date();
  const first = !row.first_clicked_at ? { first_clicked_at: now.toISOString() } : {};
  await A.sbComms(`/rest/v1/links?code=eq.${encodeURIComponent(row.code)}`, env, {
    method: 'PATCH',
    body: JSON.stringify({
      click_count: Number(row.click_count || 0) + 1, last_clicked_at: now.toISOString(), ...first,
    }),
  }).catch((e) => console.log('link_click_count_error', String(e?.message || e)));

  // Daily rollup, via an atomic RPC. A read-modify-write would lose concurrent clicks, which on a
  // printed QR is the normal case rather than the edge one. Dated in IST, matching every other LOT
  // day-grain (RULE-SALES-001) so a chart here lines up with one in Odo.
  const istDay = istDayOf(now);
  await A.sbComms('/rest/v1/rpc/bump_link_click', env, {
    method: 'POST', body: JSON.stringify({ p_code: row.code, p_day: istDay }),
  }).catch((e) => console.log('link_click_daily_error', String(e?.message || e)));

  // Per-click detail (0042). The rollup above cannot attribute a click to a DESTINATION, so after a
  // campaign link is repointed it can no longer say which target a click actually reached. This row
  // can, because it copies the destination resolved at THIS tap.
  //
  // Independently try/caught from everything else on purpose: this is the newest and least
  // load-bearing of the three writes, and it must never be the reason a click goes uncounted in the
  // two aggregates that predate it.
  try {
    const ua = meta.ua || null;
    const { device, os, browser } = parseUa(ua);
    await A.sbComms('/rest/v1/link_click', env, {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        code: row.code,
        clicked_at: now.toISOString(),
        // targetFor(), NOT row.target_url — the stored utm is part of where the customer actually
        // landed, and this column is a record of that, not of the row's configuration.
        target_url: targetFor(row),
        source: clickSource(meta.source),
        device, os, browser,
        referrer_host: refererHost(meta.referer),
        country: meta.country || null,
        visitor_key: await visitorKey({ code: row.code, ip: meta.ip, ua, istDay }),
        message_id: row.message_id || null,
        profile_id: row.profile_id || null,
      }),
    });
  } catch (e) { console.log('link_click_detail_error', String(e?.message || e)); }

  // Events are profile-scoped, so a CAMPAIGN link has nowhere to land one — the rollup above is its
  // entire analytics story, and that is by design, not a gap to "fix" by inventing a profile.
  if (!row.profile_id) return;
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

// ── Campaign links (kind='campaign') ─────────────────────────────────────────
// A campaign slug is the OPPOSITE of a minted recipient code: chosen, memorable, permanent, printed
// on packaging, shared with thousands of strangers. That is safe ONLY because a campaign link carries
// no personal context. See migration 0040 for the full kind table — the two must not be unified.
//
// `-` but not `_`, no dots, no unicode: a slug has to survive being read off a printed box and typed
// by hand. Lower-case only, so the same QR can never be two links.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;

function normalizeSlug(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  return SLUG_RE.test(s) ? s : null;
}

/**
 * Create an author-made campaign link. Distinct from `mintLink` on purpose: different code source
 * (chosen, not random), no expiry, and a title — the divergence is the point, not an oversight.
 *
 * `expires_at` is left NULL forever. A printed QR that expires is dead artwork nobody can recall.
 */
async function createCampaignLink(env, { slug, target, title, utm, userId } = {}) {
  const code = normalizeSlug(slug);
  if (!code) return { ok: false, error: 'invalid_slug' };
  let parsed;
  try { parsed = new URL(target); } catch { return { ok: false, error: 'invalid_target' }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, error: 'invalid_target' };

  const r = await A.sbComms('/rest/v1/links', env, {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      code, kind: 'campaign', target_url: target, title: title || null,
      utm: utm || null, expires_at: null, created_by: userId || null,
    }),
  }).catch((e) => ({ ok: false, data: String(e?.message || e) }));

  // 23505 = the slug is taken. Distinct error, because "that name is already used" and "something
  // broke" want completely different things from the person at the form.
  if (!r.ok) {
    const dup = JSON.stringify(r.data || '').includes('23505');
    return { ok: false, error: dup ? 'slug_taken' : 'create_failed', detail: r.data };
  }
  return { ok: true, link: Array.isArray(r.data) ? r.data[0] : r.data };
}

/**
 * Edit a campaign link. Target, title, utm and active only.
 *
 * ⚠️ `code` and `kind` are NEVER editable. A printed code is immutable by definition — the artwork is
 * already in customers' hands — and a recipient link must never become a campaign link, which would
 * make one customer's cart context permanent and guessable.
 *
 * A target change writes an append-only `link_changes` row BEFORE the update. That log is the only
 * thing that can answer "where did this QR point in March?", which the row itself cannot.
 */
async function updateCampaignLink(env, { code, target, title, utm, active, reason, userId } = {}) {
  const cur = await A.sbComms(
    `/rest/v1/links?code=eq.${encodeURIComponent(code || '')}&select=code,kind,target_url&limit=1`, env
  ).catch(() => ({ ok: false }));
  const row = (cur.ok && cur.data?.[0]) || null;
  if (!row) return { ok: false, error: 'not_found' };
  if (row.kind !== 'campaign') return { ok: false, error: 'not_a_campaign_link' };

  const patch = { updated_by: userId || null, updated_at: new Date().toISOString() };
  if (title !== undefined) patch.title = title || null;
  if (utm !== undefined) patch.utm = utm || null;
  if (active !== undefined) patch.active = !!active;

  if (target !== undefined && target !== row.target_url) {
    let parsed;
    try { parsed = new URL(target); } catch { return { ok: false, error: 'invalid_target' }; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, error: 'invalid_target' };
    // Audit first: if the update then fails, we have a claimed change that did not happen, which is
    // recoverable by reading the row. The reverse — a silent change with no record — is not.
    await A.sbComms('/rest/v1/link_changes', env, {
      method: 'POST',
      body: JSON.stringify({
        code: row.code, old_target_url: row.target_url, new_target_url: target,
        reason: reason || null, changed_by: userId || null,
      }),
    }).catch((e) => console.log('link_change_audit_error', String(e?.message || e)));
    patch.target_url = target;
  }

  const r = await A.sbComms(`/rest/v1/links?code=eq.${encodeURIComponent(row.code)}`, env, {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch),
  }).catch((e) => ({ ok: false, data: String(e?.message || e) }));
  if (!r.ok) return { ok: false, error: 'update_failed', detail: r.data };
  return { ok: true, link: Array.isArray(r.data) ? r.data[0] : r.data };
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
  istDayOf, clickSource, refererHost, parseUa, visitorKey,
  normalizeSlug, createCampaignLink, updateCampaignLink, SLUG_RE,
  CODE_ALPHABET, CODE_LENGTH, FALLBACK_URL, DEFAULT_TTL_DAYS, BOT_UA,
};
