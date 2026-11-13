'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { useCachedQuery, getValidSession } from '@throttle/db';
import { Spinner, Modal, Combobox, Skeleton } from '@throttle/ui';
import { salesGet, inr, fmtInt, istToday, istDaysAgo, downloadCsv, rangePresets, priorPeriod, defaultRange, DEFAULT_RANGE_PRESET } from '../../lib/api.js';
import { downloadXlsx } from '../../lib/xlsx.js';
import StackedTrendChart from '../../components/StackedTrendChart.js';
import { Kpi, Delta, RangePicker, SegmentedToggle, SettledBadge, useTableSort, SortHeader } from '../../components/kit.js';
import ChannelFilter from '../../components/ChannelFilter.js';
import { hybridHeadline, hybridByChannel } from '../../lib/segregation.js';
// Prism atoms — shared vocabulary, presentational only.
import { Swatch, PanelHead, PageHead, Bar, Donut, Nil } from '../../components/prism.js';
import { HUE, STATUS, hueStyle } from '../../lib/hues.js';
import {
  BOOT_KEY, VARIANTS_KEY, selectionKeys, slimBootstrap, slimVariants, packSales, unpackSales, slimSeg,
  slimAccessories, forSel, need, exportGate, pageFreshness, panelAsOf, withTimeout, FETCH_TIMEOUT_MS,
} from '../../lib/dashboard.mjs';
import { rollPreset } from '../../lib/ranges.mjs';
import { useRefreshOnReturn } from '../../hooks/useRefreshOnReturn.js';
// Channel families — single source of truth (shared with the Channels section). Aliased so the
// existing chart/chip code keeps its names.
import { FAMILIES as GROUP_META, FAMILY_ORDER as GROUP_ORDER, familyOf as channelGroup } from '../../lib/families.js';

const GROUPS = [
  { key: 'variant', label: 'By Variant' },
  { key: 'product', label: 'By Product' },
  { key: 'date',    label: 'By Day' },
  { key: 'channel', label: 'By Channel' },
];
// product_master.category values, byte-exact (RULE-TAXONOMY-001). DIY is here so the three add up to All.
const CATEGORY_OPTS = [['all', 'All'], ['L.O.T Cars', 'Cars'], ['L.O.T Build', 'Build'], ['L.O.T DIY', 'DIY']];

// relative "time ago" for connector freshness
function ago(iso) {
  if (!iso) return 'never';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!isFinite(s)) return 'never';
  if (s < 90) return 'just now';
  if (s < 5400) return Math.round(s / 60) + 'm ago';
  if (s < 172800) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}
// Semantic status never borrows a family hue (handoff §3.5) — these are the STATUS tokens.
const HEALTH_COLOR = { ok: STATUS.good, partial: STATUS.warn, error: STATUS.bad, never: STATUS.none };

const PRESETS = rangePresets();

// shared row primitives — names in the UI font, every number in mono tabular
const NAME = { fontFamily: 'var(--ui)', fontSize: 12, color: 'var(--t1)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const NUM = { fontFamily: 'var(--mono)', fontSize: 11, fontVariantNumeric: 'tabular-nums', textAlign: 'right' };
const EMPTY = { fontFamily: 'var(--ui)', fontSize: 12.5, color: 'var(--t3)' };

const NO_ROWS = [];
const NO_ACC = { buckets: [], total: { units: 0, gross: 0, skus: 0 } };

export default function Dashboard() {
  const { session, userId, perms } = useAuth();
  const [sel, setSel] = useState([]);            // selected channel ids ([] = all)
  const MTD = defaultRange();
  const [preset, setPreset] = useState(DEFAULT_RANGE_PRESET);
  const [from, setFrom] = useState(MTD.from);
  const [to, setTo] = useState(MTD.to);
  const [group, setGroup] = useState('variant'); // drill table axis
  const [drill, setDrill] = useState(null);      // S294 — { title, params } → underlying-orders modal
  const [trendMetric, setTrendMetric] = useState('gross');
  const [variantMetric, setVariantMetric] = useState('gross');
  const [mixMetric, setMixMetric] = useState('net');  // Channel mix: net (ex-GST) by default, gross on toggle (Afshaan S403)
  const [sellerRollup, setSellerRollup] = useState('variant'); // variant | product
  // Detail-only product filter. '' = everything. 'p:<product>' = every variant of a product,
  // 'v:<product_code>' = one variant. Deliberately scoped to the Detail table (that is what was
  // asked for) — the KPIs, mix board and movers above stay whole-catalogue, so the panel head
  // names the selection loudly enough that the two are never read as the same number.
  const [productFilter, setProductFilter] = useState('');
  // Detail-only category switch (Karan, #bugs 1793710445.319899). 'all' = no restriction, else a
  // product_master.category value. Same Detail-only scope as productFilter above.
  const [categoryFilter, setCategoryFilter] = useState('all');
  // ── data: one cached query per source (instant-load pattern, decisions "Instant-load pattern") ──
  // Each section paints from this tab's last-known result for EXACTLY its selection and refreshes
  // behind it; the freshness line under the header says when the page fetched what it shows.
  // Every payload carries its key (`k`) and every figure renders through `need()`, so a number is
  // never shown under a range or channel set it was not fetched for. The fetchers never swallow a
  // failure — a failure is the section's error + Retry, never zeros or an empty state.
  // Nothing seeds or fetches until perms are known AND grant sales_view — the permission odoops
  // checks on every one of these reads (canView). The cached-identity auth path paints with perms
  // still null, and a cached figure must never show to someone who may not see it; without an
  // identity (qUser null) the hook neither reads the cache nor fetches.
  const access = !!perms?.sales_view;
  const live = !!session && access;
  const qUser = access ? userId : null;
  // The token is read at CALL time, never closed over: a tab hidden past the token's life would
  // otherwise refresh with the expired one and 401 every section. Each call also races a 90 s
  // timer, so a request that never answers ends as the section's error + Retry, not a skeleton.
  const call = (action, params) => withTimeout(getValidSession().then(s => salesGet(action, params, s)), FETCH_TIMEOUT_MS, action);
  const pp = useMemo(() => priorPeriod(from, to), [from, to]);
  const K = useMemo(() => selectionKeys({ from, to, sel, prior: pp }), [from, to, sel, pp]);
  const bootQ = useCachedQuery({ key: BOOT_KEY, userId: qUser, enabled: live,
    fetcher: () => call('getBootstrap', {}).then(b => slimBootstrap(BOOT_KEY, b)) });
  // product_master rows — feeds the Detail product search, the product roll-up and the drill.
  const variantsQ = useCachedQuery({ key: VARIANTS_KEY, userId: qUser, enabled: live,
    fetcher: () => call('getVariants', {}).then(r => slimVariants(VARIANTS_KEY, r)) });
  const salesQ = useCachedQuery({ key: K.sales, userId: qUser, enabled: live,
    fetcher: () => call('getSales', { from, to, group: 'variant', channel_id: K.ch }).then(d => packSales(K.sales, d?.rows)) });
  const salesPrevQ = useCachedQuery({ key: K.salesPrev, userId: qUser, enabled: live,
    fetcher: () => call('getSales', { from: pp.from, to: pp.to, group: 'variant', channel_id: K.ch }).then(d => packSales(K.salesPrev, d?.rows)) });
  // order-grain (complete, sku-map-independent) — drives the hybrid headline totals only
  const segQ = useCachedQuery({ key: K.seg, userId: qUser, enabled: live,
    fetcher: () => call('getSegregation', { from, to, channel_id: K.ch }).then(d => slimSeg(K.seg, d)) });
  const segPrevQ = useCachedQuery({ key: K.segPrev, userId: qUser, enabled: live,
    fetcher: () => call('getSegregation', { from: pp.from, to: pp.to, channel_id: K.ch }).then(d => slimSeg(K.segPrev, d)) });
  // ⚠️ The accessories MEMO must never be load-bearing. It once shipped inside one Promise.all
  // with the KPIs and took the WHOLE dashboard down when its RPC 502'd on an FY range: every KPI,
  // the mix board and the drill table silently kept the previous range's numbers under the new
  // range's labels. It is its own query now, so it can only ever fail to itself — and a failure is
  // still SAID ("couldn't load"), never hidden: an absent strip reads as "no accessories sold".
  const accQ = useCachedQuery({ key: K.acc, userId: qUser, enabled: live,
    fetcher: () => call('getAccessories', { from, to, channel_id: K.ch }).then(d => slimAccessories(K.acc, d)) });

  // [query, key] pairs — the inputs `need()` checks.
  const S = [salesQ, K.sales], SP = [salesPrevQ, K.salesPrev], G = [segQ, K.seg], GP = [segPrevQ, K.segPrev];
  const A = [accQ, K.acc], B = [bootQ, BOOT_KEY], V = [variantsQ, VARIANTS_KEY];
  const selPairs = [S, SP, G, GP, A];

  // When the page last ASKED for each key — the export only trusts a result that landed after it.
  const startedRef = useRef({});
  const refreshPair = useCallback(([q, k]) => { startedRef.current[k] = Date.now(); return q.refresh(); }, []);
  const retry = (gate) => gate.retry.forEach(refreshPair);
  const refreshSelection = () => selPairs.forEach(refreshPair);
  // No polling: on mount, on a selection change, and once on return to a tab hidden > 5 min.
  useEffect(() => { if (live) { refreshPair(B); refreshPair(V); } }, [live, qUser]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (live) refreshSelection(); }, [live, qUser, K.sales, K.salesPrev, K.seg, K.segPrev, K.acc]); // eslint-disable-line react-hooks/exhaustive-deps
  // A renewed token heals whatever failed on the old one (e.g. the 401s of a refresh fired on
  // return before the session renewed) — only the failed queries are asked again.
  useEffect(() => {
    if (live) [...selPairs, B, V].forEach(p => { if (p[0].error) refreshPair(p); });
  }, [session?.access_token]); // eslint-disable-line react-hooks/exhaustive-deps
  // On every return to the tab: a preset range left open across IST midnight rolls to today's
  // range first (presets recomputed now; custom ranges untouched) — the new keys fetch it, so
  // yesterday's figures are never re-stamped as freshly loaded under "Today"/"MTD". After more
  // than 5 min hidden, everything else is refreshed once too.
  useRefreshOnReturn((stale) => {
    if (!live) return;
    const rolled = rollPreset(preset, from, to, rangePresets());
    if (rolled) { setFrom(rolled.from); setTo(rolled.to); }
    if (stale) { refreshPair(B); refreshPair(V); if (!rolled) refreshSelection(); }
  });

  const salesD = forSel(salesQ, K.sales), salesPrevD = forSel(salesPrevQ, K.salesPrev);
  const rows = useMemo(() => (salesD ? unpackSales(salesD) : NO_ROWS), [salesD]);
  const prevRows = useMemo(() => (salesPrevD ? unpackSales(salesPrevD) : NO_ROWS), [salesPrevD]);
  const segRows = forSel(segQ, K.seg)?.rows || NO_ROWS;
  const segPrevRows = forSel(segPrevQ, K.segPrev)?.rows || NO_ROWS;
  // "Accessories & others" MEMO — unmapped spares/gift-wrap/service. Deliberately NOT folded into
  // any total: it is read off staging, never sales_fact. Kept in its own query so it can't leak in.
  const acc = forSel(accQ, K.acc) || NO_ACC;
  const boot = forSel(bootQ, BOOT_KEY);
  const channels = boot?.channels || NO_ROWS;
  const connectors = boot?.connectors || NO_ROWS;
  const unmappedCount = boot?.unmapped_count || 0;
  const variants = forSel(variantsQ, VARIANTS_KEY)?.rows || NO_ROWS;
  const codeToProduct = useMemo(() => {
    const m = {}; variants.forEach(v => { m[v.product_code] = v.product; }); return m;
  }, [variants]);

  const chName = useMemo(() => Object.fromEntries(channels.map(c => [c.channel_id, c.name])), [channels]);

  // ── aggregations ──
  const aggOf = (rs) => {
    let units = 0, gross = 0; const day = {}, ch = {}, variant = {};
    for (const r of rs) {
      const u = Number(r.units) || 0, g = Number(r.gross_value) || 0;
      units += u; gross += g;
      (day[r.sale_date] = day[r.sale_date] || { units: 0, gross: 0 }); day[r.sale_date].units += u; day[r.sale_date].gross += g;
      (ch[r.channel_id] = ch[r.channel_id] || { units: 0, gross: 0 }); ch[r.channel_id].units += u; ch[r.channel_id].gross += g;
      (variant[r.product_code] = variant[r.product_code] || { units: 0, gross: 0, label: r.grp_label || r.product_code }); variant[r.product_code].units += u; variant[r.product_code].gross += g;
    }
    return { units, gross, day, ch, variant };
  };
  const cur = useMemo(() => aggOf(rows), [rows]);
  const prev = useMemo(() => aggOf(prevRows), [prevRows]);

  const daySeries = useMemo(() => {
    const ds = Object.keys(cur.day).sort();
    return { ds, gross: ds.map(d => cur.day[d].gross), units: ds.map(d => cur.day[d].units), asp: ds.map(d => cur.day[d].units ? cur.day[d].gross / cur.day[d].units : 0) };
  }, [cur]);

  // ── hybrid headline: order-grain where a channel has it (complete, sku-map-independent),
  // product-grain gross as fallback for channels without it (QC). Drives the headline TOTALS only;
  // variants, movers, trend and drill stay product-grain; the Channel mix is hybrid too. ──
  const head = useMemo(() => hybridHeadline(segRows, rows), [segRows, rows]);
  const headPrev = useMemo(() => hybridHeadline(segPrevRows, prevRows), [segPrevRows, prevRows]);
  const headDaily = useMemo(() => {
    const byO = {}, byP = {};
    for (const r of segRows) (byO[r.sale_date] = byO[r.sale_date] || []).push(r);
    for (const r of rows) (byP[r.sale_date] = byP[r.sale_date] || []).push(r);
    const ds = [...new Set([...Object.keys(byO), ...Object.keys(byP)])].sort();
    return {
      net: ds.map(d => hybridHeadline(byO[d] || [], byP[d] || []).netExGst),
      gross: ds.map(d => hybridHeadline(byO[d] || [], byP[d] || []).grossAll),
    };
  }, [segRows, rows]);

  const trend = useMemo(() => {
    const dv = {};
    for (const r of rows) {
      const gk = channelGroup(chName[r.channel_id] || '');
      const v = trendMetric === 'units' ? (Number(r.units) || 0) : (Number(r.gross_value) || 0);
      (dv[r.sale_date] = dv[r.sale_date] || {}); dv[r.sale_date][gk] = (dv[r.sale_date][gk] || 0) + v;
    }
    return { dv, days: Object.keys(dv).sort() };
  }, [rows, chName, trendMetric]);

  // Channel mix = per-channel hybrid headline (lib/segregation.js hybridByChannel): NET (default)
  // sums exactly to the Net revenue KPI, GROSS to the Gross sales KPI (Afshaan S403 — gross used to
  // be product-grain `cur.ch`, which missed unmapped-SKU orders — Website up to ~15% on a day —
  // and cancelled value). Like the tile, per-channel gross Δ now moves with cancellations.
  const chHead = useMemo(() => hybridByChannel(segRows, rows), [segRows, rows]);
  const chHeadPrev = useMemo(() => hybridByChannel(segPrevRows, prevRows), [segPrevRows, prevRows]);

  const channelBoard = useMemo(() => {
    const k = mixMetric === 'net' ? 'net' : 'gross';
    const arr = Object.entries(chHead).map(([id, h]) => ({
      id, name: chName[id] || id, gk: channelGroup(chName[id] || ''),
      value: h[k] || 0,
      prevValue: chHeadPrev[id]?.[k] || 0,
    })).filter(c => c.value !== 0).sort((a, b) => b.value - a.value);
    const max = Math.max(...arr.map(c => c.value), 1);
    // `total` = the selected KPI (Net revenue or Gross sales) and heads the donut; SHARES divide by the positive sum
    // only, because the donut can't draw a negative arc — a channel whose returns out-ran its sales
    // shows its (negative) ₹ with no share, rather than pushing the others past 100%.
    const total = arr.reduce((a, c) => a + c.value, 0);
    const posTotal = arr.reduce((a, c) => a + Math.max(0, c.value), 0);
    return { arr, max, total, posTotal };
  }, [chName, chHead, chHeadPrev, mixMetric]);

  // family roll-up of the channel board (net or gross, whichever is selected) — one donut arc per family.
  // Derived client-side from rows already loaded; no additional read.
  const famMix = useMemo(() => {
    const t = {};
    for (const c of channelBoard.arr) {
      const k = c.gk;
      (t[k] = t[k] || { key: k, label: GROUP_META[k].label, color: GROUP_META[k].color, value: 0 });
      t[k].value += c.value;
    }
    return GROUP_ORDER.filter(k => t[k] && t[k].value > 0).map(k => t[k]);
  }, [channelBoard]);

  const variantBoard = useMemo(() => {
    const src = {};
    for (const [code, v] of Object.entries(cur.variant)) {
      const key = sellerRollup === 'product' ? (codeToProduct[code] || v.label) : code;
      const label = sellerRollup === 'product' ? (codeToProduct[code] || v.label) : v.label;
      const s = src[key] || (src[key] = { key, label, gross: 0, units: 0 });
      s.gross += v.gross; s.units += v.units;
    }
    const arr = Object.values(src).sort((a, b) => (variantMetric === 'units' ? b.units - a.units : b.gross - a.gross)).slice(0, 12);
    const max = Math.max(...arr.map(v => variantMetric === 'units' ? v.units : v.gross), 1);
    return { arr, max };
  }, [cur, variantMetric, sellerRollup, codeToProduct]);

  // biggest gainers / decliners by gross ₹ vs prior period (variant grain)
  const movers = useMemo(() => {
    const codes = new Set([...Object.keys(cur.variant), ...Object.keys(prev.variant)]);
    const arr = [];
    for (const code of codes) {
      const c = cur.variant[code]?.gross || 0, p = prev.variant[code]?.gross || 0;
      const delta = c - p;
      if (Math.abs(delta) < 1 || Math.max(c, p) < 2000) continue; // drop noise
      arr.push({ code, label: cur.variant[code]?.label || prev.variant[code]?.label || code, c, p, delta, pct: p ? (delta / p) * 100 : null });
    }
    return {
      up: arr.filter(x => x.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 6),
      down: arr.filter(x => x.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 6),
    };
  }, [cur, prev]);

  // connector freshness (enabled connectors only)
  const health = useMemo(() => connectors.filter(c => c.enabled).map(c => ({
    ...c, statusKey: c.last_error ? 'error' : (c.last_run?.status || (c.last_ok_at ? 'ok' : 'never')),
  })).sort((a, b) => (a.name || '').localeCompare(b.name || '')), [connectors]);

  const activeChannels = useMemo(() => Object.values(cur.ch).filter(c => c.gross > 0).length, [cur]);
  const prevActive = useMemo(() => Object.values(prev.ch).filter(c => c.gross > 0).length, [prev]);
  const curAsp = cur.units ? cur.gross / cur.units : 0;
  const prevAsp = prev.units ? prev.gross / prev.units : 0;
  const pct = (c, p) => (p ? ((c - p) / p) * 100 : null);

  // ── Detail product search ──────────────────────────────────────────────────
  // One flat list carrying BOTH grains: a whole-product entry and each of its variants,
  // contiguous under a per-product `group` header (Combobox emits a header on change, so
  // same-group options must stay adjacent). Colour and model live in the label; the product
  // name and the codes ride in `search`, which is matched but never rendered — so typing a
  // product ("Flare"), a variant ("Base"), a colour ("Red") or a code all find the same rows.
  const catVariants = useMemo(
    () => (categoryFilter === 'all' ? variants : variants.filter(v => v.category === categoryFilter)),
    [variants, categoryFilter]);
  const productOptions = useMemo(() => {
    const byProduct = new Map();
    for (const v of catVariants) {
      const p = v.product || v.product_code;
      if (!p) continue;
      if (!byProduct.has(p)) byProduct.set(p, []);
      byProduct.get(p).push(v);
    }
    const out = [];
    for (const p of [...byProduct.keys()].sort((a, b) => a.localeCompare(b))) {
      const vs = byProduct.get(p);
      const codes = vs.map(v => v.product_code).filter(Boolean);
      out.push({
        value: `p:${p}`, label: p, group: p,
        hint: vs.length > 1 ? `all ${vs.length} variants` : (vs[0].color || vs[0].model || vs[0].product_code),
        search: [...vs.map(v => `${v.model || ''} ${v.color || ''} ${v.sku || ''}`), ...codes].join(' '),
      });
      // A single-variant product would otherwise appear twice, as two entries that filter to the
      // exact same one code. The product entry already carries that variant's model and colour in
      // `search`, so collapsing loses no way of finding it. 7 of 47 products today.
      if (vs.length === 1) continue;
      for (const v of vs.sort((a, b) => `${a.model} ${a.color}`.localeCompare(`${b.model} ${b.color}`))) {
        const bits = [v.model, v.color].filter(Boolean).join(' · ');
        out.push({
          value: `v:${v.product_code}`, group: p,
          label: bits ? `${p} · ${bits}` : `${p} · ${v.product_code}`,
          hint: v.product_code,
          search: `${p} ${v.model || ''} ${v.color || ''} ${v.sku || ''} ${v.ean || ''}`,
        });
      }
    }
    return out;
  }, [catVariants]);

  // The set of product_codes the Detail table is restricted to — null when unfiltered.
  // Built from product_master, NOT from the codes present in `rows`, so selecting a product
  // that sold nothing in the range correctly yields an EMPTY table rather than silently
  // falling back to everything.
  const filterCodes = useMemo(() => {
    if (!productFilter) return categoryFilter === 'all' ? null : new Set(catVariants.map(v => v.product_code));
    if (productFilter.startsWith('v:')) return new Set([productFilter.slice(2)]);
    const p = productFilter.slice(2);
    return new Set(catVariants.filter(v => (v.product || v.product_code) === p).map(v => v.product_code));
  }, [productFilter, categoryFilter, catVariants]);

  const filterLabel = useMemo(
    () => (productFilter
      ? (productOptions.find(o => o.value === productFilter)?.label || '')
      : (CATEGORY_OPTS.find(([k]) => k === categoryFilter && k !== 'all')?.[1] || '')),
    [productFilter, categoryFilter, productOptions]);
  // A product picked under one category is not on the list under another, so a switch clears it.
  const pickCategory = (c) => { setCategoryFilter(c); setProductFilter(''); };

  // drill table (re-aggregate rows on the chosen axis)
  const table = useMemo(() => {
    const agg = {};
    for (const r of rows) {
      if (filterCodes && !filterCodes.has(r.product_code)) continue;
      const prod = codeToProduct[r.product_code] || r.product_code;
      const key = group === 'date' ? r.sale_date : group === 'channel' ? r.channel_id : group === 'product' ? prod : r.product_code;
      const label = group === 'date' ? r.sale_date : group === 'channel' ? (chName[r.channel_id] || r.channel_id) : group === 'product' ? prod : (r.grp_label || r.product_code);
      const a = agg[key] || (agg[key] = { key, label, units: 0, gross: 0, disc: 0, retU: 0, retV: 0 });
      a.units += Number(r.units) || 0; a.gross += Number(r.gross_value) || 0;
      a.disc += Number(r.discount_value) || 0; a.retU += Number(r.returned_units) || 0; a.retV += Number(r.returned_value) || 0;
    }
    return Object.values(agg).sort((a, b) => b.gross - a.gross);
  }, [rows, group, chName, codeToProduct, filterCodes]);
  const tblSort = useTableSort(table, { initialKey: 'gross' });

  // Totals for the current Detail selection — the "how much has this product sold" answer,
  // summed off the same rows the table renders so the two can never disagree.
  const tableTotals = useMemo(() => table.reduce((a, r) => ({
    units: a.units + r.units, gross: a.gross + r.gross, retU: a.retU + r.retU,
  }), { units: 0, gross: 0, retU: 0 }), [table]);

  const orderedChannels = useMemo(() => [...channels].sort((a, b) =>
    (GROUP_ORDER.indexOf(channelGroup(a.name)) - GROUP_ORDER.indexOf(channelGroup(b.name))) || a.name.localeCompare(b.name)
  ), [channels]);

  const applyPreset = (p) => { setPreset(p.key); setFrom(p.from); setTo(p.to); };
  const setCustomFrom = v => { setFrom(v); setPreset(''); };
  const setCustomTo = v => { setTo(v); setPreset(''); };
  // One fetch, two formats. XLSX is preferred by finance (types survive: a 13-digit
  // EAN stays text instead of turning into 5.9e+12, and numbers arrive summable).
  const exportRows = (fmt) => salesGet('getSalesExport', { from, to, group, channel_id: sel.join(',') }, session)
    .then(r => {
      // The export is a SEPARATE fetch from the table, so the Detail product filter has to be
      // re-applied to it by hand. Without this the screen shows one product and the file
      // silently contains the whole catalogue under a filename that says otherwise.
      const rows = (r?.rows || []).filter(x => !filterCodes || filterCodes.has(x.product_code));
      const slug = filterLabel ? '_' + filterLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : '';
      const base = `odo_${group}${slug}_${from}_${to}`;
      if (fmt === 'xlsx') downloadXlsx(rows, `${base}.xlsx`, `Odo ${group}`);
      else downloadCsv(rows, `${base}.csv`);
    }).catch(() => {});
  const toggleCh = (id) => setSel(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);

  const ppLabel = preset ? `prior ${PRESETS.find(p => p.key === preset)?.label || ''}` : 'prior period';
  const rangeLabel = (preset && PRESETS.find(p => p.key === preset)?.label) || `${from} → ${to}`;

  // S294 — drill-through: a Detail row opens the order lines underneath that slice.
  // Params mirror what the row aggregated: axis value + the page's current range + channel filter.
  const openDrill = (r) => {
    const base = { from, to, channel_id: sel.join(',') };
    // On the date and channel axes the row carries no product of its own, so a Detail product
    // filter has to be threaded into the drill explicitly — otherwise clicking a filtered row
    // opens EVERY product's orders for that day/channel and the modal's total contradicts the
    // row it was opened from (the mismatch the DrillModal banner already warns about).
    const filtered = filterCodes ? [...filterCodes].join(',') : '';
    if (group === 'variant') setDrill({ title: `${r.label} · ${rangeLabel}`, params: { ...base, products: r.key } });
    else if (group === 'product') {
      const codes = Object.keys(codeToProduct).filter(c => codeToProduct[c] === r.key);
      setDrill({ title: `${r.label} · ${rangeLabel}`, params: { ...base, products: (codes.length ? codes : [r.key]).join(',') } });
    }
    else if (group === 'date') setDrill({ title: filterLabel ? `${filterLabel} · ${r.key}` : r.key, params: { ...base, from: r.key, to: r.key, ...(filtered ? { products: filtered } : {}) } });
    else setDrill({ title: `${filterLabel ? filterLabel + ' · ' : ''}${r.label} · ${rangeLabel}`, params: { ...base, channel_id: r.key, ...(filtered ? { products: filtered } : {}) } });
  };

  // ── per-section guards (lib/dashboard.mjs need()): a section renders only when EVERY query it
  // reads holds data for this exact selection; else its skeleton, or its error + Retry. ──
  const filterActive = !!productFilter || categoryFilter !== 'all';
  const gHead = need([S, G, SP, GP]);      // Net revenue + Gross sales: value, Δ vs prior, spark, settled badge
  const gCurPrev = need([S, SP]);          // Units, ASP, Active channels (value + Δ); Movers
  const gTrend = need([S, B]);             // family per row = channel name → family
  const gMix = need([S, G, SP, GP, B]);    // per-channel hybrid net/gross, Δ, shares, names, family arcs
  const gSellers = need(sellerRollup === 'product' ? [S, V] : [S]);
  const gAcc = need([A]);
  const gConn = need([B]);
  const gVariants = need([V]);             // the Detail product picker + category switch
  const gDetail = need([S, ...(group === 'channel' ? [B] : []), ...(group === 'product' || filterActive ? [V] : [])]);
  // When the PAGE fetched the current selection's figures (sales, segregation, accessories — the
  // queries a selection change or return refreshes). Bootstrap/variants stamp their own sections.
  // Not the top-bar chip, which is how recent each channel's
  // source data is (getFreshness) — hence "Loaded", never "As of" / "Updated" / "synced" here.
  const fresh = pageFreshness(selPairs);
  const bootAsOf = panelAsOf(bootQ, BOOT_KEY);
  const variantsAsOf = panelAsOf(variantsQ, VARIANTS_KEY);
  // The export re-fetches, but is enabled off these rows and filtered by the variants: only on a
  // fresh, complete result for this selection — never off a cache seed or mid-refresh.
  const xg = exportGate({ salesQ, salesKey: K.sales, salesStartedAt: startedRef.current[K.sales], rowCount: rows.length,
    filterActive, variantsQ, variantsStartedAt: startedRef.current[VARIANTS_KEY] });

  // No sales_view: the worker would 403 every read ("No permission" — what this page showed before),
  // so it is said without making the calls or showing anything cached.
  if (perms && !access) {
    return (
      <div className="so-page">
        <PageHead title="Cross-channel dashboard" />
        <div className="so-card" style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 12 }}>No permission</div>
      </div>
    );
  }

  return (
    <div className="so-page">
      <PageHead
        title="Cross-channel dashboard"
        sub={<>Net revenue, mix and movers across every sales channel <span className="so-qual">· {rangeLabel}</span></>}
        right={fresh.text ? (<>
          <span aria-live="polite" title="When this page last fetched its figures. How recent each channel's source data is: the freshness chip in the top bar."
            style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: fresh.warn ? STATUS.warn : 'var(--t3)', whiteSpace: 'nowrap' }}>{fresh.text}</span>
          {fresh.warn && <button className="so-btn ghost" onClick={refreshSelection}>Retry</button>}
        </>) : null}
      />

      {/* controls — range + channel filter + export, one row. Stays a PAGE-LEVEL sticky
          header; never nest it inside a .so-card. */}
      <RangePicker from={from} to={to} presets={rangePresets()}
        onChange={({ from, to, preset }) => { setFrom(from); setTo(to); setPreset(preset); }}
        right={<>
          {gConn.state === 'ready' ? <ChannelFilter channels={orderedChannels} value={sel} onChange={setSel} />
            : gConn.state === 'error' ? <PanelError message="the channel list." onRetry={() => retry(gConn)} />
            : <Skeleton width={130} height={28} radius={8} />}
          <button className="so-btn ghost" onClick={() => exportRows('xlsx')} disabled={!xg.ok} title={xg.why || undefined}>Export Excel</button>
          <button className="so-btn ghost" onClick={() => exportRows('csv')} disabled={!xg.ok} title={xg.why || undefined}>CSV</button>
        </>} />

      <>
        {/* ── hero KPI 5-up — every tile owns a metric hue (handoff §3.4) ── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,minmax(0,1fr))', gap: 14 }}>
          {[
            { g: gHead, lbl: 'Net revenue (ex-GST)', val: inr(head.netExGst), d: pct(head.netExGst, headPrev.netExGst), spark: headDaily.net, hue: HUE.primary, sub: 'after disc · returns · GST', badge: <SettledBadge pct={head.settledPct} /> },
            { g: gHead, lbl: 'Gross sales', val: inr(head.grossAll), d: pct(head.grossAll, headPrev.grossAll), spark: headDaily.gross, hue: HUE.gross, sub: 'tax-incl · all channels' },
            { g: gCurPrev, lbl: 'Units sold', val: fmtInt(head.units), d: pct(head.units, headPrev.units), spark: daySeries.units, hue: HUE.units },
            { g: gCurPrev, lbl: 'Avg selling price', val: inr(curAsp), d: pct(curAsp, prevAsp), spark: daySeries.asp, hue: HUE.derived },
            { g: gCurPrev, lbl: 'Active channels', val: fmtInt(activeChannels), d: pct(activeChannels, prevActive), spark: null, hue: HUE.count },
          ].map((k, i) => (k.g.state === 'ready'
            ? <Kpi key={i} lbl={k.lbl} val={k.val} pct={k.d} sub={k.sub} badge={k.badge} spark={k.spark} hue={k.hue} deltaNote={`vs ${ppLabel}`} />
            : <KpiPending key={i} lbl={k.lbl} hue={k.hue} failed={k.g.state === 'error'} onRetry={() => retry(k.g)} />
          ))}
        </div>

        {/* ── stacked family trend — the chart itself ships UNCHANGED (handoff §7).
               Only the panel around it is restyled; the chart's direct parent carries no
               backdrop-filter. ── */}
        <div className="so-card">
          <PanelHead
            style={{ marginBottom: 6 }}
            title={`Daily ${trendMetric === 'units' ? 'units' : 'gross'} by channel family`}
            right={
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', gap: 13, flexWrap: 'wrap' }}>
                  {gTrend.state === 'ready' && GROUP_ORDER.filter(g => trend.days.some(d => (trend.dv[d]?.[g] || 0) > 0)).map(g => (
                    <span key={g} style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t2)' }}>
                      <Swatch color={GROUP_META[g].color} />{GROUP_META[g].label}
                    </span>
                  ))}
                </div>
                <SegmentedToggle options={['gross', 'units']} value={trendMetric} onChange={setTrendMetric} size="sm" />
              </div>
            } />
          <div>
            {gTrend.state === 'ready' ? (
              <StackedTrendChart days={trend.days} dayVals={trend.dv} metric={trendMetric}
                groups={GROUP_ORDER.map(k => ({ key: k, label: GROUP_META[k].label, color: GROUP_META[k].color }))} />
            ) : gTrend.state === 'error' ? <PanelError message="the daily trend." onRetry={() => retry(gTrend)} pad="24px 0" />
              : <Skeleton height={290} radius={10} />}
          </div>
        </div>

        {/* ── channel-mix donut + top variants ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>

          {/* channel mix — one donut arc per family, then the per-channel leaderboard */}
          <div className="so-card">
            <PanelHead title="Channel mix" qual={mixMetric === 'net' ? '· net share (ex-GST)' : '· gross share'}
              right={<SegmentedToggle options={['net', 'gross']} value={mixMetric} onChange={setMixMetric} size="sm" />} />
            {gMix.state === 'error' ? <PanelError message="the channel mix." onRetry={() => retry(gMix)} />
            : gMix.state === 'loading' ? <MixSkeleton />
            : channelBoard.arr.length === 0 ? <div style={EMPTY}>No sales in range.</div> : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 22, flexWrap: 'wrap' }}>
                <Donut segments={famMix.map(f => ({ key: f.key, label: f.label, value: f.value, color: f.color }))}
                  total={inr(channelBoard.total)} centerLabel={mixMetric === 'net' ? 'NET' : 'GROSS'} />
                <div style={{ flex: 1, minWidth: 190, display: 'flex', flexDirection: 'column', gap: 9 }}>
                  {famMix.map(f => (
                    <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Swatch color={f.color} />
                      <span style={NAME}>{f.label}</span>
                      <span style={{ ...NUM, color: 'var(--t3)', width: 46 }}>{channelBoard.posTotal ? ((f.value / channelBoard.posTotal) * 100).toFixed(1) : '0.0'}%</span>
                      <span style={{ ...NUM, color: 'var(--t1-cell)', width: 78 }}>{inr(f.value)}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--row-border)' }}>
                <div className="so-eyebrow" style={{ marginBottom: 10 }}>By channel</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {channelBoard.arr.map(c => {
                    const share = c.value > 0 && channelBoard.posTotal ? (c.value / channelBoard.posTotal) * 100 : null;
                    return (
                      <div key={c.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <Swatch color={GROUP_META[c.gk].color} />
                          <span style={NAME}>{c.name}</span>
                          <Delta now={c.value} prev={c.prevValue} />
                          <span style={{ ...NUM, color: 'var(--t3)', width: 38 }}>{share == null ? '—' : `${share.toFixed(0)}%`}</span>
                          <span style={{ ...NUM, color: 'var(--t1-cell)', width: 78 }}>{inr(c.value)}</span>
                        </div>
                        <Bar pct={Math.max(0, (c.value / channelBoard.max) * 100)} color={GROUP_META[c.gk].color} />
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
            )}
          </div>

          {/* top sellers — ranking bars */}
          <div className="so-card">
            <PanelHead
              title={`Top ${sellerRollup === 'product' ? 'products' : 'variants'}`}
              right={
                <div style={{ display: 'flex', gap: 8 }}>
                  <SegmentedToggle options={[['variant', 'Variant'], ['product', 'Product']]} value={sellerRollup} onChange={setSellerRollup} size="sm" />
                  <SegmentedToggle options={['gross', 'units']} value={variantMetric} onChange={setVariantMetric} size="sm" />
                </div>
              } />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              {gSellers.state === 'error' && <PanelError message={`the top ${sellerRollup === 'product' ? 'products' : 'variants'}.`} onRetry={() => retry(gSellers)} />}
              {gSellers.state === 'loading' && <BarRowsSkeleton rows={8} />}
              {gSellers.state === 'ready' && variantBoard.arr.length === 0 && <div style={EMPTY}>No sales in range.</div>}
              {gSellers.state === 'ready' && variantBoard.arr.map(v => {
                const onUnits = variantMetric === 'units';
                const m = onUnits ? v.units : v.gross;
                // Both numbers show, but the SELECTED metric is the emphasised one (bright + wider
                // slot) and the other drops to secondary — otherwise the toggle changes the sort
                // without changing what the eye reads. ₹ keeps its 78px slot in both states so a
                // long value never spills into the name column.
                return (
                  <div key={v.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={NAME}>{v.label}</span>
                      <span style={{ ...NUM, color: onUnits ? 'var(--t1-cell)' : 'var(--t3)', fontWeight: onUnits ? 600 : 400, width: onUnits ? 78 : 54 }}>{fmtInt(v.units)}</span>
                      <span style={{ ...NUM, color: onUnits ? 'var(--t3)' : 'var(--t1-cell)', fontWeight: onUnits ? 400 : 600, width: 78 }}>{inr(v.gross)}</span>
                    </div>
                    <Bar pct={(m / variantBoard.max) * 100} color="linear-gradient(90deg,#4C63F0,#F2CD1A)" />
                  </div>
                );
              })}
            </div>

            {/* Accessories & others — ONE bundled MEMO line. Sits below the variant board on
                purpose: these are real sales that have no product variant (gift wrap, spares,
                paid repairs), so they can be seen without being attributed to a car. NOT in any
                total above — mapping them to variants would inflate variant units. */}
            {gAcc.state === 'error' && (
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10,
                            fontFamily: 'var(--ui)', fontSize: 11, color: 'var(--t3)' }}>
                <span>Accessories &amp; others — <span style={{ color: STATUS.warn }}>couldn’t load</span>. The totals above are unaffected.</span>
                <button className="so-btn ghost" onClick={() => retry(gAcc)}>Retry</button>
              </div>
            )}
            {gAcc.state === 'loading' && (
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}><Skeleton width="60%" height={12} /></div>
            )}
            {gAcc.state === 'ready' && acc.total.gross > 0 && (
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ ...NAME, color: 'var(--t2)' }}>Accessories &amp; others</span>
                  <span style={{ ...NUM, color: 'var(--t3)', width: 54 }}>{fmtInt(acc.total.units)}</span>
                  <span style={{ ...NUM, color: 'var(--t2)', fontWeight: 600, width: 78 }}>{inr(acc.total.gross)}</span>
                </div>
                <div style={{ fontFamily: 'var(--ui)', fontSize: 10.5, color: 'var(--t3)', marginTop: 5, lineHeight: 1.5 }}>
                  {acc.buckets.join(' · ')}
                  {' — '}{fmtInt(acc.total.skus)} unmapped SKUs.{' '}
                  <b style={{ color: 'var(--t2)' }}>Memo only — not counted in the totals above.</b>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── movers + connector health ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16 }}>

          <div className="so-card">
            <PanelHead title="Movers" qual={`· gross ₹ vs ${ppLabel}`} />
            {gCurPrev.state === 'error' ? <PanelError message="the movers." onRetry={() => retry(gCurPrev)} /> : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 22 }}>
              {[['Gaining', movers.up, STATUS.good], ['Slipping', movers.down, STATUS.bad]].map(([title, list, color]) => (
                <div key={title} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{title}</div>
                  {gCurPrev.state === 'loading' && <BarRowsSkeleton rows={4} bars={false} />}
                  {gCurPrev.state === 'ready' && list.length === 0 && <Nil />}
                  {gCurPrev.state === 'ready' && list.map(m => (
                    <div key={m.code} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={NAME}>{m.label}</span>
                      <span style={{ ...NUM, color, width: 84 }}>{m.delta >= 0 ? '+' : '−'}{inr(Math.abs(m.delta))}</span>
                      <span style={{ ...NUM, color: 'var(--t5)', width: 52 }}>{m.pct == null ? 'new' : `${m.pct >= 0 ? '+' : ''}${m.pct.toFixed(0)}%`}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
            )}
          </div>

          <div className="so-card">
            <PanelHead title="Connector health"
              qual={bootAsOf && <span style={{ color: bootAsOf.warn ? STATUS.warn : undefined }}>· {bootAsOf.text}
                {bootAsOf.warn && <button className="so-btn bare" style={{ marginLeft: 6, fontSize: 'inherit', color: 'var(--accent)' }} onClick={() => refreshPair(B)}>Retry</button>}</span>}
              right={gConn.state === 'ready' &&
              <a href="/mapping" style={{ fontFamily: 'var(--mono)', fontSize: 10, color: unmappedCount ? 'var(--amber)' : 'var(--t3)', border: `1px solid ${unmappedCount ? 'rgba(245,158,11,.4)' : 'var(--border-ctl)'}`, borderRadius: 'var(--r-pill)', padding: '3px 10px', whiteSpace: 'nowrap' }}>
                {unmappedCount} unmapped SKU{unmappedCount === 1 ? '' : 's'}{unmappedCount ? ' →' : ''}
              </a>
            } />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {gConn.state === 'error' && <PanelError message="connector health." onRetry={() => retry(gConn)} />}
              {gConn.state === 'loading' && [0, 1, 2, 3, 4].map(i => <Skeleton key={i} width={118} height={30} radius={8} />)}
              {gConn.state === 'ready' && health.length === 0 && <div style={EMPTY}>No connectors enabled.</div>}
              {gConn.state === 'ready' && health.map(c => {
                const gk = channelGroup(c.name || '');
                const sc = HEALTH_COLOR[c.statusKey];
                return (
                  <div key={c.channel_id} title={c.last_error || ''}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--control)', border: '1px solid var(--border-ctl)', borderRadius: 'var(--r-md)', padding: '6px 10px' }}>
                    <Swatch color={GROUP_META[gk].color} />
                    <span style={{ fontFamily: 'var(--ui)', fontSize: 12, color: 'var(--t1)' }}>{c.name}</span>
                    <span className="so-dot" style={{ width: 6, height: 6, background: sc, boxShadow: `0 0 7px 0 ${sc}` }} />
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t5)' }}>{ago(c.last_ok_at)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* ── drill table ── */}
        <div className="so-card flush">
          <PanelHead title="Detail" style={{ marginBottom: 0 }}
            qual={filterLabel ? `· ${filterLabel}` : undefined}
            right={
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                {/* `portal` is REQUIRED here — the dropdown lives inside .so-card, which clips
                    and establishes its own stacking/transform context (PATTERN-160). */}
                {/* No category on the rows (variants failed to load) would read as a false zero. */}
                {/* Variants failed with nothing cached: say so where the picker would be, never a blank picker. */}
                {gVariants.state === 'error' ? <PanelError message="the product list." onRetry={() => retry(gVariants)} />
                  : gVariants.state === 'loading' ? <Skeleton width={250} height={28} radius={8} /> : (<>
                {/* A failed refresh over a cached product list says so here, not in the header line. */}
                {variantsAsOf?.warn && (
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: STATUS.warn }}>
                    Product list: {variantsAsOf.text} <button className="so-btn bare" style={{ fontSize: 'inherit', color: 'var(--accent)' }} onClick={() => refreshPair(V)}>Retry</button>
                  </span>
                )}
                {variants.some(v => v.category) && <SegmentedToggle options={CATEGORY_OPTS} value={categoryFilter} onChange={pickCategory} size="sm" />}
                <div style={{ minWidth: 250 }}>
                  <Combobox options={productOptions} value={productFilter} onChange={setProductFilter}
                    placeholder="Search product, variant or colour…" portal />
                </div>
                </>)}
                <SegmentedToggle options={GROUPS.map(g => [g.key, g.label])} value={group} onChange={setGroup} size="sm" />
              </div>
            } />
          {filterLabel && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
              padding: '8px 14px', borderBottom: '1px solid var(--border)',
              fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>
              {gDetail.state === 'ready' ? <>
              <span><b style={{ color: 'var(--t1)' }}>{fmtInt(tableTotals.units)}</b> units</span>
              <span><b style={{ color: 'var(--t1)' }}>{inr(tableTotals.gross)}</b> gross</span>
              {tableTotals.retU > 0 && <span>{fmtInt(tableTotals.retU)} returned</span>}
              </> : <Skeleton width={180} height={12} />}
              <span style={{ color: 'var(--t4)' }}>· {rangeLabel} · this panel only, the figures above are all products</span>
              <button className="so-btn ghost" style={{ marginLeft: 'auto' }} onClick={() => pickCategory('all')}>Clear</button>
            </div>
          )}
          {gDetail.state === 'error' ? <PanelError message="the detail table." onRetry={() => retry(gDetail)} pad="24px 14px" />
          : gDetail.state === 'loading' ? <TableSkeleton rows={8} />
          : table.length === 0 ? (
            <div style={{ ...EMPTY, padding: 36, textAlign: 'center' }}>
              {filterLabel
                ? <>No sales of <b style={{ color: 'var(--t2)' }}>{filterLabel}</b> in this range. Widen the range, clear the channel filter, or check it is mapped under <b style={{ color: 'var(--t2)' }}>Mapping</b>.</>
                : <>No sales for this range yet. Pull a channel from <b style={{ color: 'var(--t2)' }}>Connectors</b> or upload a report from <b style={{ color: 'var(--t2)' }}>Uploads</b>.</>}
            </div>
          ) : (
            <table className="so-table">
              <thead><tr>
                <SortHeader k="label" label={group === 'date' ? 'Day' : group === 'channel' ? 'Channel' : group === 'product' ? 'Product' : 'Variant'} sort={tblSort} />
                <SortHeader k="units" label="Units" sort={tblSort} numeric />
                <SortHeader k="gross" label="Gross ₹" sort={tblSort} numeric />
                <SortHeader k="disc" label="Disc ₹" sort={tblSort} numeric />
                <SortHeader k="retU" label="Ret u" sort={tblSort} numeric />
                <SortHeader k="retV" label="Ret ₹" sort={tblSort} numeric />
              </tr></thead>
              <tbody>
                {tblSort.sorted.map(r => (
                  <tr key={r.key} onClick={() => openDrill(r)} style={{ cursor: 'pointer' }}
                      title="View underlying orders">
                    <td>
                      {group === 'channel' ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                          <Swatch color={GROUP_META[channelGroup(r.label)].color} />{r.label}
                        </span>
                      ) : group === 'date' ? (
                        <span style={{ fontFamily: 'var(--mono)', fontVariantNumeric: 'tabular-nums' }}>{r.label}</span>
                      ) : r.label}
                    </td>
                    <td className="so-num">{fmtInt(r.units)}</td>
                    <td className="so-num bright">{inr(r.gross)}</td>
                    <td className="so-num">{r.disc ? inr(r.disc) : <Nil />}</td>
                    <td className="so-num">{r.retU ? fmtInt(r.retU) : <Nil />}</td>
                    <td className="so-num">{r.retV ? inr(r.retV) : <Nil />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {drill && (
          <DrillModal title={drill.title} params={drill.params} session={session}
            chName={chName} codeToProduct={codeToProduct} onClose={() => setDrill(null)} />
        )}
      </>
    </div>
  );
}

// ── loading / error states (instant-load pattern) — shaped like what they stand in for ──

// A section whose call failed with nothing to show: say so, offer Retry. Never zeros.
function PanelError({ message, onRetry, pad }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: pad,
      fontFamily: 'var(--ui)', fontSize: 12, color: 'var(--t3)' }}>
      <span><span style={{ color: STATUS.warn }}>Couldn’t load</span> {message}</span>
      <button className="so-btn ghost" onClick={onRetry}>Retry</button>
    </div>
  );
}

// A KPI tile (label kept, no value) while any input of its figure is missing.
function KpiPending({ lbl, hue, failed, onRetry }) {
  return (
    <div className="so-stat" style={hueStyle(hue)} aria-busy={!failed}>
      <div className="so-stat-top">
        <span className="so-stat-swatch" />
        <span className="so-stat-lbl">{lbl}</span>
      </div>
      {failed ? <PanelError message="" onRetry={onRetry} /> : (
        <>
          <Skeleton width="60%" height={26} />
          <Skeleton width="45%" height={11} style={{ marginTop: 8 }} />
          <Skeleton height={28} style={{ marginTop: 8 }} />
        </>
      )}
    </div>
  );
}

function MixSkeleton() {
  return (
    <div aria-busy="true">
      <div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
        <Skeleton width={150} height={150} radius={75} />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 11 }}>
          {[0, 1, 2, 3].map(i => <Skeleton key={i} height={12} />)}
        </div>
      </div>
      <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--row-border)' }}>
        <BarRowsSkeleton rows={5} />
      </div>
    </div>
  );
}

function BarRowsSkeleton({ rows, bars = true }) {
  return (
    <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <Skeleton width={`${85 - (i % 4) * 9}%`} height={12} />
          {bars && <Skeleton height={5} radius={3} />}
        </div>
      ))}
    </div>
  );
}

function TableSkeleton({ rows }) {
  return (
    <div aria-busy="true" style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} style={{ display: 'flex', gap: 16 }}>
          <Skeleton width="34%" height={12} />
          {[0, 1, 2, 3, 4].map(j => <Skeleton key={j} width="11%" height={12} />)}
        </div>
      ))}
    </div>
  );
}

// S294 — underlying orders for one Detail slice. Line grain straight off staging (the same rows
// recompute_facts aggregates), so the modal's sale total always matches the cell it was opened from.
const DRILL_LIMIT = 1000;
function DrillModal({ title, params, session, chName, codeToProduct, onClose }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let dead = false;
    salesGet('getCellOrders', { ...params, limit: DRILL_LIMIT }, session)
      .then(r => { if (!dead) setRows(r?.rows || []); })
      .catch(e => { if (!dead) { setErr(String(e?.message || e)); setRows([]); } });
    return () => { dead = true; };
  }, [params, session]);

  const sale = (rows || []).filter(r => r.row_type === 'sale' && !r.is_cancelled);
  const units = sale.reduce((a, r) => a + (Number(r.qty) || 0), 0);
  const gross = sale.reduce((a, r) => a + (Number(r.gross_value) || 0), 0);

  return (
    <Modal open title={`Orders — ${title}`} onClose={onClose} size="lg">
      {rows === null ? <div style={{ padding: 40, textAlign: 'center' }}><Spinner /></div> : (
        <>
          <div style={{ display: 'flex', gap: 16, marginBottom: 10, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>
            {/* On a truncated slice the sums cover only the fetched lines — say so, or the number
                reads as a mismatch against the Detail row it was opened from. */}
            {rows.length >= DRILL_LIMIT
              ? <span style={{ color: 'var(--amber, #d97706)' }}>showing first {DRILL_LIMIT} lines ({fmtInt(units)} units · {inr(gross)} of the row's total) — narrow the range for the rest</span>
              : <span>{fmtInt(units)} units · {inr(gross)} live sale value</span>}
            {err && <span style={{ color: 'var(--red)' }}>{err}</span>}
          </div>
          {rows.length === 0 ? (
            <div style={{ ...EMPTY, padding: 24, textAlign: 'center' }}>No staged order lines for this slice.</div>
          ) : (
            <div style={{ maxHeight: '60vh', overflow: 'auto' }}>
              <table className="so-table">
                <thead><tr>
                  <th>Date</th><th>Order</th><th>Channel</th><th>Variant</th>
                  <th className="so-num">Qty</th><th className="so-num">Gross ₹</th><th>Status</th>
                </tr></thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} style={r.is_cancelled || r.row_type === 'return' ? { opacity: 0.55 } : undefined}>
                      <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{r.sale_date}</td>
                      <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>
                        {r.order_ref || r.source_order_id || <span style={{ color: 'var(--t5)' }}>report row</span>}
                      </td>
                      <td style={{ fontSize: 11 }}>{chName[r.channel_id] || '—'}</td>
                      <td style={{ fontSize: 11 }} title={r.channel_sku}>
                        {r.product_code}{codeToProduct[r.product_code] ? ` · ${codeToProduct[r.product_code]}` : ''}
                      </td>
                      <td className="so-num">{fmtInt(r.qty)}</td>
                      <td className="so-num bright">{inr(Number(r.gross_value) || 0)}</td>
                      <td style={{ fontFamily: 'var(--mono)', fontSize: 10 }}>
                        {r.row_type === 'return' ? <span style={{ color: 'var(--red)' }}>RETURN</span>
                          : r.is_cancelled ? <span style={{ color: 'var(--t5)' }}>CANCELLED</span>
                          : <span style={{ color: 'var(--t4)' }}>SALE</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
