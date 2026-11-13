// Odo tools. Every call reaches odoops AS THE PERSON (their own Supabase JWT, service binding ODOOPS),
// so odoops' own checks apply on top of the gateway grant: active profile, an Odo role, and the
// action's permission (sales_view; salesops_super_admin for P&L). Only READ actions are listed here:
// odoops' probes, *Now sync/send triggers, user search, connector config and the bulk export are
// deliberately absent (some of its GETs have side effects — decisions §Team MCP gateway).
// The headline maths is Odo's own (apps/odo/src/lib/segregation.js), imported rather than copied,
// so Claude and the Odo dashboard can never disagree.
import { hybridHeadline, hybridByChannel } from '../../../apps/odo/src/lib/segregation.js';
import { getAs } from '../workers.js';
import { T, reportTool } from './build.js';

export const MAX_RANGE_DAYS = 92;
const DAY = 86400000;

export function todayIST(nowMs = Date.now()) {
  return new Date(nowMs + 5.5 * 3600000).toISOString().slice(0, 10);
}

// { ok, from, to } or { ok:false, error }. Dates are IST calendar days, inclusive.
export function parseRange(args, nowMs = Date.now()) {
  const a = args && typeof args === 'object' ? args : {};
  const today = todayIST(nowMs);
  const from = a.from === undefined || a.from === '' ? today : a.from;
  const to = a.to === undefined || a.to === '' ? from : a.to;
  const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))
    && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
  if (!isDate(from) || !isDate(to)) return { ok: false, error: 'Dates must be real calendar dates written YYYY-MM-DD.' };
  if (from > to) return { ok: false, error: '`from` must be on or before `to`.' };
  if (to > today) return { ok: false, error: `\`to\` cannot be after today (${today}, IST).` };
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY) + 1;
  if (days > MAX_RANGE_DAYS) return { ok: false, error: `Ask for at most ${MAX_RANGE_DAYS} days at a time (this asked for ${days}).` };
  return { ok: true, from, to, days };
}

const rupees = n => Math.round(Number(n) || 0);

// Pure: odoops payloads → the tool's answer. orderRows/channels from getSegregation, productRows from getSales.
export function shapeSalesSummary({ orderRows, channels, productRows }, range) {
  const head = hybridHeadline(orderRows || [], productRows || []);
  const byCh = hybridByChannel(orderRows || [], productRows || []);
  const name = new Map((channels || []).map(c => [c.id, c.name]));
  const by_channel = Object.entries(byCh)
    .map(([id, v]) => ({ channel: name.get(id) || 'Unknown channel', net_revenue_ex_gst: rupees(v.net), gross_sales_incl_gst: rupees(v.gross) }))
    .sort((x, y) => y.net_revenue_ex_gst - x.net_revenue_ex_gst);
  return {
    period: { from: range.from, to: range.to, days: range.days, timezone: 'IST' },
    net_revenue_ex_gst: rupees(head.netExGst),
    gross_sales_incl_gst: rupees(head.grossAll),
    units: Math.round(Number(head.units) || 0),
    gst_settled_pct: head.settledPct,
    by_channel,
    notes: [
      'Net revenue (ex-GST, after discounts, cancellations and returns) is the figure to quote; gross includes GST and cancelled orders.',
      'Returns are counted on the day they come back, so a short range or one channel can show negative net.',
      'gst_settled_pct is how much of the GST is marketplace-settled rather than estimated; below 100 means net may still move a little.',
      'Same calculation as the Odo dashboard.',
    ],
  };
}

export async function odoSalesSummary(env, sbAccess, range) {
  const p = { from: range.from, to: range.to };
  const [seg, sales] = await Promise.all([
    getAs(env.ODOOPS, sbAccess, 'getSegregation', p),
    getAs(env.ODOOPS, sbAccess, 'getSales', { ...p, group: 'variant' }),
  ]);
  for (const r of [seg, sales]) if (!r.ok) return r;
  if (!Array.isArray(seg.data.rows) || !Array.isArray(sales.data.rows)) return { ok: false, reason: 'unreachable' };
  return { ok: true, data: shapeSalesSummary({ orderRows: seg.data.rows, channels: seg.data.channels, productRows: sales.data.rows }, range) };
}

// ---------------------------------------------------------------- tool definitions
// Raw third-party payloads never leave the gateway (Meta API request/response bodies, change-event raw
// payloads, signed creative URLs): prompt-injection surface and credentials (hostile review 2026-11-09).
const ODO_DROP = ['raw', 'request', 'meta_response', 'asset_url'];
// getSales returns day × channel × variant rows whatever `group` says; sum them to the asked grain here so
// a long range is complete instead of cut (hostile review 2026-11-09). Not net revenue: use odo_sales_summary.
const SUM = ['units', 'gross_value', 'discount_value', 'tax_value', 'returned_units', 'returned_value'];
// p = the call's params: `products` (comma list) keeps only those product codes; group 'variant_channel'
// splits each product by channel (the worker is asked for group=channel, so grp_key/label are the channel).
export function groupSalesRows(d, p = {}) {
  let rows = (d && Array.isArray(d.rows)) ? d.rows : [];
  if (p.products) { const only = new Set(String(p.products).toUpperCase().split(',')); rows = rows.filter(r => only.has(String(r.product_code ?? '').toUpperCase())); }
  const both = p.group === 'variant_channel';
  const by = new Map();
  for (const r of rows) {
    const k = both ? `${r.product_code ?? ''}|${r.grp_key ?? ''}` : String(r.grp_key ?? '');
    const base = both ? { product_code: r.product_code, channel: r.grp_label, channel_id: r.grp_key } : { key: r.grp_key, label: r.grp_label };
    const a = by.get(k) || { ...base, ...Object.fromEntries(SUM.map(f => [f, 0])) };
    for (const f of SUM) a[f] += Number(r[f]) || 0;
    by.set(k, a);
  }
  const out = [...by.values()].map(a => ({ ...a, ...Object.fromEntries(SUM.map(f => [f, Math.round(a[f])])) }))
    .sort((x, y) => y.gross_value - x.gross_value);
  return { note: 'Gross is tax-incl and before discounts/returns; this is not net revenue (use odo_sales_summary for that).', groups: out.length, rows: out };
}
// The worker has no product-list filter and no two-way grouping: ask it for channel rows (which carry
// product_code) and let groupSalesRows filter + split. One product → the worker's own product_code filter.
export function breakdownWorkerParams(p) {
  const { products, ...w } = p;
  if (w.group === 'variant_channel') w.group = 'channel';
  const list = products ? String(products).toUpperCase().split(',') : [];
  if (list.length === 1 && !w.product_code) w.product_code = list[0];
  return w;
}
// Feed/connector error strings are third-party text: cap them (prompt-injection surface, hostile review).
export function clipErrors(v) {
  if (Array.isArray(v)) return v.map(clipErrors);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /error/i.test(k) && typeof x === 'string' ? x.slice(0, 200) : clipErrors(x)]));
  return v;
}
const monthStart = d => `${d.slice(0, 7)}-01`;
const perms = g => (g && g.odo_perms && typeof g.odo_perms === 'object') ? g.odo_perms : {};
// Truthiness, exactly as odoops checks it (`!!p.sales_view`).
const canView = g => !!perms(g).sales_view;
const canSuper = g => !!perms(g).salesops_super_admin;
const needView = g => (canView(g) ? null : 'odo denied');
const needSuper = g => (canSuper(g) ? null : 'odo pnl denied');

const summaryTool = {
  system: 'odo',
  name: 'odo_sales_summary',
  title: 'Odo sales summary',
  description: 'LOT sales from Odo for a date range (IST calendar days, inclusive; default today; at most 92 days): net revenue ex-GST (THE figure to quote), gross sales incl. GST, units, and net/gross per sales channel. Same calculation as the Odo dashboard. No costs, margins or P&L.',
  inputSchema: {
    type: 'object',
    properties: {
      from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'First day, YYYY-MM-DD (IST). Default: today.' },
      to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Last day, YYYY-MM-DD (IST), inclusive. Default: same as from.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  needsSession: true,
  visible: canView,
  deny: needView,
  parse: (args, nowMs) => { const r = parseRange(args, nowMs); return r.ok ? { ok: true, value: r } : r; },
  run: ({ env, sbAccess, input }) => odoSalesSummary(env, sbAccess, input),
};

const range = { from: T.date, to: T.date };
const chan = { channel_ids: { ...T.uuidList, as: 'channel_id' } };
const PA = {
  from: 'First day, YYYY-MM-DD (IST). Default: today (or the report\'s default window).',
  to: 'Last day, YYYY-MM-DD (IST), inclusive.',
  channel_ids: 'Limit to these Odo channels (ids from odo_lookup report=channels). Omit for all.',
  product_code: 'One LOT product code, e.g. as shown in sales by variant.',
  group: 'How to group rows; see the report description.',
  limit: 'Maximum rows.',
};

const odoTools = [
  summaryTool,
  reportTool({
    system: 'odo', name: 'odo_sales', title: 'Odo sales detail', binding: 'ODOOPS', scrubEmails: true, dropKeys: ODO_DROP, visible: canView, deny: needView, paramAbout: PA,
    description: 'Odo sales broken down by variant, channel or day; order-line drill-through; the live website order feed; the unmapped accessories memo line. For the headline net revenue use odo_sales_summary.',
    reports: {
      breakdown: { action: 'getSales', about: 'gross value, units, discounts, returns summed by variant (default), channel, date, or variant_channel (every product split by channel: one call per MONTH, never one call per product; rows carry product_code, names come from odo_lookup report=variants; if `groups` is more than the rows returned, it was cut: narrow with `products`); `products` limits it to those product codes (not net revenue)', params: { ...range, ...chan, product_code: T.code, products: { ...T.codeList, about: 'Product codes to include.' }, group: T.oneOf('variant', 'channel', 'date', 'variant_channel') }, shape: groupSalesRows, workerParams: breakdownWorkerParams, check: p => (p.product_code && p.products ? 'give either `product_code` or `products`, not both' : null) },
      order_lines: { action: 'getCellOrders', about: 'individual order lines (order ref, SKU, qty, value, cancelled) behind a slice; no customer details', params: { ...range, ...chan, products: { ...T.codeList, about: 'Product codes to include.' }, limit: T.int(1, 500) } },
      live_website: { action: 'getLiveSales', about: 'the website order feed right now: recent orders, totals and products, for today (IST) or a rolling N hours', params: { hours: { ...T.int(1, 72), about: 'Rolling window in hours. Omit for today (IST, from midnight).' }, limit: T.int(1, 200) } },
      accessories: { action: 'getAccessories', about: 'memo line for unmapped spares/gift-wrap/service SKUs; NOT included in any Odo total', params: { ...range, ...chan } },
    },
  }),
  reportTool({
    system: 'odo', name: 'odo_marketing', title: 'Odo marketing & ads', binding: 'ODOOPS', scrubEmails: true, dropKeys: ODO_DROP, visible: canView, deny: needView, paramAbout: PA,
    description: 'Ad spend and results from Odo: by platform/campaign/day, ad-level creative ROAS (Meta), Amazon ad metrics by product, the Ad Engine plans/ledger/managed ads, and website traffic sources.',
    reports: {
      spend: { action: 'getMarketing', about: 'spend and results grouped by platform (default), campaign or date', params: { ...range, group: T.oneOf('platform', 'campaign', 'date') } },
      ads: { action: 'getAdMetrics', about: 'ad-level metrics (spend, ROAS, CTR) grouped by ad (default), adset, campaign or date', params: { ...range, group: T.oneOf('ad', 'adset', 'campaign', 'date') } },
      ad_products: { action: 'getAdProduct', about: 'product-grain ad metrics (Amazon ads)', params: { ...range, platform: T.text } },
      traffic: { action: 'getTraffic', about: 'website traffic grouped by source (default) or date', params: { ...range, group: T.oneOf('src', 'date') } },
      ad_engine_plans: { action: 'adsGetPlans', about: 'Ad Engine launch plans', params: { status: T.text } },
      ad_engine_ledger: { action: 'adsGetLedger', about: 'Ad Engine action ledger (most recent first)', params: { limit: T.int(1, 500) } },
      ad_engine_managed: { action: 'adsGetManaged', about: 'ads currently managed by the Ad Engine', params: {} },
    },
  }),
  reportTool({
    system: 'odo', name: 'odo_dyno', title: 'Odo Dyno (creative testing)', binding: 'ODOOPS', scrubEmails: true, dropKeys: ODO_DROP, visible: canView, deny: needView, paramAbout: PA,
    description: 'Dyno, the creative testing grounds: the angle library, spend split, per-experiment decisions, the live board and the Gate-1 screening board, and the audience segment map.',
    reports: {
      angles: { action: 'getAngles', about: 'the angle library', params: {} },
      spend: { action: 'getDynoSpend', about: 'actual spend split experiment/scale, today and lifetime', params: {} },
      decisions: { action: 'getDecisions', about: 'decisions for one experiment plan', params: { plan_id: T.text }, required: ['plan_id'] },
      board: { action: 'getDynoBoard', about: 'live board: one row per variant with windowed Meta results and status', params: { angle: T.text, filter: T.text, kind: T.text, product: T.text, recent_days: T.int(1, 30) } },
      screen_board: { action: 'getDynoScreenBoard', about: 'Gate-1 screening board (CTR, CPC, cost per add-to-cart, spend share)', params: { angle: T.text, filter: T.text, product: T.text, recent_days: T.int(1, 30) } },
      segment_map: { action: 'getSegmentMap', about: 'audience segment → canonical column map', params: {} },
    },
  }),
  reportTool({
    system: 'odo', name: 'odo_funnel', title: 'Odo website funnel', binding: 'ODOOPS', scrubEmails: true, dropKeys: ODO_DROP, visible: canView, deny: needView, paramAbout: PA,
    description: 'Website conversion: checkout payment funnel, daily funnel history, net conversion rate, the website-changes stream and conversion drivers.',
    reports: {
      payment_funnel: { action: 'getPaymentFunnel', about: 'checkout payment funnel with reconciliation', params: { ...range, provider: T.text } },
      history: { action: 'getConversionHistory', about: 'daily website funnel history', params: { ...range } },
      conversion_rate: { action: 'getWebsiteCr', about: 'net conversion rate per IST day (net orders ÷ sessions)', params: { ...range } },
      changes: { action: 'getChangeEvents', about: 'website changes (annotations on the conversion timeline)', params: { ...range, stream: T.text } },
      drivers: { action: 'getConversionDrivers', about: 'conversion attribution drivers', params: { ...range } },
    },
  }),
  reportTool({
    system: 'odo', name: 'odo_amazon', title: 'Odo Amazon', binding: 'ODOOPS', scrubEmails: true, dropKeys: ODO_DROP, visible: canView, deny: needView, paramAbout: PA,
    description: 'Amazon-specific views: sales by geography, returns, traffic and conversion, and the payout & fees (settlement) lens.',
    reports: {
      geo: { action: 'getAmazonGeo', about: 'Amazon sales by geography', params: { ...range } },
      returns: { action: 'getAmazonReturns', about: 'Amazon returns, overall (default) or by product', params: { ...range, group: T.oneOf('overall', 'product') } },
      traffic: { action: 'getAmazonTraffic', about: 'sessions, page views, unit-session conversion, overall (default), by product or by date', params: { ...range, group: T.oneOf('overall', 'product', 'date') } },
      settlement: { action: 'getSettlement', about: 'Amazon payout and fees (settlement)', params: { ...range } },
    },
  }),
  reportTool({
    system: 'odo', name: 'odo_inventory', title: 'Odo inventory', binding: 'ODOOPS', scrubEmails: true, dropKeys: ODO_DROP, visible: canView, deny: needView, paramAbout: PA,
    description: 'Stock across channels: current status, history for a product, stock alerts, low-stock thresholds and daily run-rate (DRR).',
    reports: {
      status: { action: 'getInventoryStatus', about: 'current stock by product and channel', params: { channels: { ...T.uuidList, about: 'Channel ids to include.' }, include_unmapped: T.bool } },
      history: { action: 'getInventoryHistory', about: 'stock history for one product or SKU (give one); default the last 30 days', params: { ...range, product_code: T.code, sku: T.code }, defaultDays: 30, check: p => (p.product_code || p.sku ? null : 'give `product_code` or `sku` for the history report') },
      alerts: { action: 'getStockAlerts', about: 'stock-alert history', params: { limit: T.int(1, 200) } },
      thresholds: { action: 'getInvThresholds', about: 'per-product low-stock thresholds', params: {} },
      run_rate: { action: 'getProductDrr', about: 'daily run-rate per product', params: { ref_date: T.date, window: T.int(1, 365) } },
    },
  }),
  reportTool({
    system: 'odo', name: 'odo_pnl', title: 'Odo P&L (super admins)', binding: 'ODOOPS', scrubEmails: true, dropKeys: ODO_DROP, visible: canSuper, deny: needSuper, paramAbout: PA,
    description: 'Profit & loss from Odo: channel-wise P&L, per-product P&L (through CM2 for a family), manual P&L lines and standard product costs. Only for Odo super admins.',
    reports: {
      by_channel: { action: 'getPnl', about: 'channel-wise P&L', params: { ...range } },
      by_product: { action: 'getPnlByProduct', about: 'per-product P&L; give a family for CM2', params: { ...range, family: T.text } },
      // pnl_manual.month is always the 1st: snap the range to whole months or the current month vanishes.
      manual_lines: { action: 'getPnlManual', about: 'manual P&L lines for the months in the range', params: { ...range }, prep: p => ({ ...p, from: monthStart(p.from), to: p.to }) },
      product_costs: { action: 'getProductCosts', about: 'active SKUs with latest standard cost (COGS)', params: {} },
    },
  }),
  reportTool({
    system: 'odo', name: 'odo_lookup', title: 'Odo lookups & data health', binding: 'ODOOPS', scrubEmails: true, dropKeys: ODO_DROP, visible: canView, deny: needView, paramAbout: PA,
    description: 'Reference data and data health: the channel list (ids for other Odo tools), variants, how fresh each feed is, connector status, and the Flipkart sell-out memo.',
    reports: {
      channels: { action: 'getSegregation', about: 'the sales channels with their ids', params: {}, shape: d => ({ channels: (d && d.channels) || [] }) },
      variants: { action: 'getVariants', about: 'the product variant list', params: {} },
      freshness: { action: 'getFreshness', about: 'when each data feed last updated successfully', params: {}, shape: clipErrors },
      // Shaped: no secret-presence map, cursors or raw run rows; just health per connector.
      connectors: { action: 'getConnectorStatus', about: 'connector health per channel', params: {}, shape: d => ({ connectors: ((d && d.connectors) || []).map(c => ({ name: c.name, adapter: c.adapter_kind, enabled: c.enabled, last_ok_at: c.last_ok_at, last_error: c.last_error ? String(c.last_error).slice(0, 200) : null })) }) },
      sellout: { action: 'getSellout', about: 'Flipkart sell-out memo (secondary layer, not revenue); needs channel_ids', params: { ...range, ...chan }, required: ['channel_ids'] },
    },
  }),
];
export default odoTools;
