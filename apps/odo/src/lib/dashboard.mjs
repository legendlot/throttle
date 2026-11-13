// Pure helpers for the Odo cross-channel dashboard ((auth)/page.js) instant-load: the cache keys,
// what each call is slimmed to before it is held or cached, the readiness guard every multi-query
// figure renders behind, the export gate and the page freshness line. No I/O, no React —
// unit-tested in test/dashboard.test.mjs.
//
// Odo's rule is ACCURACY OVER RECENCY: a cached figure is shown only under a line that says how
// old it is, and a number is never shown under a date range or channel selection it does not
// belong to. So every payload carries the key it was fetched for (`k`), and `forSel` refuses
// data whose `k` is not the current selection's — even for the one render in which the hook
// still holds the previous selection's data.

export const BOOT_KEY = 'odo:dashboard:bootstrap';
export const VARIANTS_KEY = 'odo:dashboard:variants';

// The channel filter as sent to the worker AND as keyed: de-duplicated and sorted, so the same
// selection made in a different click order is the same request and the same cache entry. The
// worker splits it into a set (p_channels), so order never changed the answer.
export function channelArg(sel) {
  return [...new Set((sel || []).map(String))].sort().join(',');
}

// Every input that changes an answer is in its key: the exact from/to the worker is sent, and the
// channel set. getSales is always `group=variant` here (the Detail axis is regrouped client-side),
// so the group is not an input. The prior period is its own pair of dates, so its key is simply
// the sales/segregation key of THOSE dates — a range's prior period and the same dates picked as
// the main range are the same answer and may share an entry.
export function selectionKeys({ from, to, sel, prior }) {
  const ch = channelArg(sel);
  const c = ch || 'all';
  return {
    ch,
    sales: `odo:dashboard:sales:${from}:${to}:${c}`,
    salesPrev: `odo:dashboard:sales:${prior.from}:${prior.to}:${c}`,
    seg: `odo:dashboard:segregation:${from}:${to}:${c}`,
    segPrev: `odo:dashboard:segregation:${prior.from}:${prior.to}:${c}`,
    acc: `odo:dashboard:accessories:${from}:${to}:${c}`,
  };
}

// ── slimmers — each keeps exactly what the page reads, tagged with its key ───────────────────

// The worker answers some database failures with an EMPTY list (getVariants: `r.ok ? r.data : []`;
// getBootstrap's channel read the same way), which would otherwise be cached for 12 h as a true
// "nothing". Zero is impossible in a healthy system for both — LOT has active sales channels and
// active product_master rows, and neither call takes a filter — so zero is treated as a failure.
export class EmptyReadError extends Error {}

// getBootstrap → channels (picker + names), connectors (health card) and the unmapped count.
// The super-admin role/user lists it also carries are never shown here and are not held.
export function slimBootstrap(k, b) {
  if (!(b?.channels || []).length) throw new EmptyReadError('The channel list came back empty');
  return {
    k,
    channels: (b?.channels || []).map(c => ({ channel_id: c.channel_id || c.id, name: c.name, type: c.type })),
    connectors: (b?.connectors || []).map(c => ({
      channel_id: c.channel_id, name: c.name, enabled: c.enabled,
      last_ok_at: c.last_ok_at, last_error: c.last_error,
      last_run: c.last_run ? { status: c.last_run.status } : null,
    })),
    unmapped_count: b?.unmapped_count || 0,
  };
}

// getVariants → product_master rows, as returned (every column feeds the Detail search).
export function slimVariants(k, r) {
  if (!(r?.rows || []).length) throw new EmptyReadError('The product list came back empty');
  return { k, rows: r.rows };
}

// getSales (f_sales_rollup, variant grain) → columnar. A month is ~3,000 rows; as objects that is
// ~750k characters and would never fit the 300k cache cap, so the four string columns go through
// one dictionary and each row is an array. Lossless for every field the page reads, including
// null vs absent (tax_value: absent means "strip at the flat rate", see hybridHeadline).
const SALES_STR = ['sale_date', 'channel_id', 'product_code', 'grp_label'];
const SALES_NUM = ['units', 'gross_value', 'discount_value', 'tax_value', 'returned_units', 'returned_value'];
const NULL_REF = -1, ABSENT_REF = -2;
export function packSales(k, rows) {
  const dict = [], at = new Map();
  const ref = (v) => {
    if (v === undefined) return ABSENT_REF;
    if (v === null) return NULL_REF;
    if (!at.has(v)) { at.set(v, dict.length); dict.push(v); }
    return at.get(v);
  };
  const out = (rows || []).map(r => [
    ...SALES_STR.map(f => ref(r[f])),
    ...SALES_NUM.map(f => (r[f] === undefined ? null : r[f])),
  ]);
  return { k, dict, rows: out };
}
export function unpackSales(p) {
  const dict = p?.dict || [];
  const val = (i) => (i === ABSENT_REF ? undefined : i === NULL_REF ? null : dict[i]);
  return (p?.rows || []).map(a => {
    const o = {};
    SALES_STR.forEach((f, i) => { const v = val(a[i]); if (v !== undefined) o[f] = v; });
    SALES_NUM.forEach((f, i) => { o[f] = a[SALES_STR.length + i]; });
    return o;
  });
}

// getSegregation (f_order_rollup, sale_date × channel) → the columns aggOrders / rowGst /
// hybridHeadline and the daily spark read. A column the worker did not send stays absent.
const SEG_FIELDS = ['sale_date', 'channel_id', 'adapter_kind', 'gross', 'discount', 'tax', 'tax_ingest',
  'cancelled_value', 'orders', 'cancelled_orders', 'returns_count', 'returns_value',
  'replacement_orders', 'influencer_orders', 'repair_orders'];
export function slimSeg(k, d) {
  return {
    k,
    rows: (d?.rows || []).map(r => {
      const o = {};
      for (const f of SEG_FIELDS) if (f in r) o[f] = r[f];
      return o;
    }),
  };
}

// getAccessories → the memo line: its total and the distinct bucket names, in first-seen order.
export function slimAccessories(k, d) {
  const buckets = (d?.rows || []).map(r => r.bucket).filter((v, i, a) => a.indexOf(v) === i);
  return { k, buckets, total: d?.total || { units: 0, gross: 0, skus: 0 } };
}

// ── readiness ────────────────────────────────────────────────────────────────────────────────

// A query's data, only if it was fetched for key `k`.
export function forSel(q, k) {
  return q?.data !== undefined && q.data?.k === k ? q.data : undefined;
}

// The guard for anything rendered from one or more queries. `pairs` = [[query, key], …] — every
// input of the figure. Ready only when EVERY input holds data for its own key (stale-from-cache
// is allowed: the freshness line says how old). Any input that failed with no data for its key
// makes the figure an error (retry = those pairs); otherwise it is still loading. Never a delta
// against a prior period of another selection, never a share off half a pair.
export function need(pairs) {
  const failed = [];
  let missing = false;
  for (const [q, k] of pairs) {
    if (forSel(q, k) !== undefined) continue;
    if (q?.error && !q.loading) failed.push([q, k]);
    else missing = true;
  }
  if (failed.length) return { state: 'error', retry: failed };
  return { state: missing ? 'loading' : 'ready', retry: [] };
}

// ── export gate ──────────────────────────────────────────────────────────────────────────────

// Is query `q` holding a result for `k` that THIS page fetched (not a cache seed), with nothing
// in flight and no failed refresh? `startedAt` = when the page last asked for `k`.
export function freshFor(q, k, startedAt) {
  return forSel(q, k) !== undefined && !q.loading && !q.refreshing && !q.error
    && startedAt != null && q.updatedAt != null && q.updatedAt >= startedAt;
}

// The XLSX/CSV export is its own getSalesExport fetch, but it is enabled off the page's rows and
// filtered by the Detail product filter (built from getVariants). So it is allowed only when the
// current selection's sales are fresh-fetched and non-empty (empty disabled it before too) and,
// with a product/category filter on, when the variants behind that filter are fresh as well.
export const EXPORT_WAIT = 'Available once this range has finished loading';
export const EXPORT_FAILED = "Couldn't refresh — Retry";
export function exportGate({ salesQ, salesKey, salesStartedAt, rowCount, filterActive, variantsQ, variantsStartedAt }) {
  // A failed refresh will not clear by waiting: say so, so the reader knows to Retry.
  if (salesQ?.error || (filterActive && variantsQ?.error)) return { ok: false, why: EXPORT_FAILED };
  if (!freshFor(salesQ, salesKey, salesStartedAt)) return { ok: false, why: EXPORT_WAIT };
  if (!rowCount) return { ok: false, why: '' };
  if (filterActive && !freshFor(variantsQ, VARIANTS_KEY, variantsStartedAt)) {
    return { ok: false, why: 'Available once the product list has finished loading' };
  }
  return { ok: true, why: '' };
}

// ── freshness ────────────────────────────────────────────────────────────────────────────────

// IST stamp: "21:04" today, "12 Nov 21:04" otherwise (Garage / Depot wording).
export function istStamp(ms, nowMs = Date.now()) {
  const d = new Date(ms);
  const hhmm = d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
  const day = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const today = new Date(nowMs).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  if (day === today) return hhmm;
  return `${d.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' })} ${hhmm}`;
}

// When the PAGE fetched what it shows — the oldest of the current selection's queries. Says
// "Loaded", not "As of": the top bar's chip already answers "how recent is each channel's source
// data" (Oldest Amazon · 2h ago) and "as of" would read as that. Pass only the current
// selection's [query, key] pairs; a query with no data for its key contributes no stamp.
export function pageFreshness(pairs, nowMs = Date.now()) {
  const qs = pairs.map(([q]) => q);
  const inFlight = qs.some(q => q.loading || q.refreshing);
  const failed = qs.some(q => q.error);
  const stamps = pairs.filter(([q, k]) => forSel(q, k) !== undefined).map(([q]) => q.updatedAt).filter(Boolean);
  const oldest = stamps.length ? istStamp(Math.min(...stamps), nowMs) : null;
  const text = inFlight ? (oldest ? `Updating… (showing ${oldest})` : 'Updating…')
    : failed ? (oldest ? `Couldn't refresh — showing ${oldest}` : "Couldn't refresh")
    : oldest ? `Loaded ${oldest}` : '';
  return { text, warn: failed && !inFlight };
}

// A query refreshed only on mount / return (bootstrap, variants) is kept OUT of the header line —
// it would vouch for figures it does not refresh — and stamps its own section instead:
// "as of HH:MM", or "Couldn't refresh — as of HH:MM" (warn) over stale data. Null with no data.
export function panelAsOf(q, k, nowMs = Date.now()) {
  if (forSel(q, k) === undefined || !q.updatedAt) return null;
  const at = istStamp(q.updatedAt, nowMs);
  return q.error ? { text: `Couldn't refresh — as of ${at}`, warn: true } : { text: `as of ${at}`, warn: false };
}

// No polling loop here, and the fetch helpers have no timeout: a request that never answers
// would leave its section on a skeleton for good (the hook only gives up on it after 2 min, and
// only when something asks again). So every fetcher races a 90 s timer and fails with a clear
// Error, which the section shows with Retry. `timers` is injectable for tests.
export const FETCH_TIMEOUT_MS = 90 * 1000;
// ⛔ The default timers MUST be wrapped in arrow functions. `{ set: setTimeout }` then
// `timers.set(...)` calls the browser's setTimeout with `this === timers`, which throws
// "TypeError: Illegal invocation" — in every browser, and NOT in Node, so the unit tests
// passed while every fetcher on the live dashboard failed (2026-11-14, reverted in 01e04517).
const DEFAULT_TIMERS = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id),
};
export function withTimeout(promise, ms, label, timers = DEFAULT_TIMERS) {
  let id;
  const timeout = new Promise((_, reject) => {
    id = timers.set(() => reject(new Error(`${label} did not answer within ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => timers.clear(id));
}

// Refetch once when the tab comes back after being hidden longer than this. The sales reads are
// not polled (feeds move hourly; the page refreshes on mount, on selection change and here).
export const RETURN_REFRESH_MS = 5 * 60 * 1000;
export function shouldRefreshOnReturn(hiddenAt, nowMs, maxHiddenMs = RETURN_REFRESH_MS) {
  return hiddenAt != null && nowMs - hiddenAt > maxHiddenMs;
}
