// Data freshness — which feeds each route depends on, and how they roll up into one stamp.
//
// Rule (Afshaan, S220): WEAKEST LINK. A page is only as fresh as its stalest feed, so the
// headline stamp is the OLDEST last_ok_at among the feeds that page actually reads. A stale
// feed must never be able to hide behind a fresh one sharing the same page.
//
// Manual-entered data (P&L inputs, product COGS, QC report uploads) is reported SEPARATELY and
// never blended into the feed stamp — "nobody edited this" and "the pipe is broken" are
// different facts and must not collapse into one number.

import { FAMILIES, familyOf } from './families.js';

// Ad / analytics feeds sit on synthetic is_sale=false channels. Match them by adapter_kind —
// NEVER by channel name: the website family's /web/i regex would swallow "GA4 Web".
export const AD_KINDS = ['meta_ads', 'google_ads', 'amazon_ads', 'amazon_ads_product', 'amazon_dsp', 'meta_status'];

// Which ad platforms a sales family's P&L attributes spend from (mirrors PNL_FAMILIES in odoops).
const FAMILY_ADS = {
  website: ['meta_ads', 'meta_status', 'google_ads'],
  amazon:  ['amazon_ads', 'amazon_ads_product', 'amazon_dsp'],
};

// Staleness thresholds. Every connector is driven by the same hourly cron, so one rule fits all.
const AMBER_MS = 3 * 3600 * 1000;        // > 3h  → drifting
const RED_MS   = 24 * 3600 * 1000;       // > 24h → broken

/**
 * Resolve a route to the feeds + manual inputs it depends on.
 * Returns null for routes with no data surface (e.g. /admin).
 */
export function scopeForRoute(pathname, feeds, manual = {}) {
  const all    = (feeds || []).filter(f => f.enabled);
  const sale   = all.filter(f => f.is_sale);
  const byKind = (...kinds) => all.filter(f => kinds.includes(f.adapter_kind));
  const fam    = (k) => sale.filter(f => familyOf(f.name) === k);
  const p = pathname || '/';

  const pnlManual = [
    { label: 'Manual P&L inputs', at: manual.pnl_manual },
    { label: 'Product COGS',      at: manual.product_cost },
  ];

  if (p === '/admin') return null;                       // permissions UI — no business data

  if (p === '/uploads') return { feeds: [], manual: [{ label: 'Last report upload', at: manual.upload_batch }] };
  if (p === '/connectors') return { feeds: all, manual: [] };   // the page IS the feed list

  if (p === '/' || p === '/performance' || p === '/mapping' || p === '/channels') return { feeds: sale, manual: [] };

  if (p.startsWith('/channels/')) {
    const k = p.split('/')[2];
    return { feeds: FAMILIES[k] ? fam(k) : sale, manual: [] };
  }

  // The Amazon cockpit blends Amazon sell-out with its full Sponsored + DSP ad stack.
  if (p === '/amazon') return { feeds: [...fam('amazon'), ...byKind('amazon_ads', 'amazon_ads_product', 'amazon_dsp')], manual: [] };

  if (p === '/marketing') return { feeds: byKind(...AD_KINDS), manual: [] };
  if (p.startsWith('/dyno')) return { feeds: byKind('meta_ads', 'meta_status'), manual: [] };
  if (p === '/funnel') return { feeds: [...byKind('ga4', 'razorpay_payments'), ...fam('website')], manual: [] };

  if (p === '/products/pnl') return { feeds: sale, manual: [{ label: 'Product COGS', at: manual.product_cost }] };
  if (p.startsWith('/products')) return { feeds: sale, manual: [] };

  if (p.startsWith('/pnl')) {
    const k = p.split('/')[2];
    if (k && k !== 'overall' && FAMILIES[k]) return { feeds: [...fam(k), ...byKind(...(FAMILY_ADS[k] || []))], manual: pnlManual };
    return { feeds: [...sale, ...byKind(...AD_KINDS)], manual: pnlManual };
  }

  return { feeds: sale, manual: [] };
}

/** Per-feed health. `last_error` is authoritative (matches the cockpit's convention). */
export function feedStatus(f, now = Date.now()) {
  if (f.last_error) return 'error';
  if (!f.last_ok_at) return 'never';
  const age = now - Date.parse(f.last_ok_at);
  if (!isFinite(age)) return 'never';
  if (age > RED_MS) return 'error';
  if (age > AMBER_MS) return 'warn';
  return 'ok';
}

const RANK = { ok: 0, warn: 1, never: 2, error: 3 };

/**
 * Roll a scope up into the headline stamp.
 *
 * `oldestAt` (weakest link BY TIME) drives the healthy "Data as of …" label.
 * `worst` (weakest link BY SEVERITY, age as tiebreak) names the culprit on a red stamp — these
 * are deliberately NOT the same feed: a fresh-but-erroring feed outranks an older healthy one,
 * and picking the culprit by age alone would let that error hide behind it.
 */
export function summarize(scope, now = Date.now()) {
  if (!scope) return null;
  const feeds = scope.feeds || [];
  const rated = feeds.map(f => ({ ...f, status: feedStatus(f, now), ageMs: f.last_ok_at ? now - Date.parse(f.last_ok_at) : Infinity }));

  // Never-run feeds carry age Infinity, so they sort oldest-first by design.
  const byAge = [...rated].sort((a, b) => b.ageMs - a.ageMs);
  const bySeverity = [...rated].sort((a, b) => (RANK[b.status] - RANK[a.status]) || (b.ageMs - a.ageMs));
  const oldest = byAge[0] || null;
  const worst = bySeverity[0] || null;
  const tone = rated.reduce((t, f) => (RANK[f.status] > RANK[t] ? f.status : t), 'ok');

  return {
    feeds: bySeverity,                                    // popover lists problems first
    manual: (scope.manual || []).filter(m => m.at !== undefined),
    worst,
    tone: feeds.length ? tone : 'none',
    oldestAt: oldest && isFinite(oldest.ageMs) ? oldest.last_ok_at : null,
    anyNever: rated.some(f => f.status === 'never'),
  };
}

/** Compact relative age. Mirrors the cockpit's `ago()` so the two never disagree. */
export function ago(iso, now = Date.now()) {
  if (!iso) return 'never';
  const s = (now - Date.parse(iso)) / 1000;
  if (!isFinite(s)) return 'never';
  if (s < 90) return 'just now';
  if (s < 5400) return Math.round(s / 60) + 'm ago';
  if (s < 172800) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

/** Short age without the "ago" suffix — for the "N behind" culprit label. */
export function shortAge(iso, now = Date.now()) {
  if (!iso) return '—';
  const s = (now - Date.parse(iso)) / 1000;
  if (!isFinite(s)) return '—';
  if (s < 5400) return Math.round(s / 60) + 'm';
  if (s < 172800) return Math.round(s / 3600) + 'h';
  return Math.round(s / 86400) + 'd';
}

export const TONE_COLOR = { ok: 'var(--green)', warn: 'var(--amber)', error: 'var(--red)', never: 'var(--t3)', none: 'var(--t3)' };
