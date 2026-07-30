// Pure UTM link tagging. No I/O — plain string/URL functions, unit-testable in isolation.
// Rewrites LOT-owned destination URLs in a rendered message body to carry utm_* params so
// GA4 → Odo attributes Relay-driven traffic. Idempotent, host-scoped: never touches
// third-party links, the unsubscribe URL, or a URL that already carries utm_*.

// LOT-owned hosts whose links we tag. Suffix-matched (host === h || host endsWith '.'+h).
// Extend here if a new owned domain appears (mirrors the LUMP_SUM_PARTS hardcoded-set precedent).
const LOT_HOSTS = ['legendoftoys.com', 'ed7e3f-cf.myshopify.com'];

function isLotHost(host) {
  host = (host || '').toLowerCase();
  return LOT_HOSTS.some((h) => host === h || host.endsWith('.' + h));
}

// Append utm_* params to a single URL — iff it is an http(s) LOT-owned URL that does not
// already carry any utm_* param. Returns the URL unchanged otherwise (relative, mailto:,
// tel:, third-party host, already-tagged, or unparseable). Empty/undefined params skipped.
function appendUtm(rawUrl, params) {
  let u;
  try { u = new URL(rawUrl); } catch { return rawUrl; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return rawUrl;
  if (!isLotHost(u.hostname)) return rawUrl;
  for (const k of u.searchParams.keys()) if (k.toLowerCase().startsWith('utm_')) return rawUrl;
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    u.searchParams.append(k, String(v));
  }
  return u.toString();
}

// Rewrite links in a rendered body through appendUtm.
//   mode 'html' (default): only href="..."/href='...' attributes (leaves img src, visible text).
//   mode 'text': bare http(s) URLs.
// skip = iterable/Set of exact URLs to leave untouched (e.g. the unsubscribe URL).
function tagLinks(body, { params, skip, mode } = {}) {
  if (!body) return body;
  const skipSet = skip instanceof Set ? skip : new Set(skip || []);
  const p = params || {};
  if (mode === 'text') {
    return body.replace(/\bhttps?:\/\/[^\s<>"')]+/gi, (url) =>
      skipSet.has(url) ? url : appendUtm(url, p));
  }
  return body.replace(/(href\s*=\s*)(["'])(.*?)\2/gi, (m, pre, q, url) =>
    skipSet.has(url) ? m : `${pre}${q}${appendUtm(url, p)}${q}`);
}

// The five standard utm_* keys. An author may also supply extra keys: anything without the
// prefix is FORCED into the utm_ namespace (`ref` -> `utm_ref`) rather than passed through.
// These values become query params on customer-facing links, so a key that could land outside
// utm_* would be an injection surface — namespacing them is what makes custom keys safe.
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

// Accept either {utm_source: 'x'} or the shorthand {source: 'x'} an author is likely to type;
// every key comes back utm_-prefixed. Blanks are dropped so an empty field never overrides a
// more general layer.
function normalizeUtm(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null || String(v).trim() === '') continue;
    const key = String(k).toLowerCase();
    const full = key.startsWith('utm_') ? key : `utm_${key}`;
    if (!full.startsWith('utm_') || full === 'utm_') continue;
    out[full] = String(v).trim();
  }
  return out;
}

/**
 * Resolve the utm_* params for ONE send. Single resolver for every channel so email and
 * WhatsApp can never drift apart (they did: WhatsApp had no tagging at all).
 *
 * Precedence, most specific wins — each LAYER overrides per-key, so setting utm_campaign on a
 * journey does not wipe the auto-derived utm_content:
 *   template.utm  >  journey/campaign (tracking.utm)  >  account defaults  >  auto-derived
 *
 * Auto-derived is the pre-existing behaviour and stays the floor, so a send with nothing
 * configured anywhere is tagged exactly as it was before authors could set anything.
 */
function resolveUtm({ channel, tracking, template, defaults } = {}) {
  const auto = {
    utm_source: 'relay',
    utm_medium: channel,
    utm_campaign: tracking?.campaign,
    utm_content: tracking?.content ?? template?.name,
  };
  return {
    ...normalizeUtm(auto),
    ...normalizeUtm(defaults),
    ...normalizeUtm(tracking?.utm),
    ...normalizeUtm(template?.utm ?? template?.content?.utm),
  };
}

module.exports = { appendUtm, tagLinks, isLotHost, LOT_HOSTS, resolveUtm, normalizeUtm, UTM_KEYS };
