'use client';
// Amazon — the merged channel page (lives under Channels, replaces the generic family page for
// Amazon). Combines the rich Amazon cockpit (orders/sales value + Organic/RTO/RTV, ad metrics,
// returns split, sales-by-state, Model/SKU sellers) with the family page's daily trend. Built on
// the shared S169 kit. Influencer/Repairs order-type tiles are intentionally NOT shown — those are
// Shopify-tag-driven and always 0 for Amazon. ⭐ REPLACEMENTS ARE THE EXCEPTION (S273): Amazon's
// all-orders report carries `is-replacement-order`, the adapter now tags those rows
// 'amz_replacement', and the existing order_type_rules → f_order_rollup → aggOrders chain counts
// them — so `seg.repl` is real here. The long-standing "no Amazon feed exists for replacements"
// note was simply wrong; the column had been in every stored line all along.
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { salesGet, inr, fmtInt, rangePresets, priorPeriod } from '../lib/api.js';
import { familyOf, FAMILIES, FAMILY_ORDER, SUBCHANNEL_PALETTE } from '../lib/families.js';
import { aggOrders, GST_RATE } from '../lib/segregation.js';
import { Kpi, SettledBadge, RangePicker, SegmentedToggle, useTableSort, SortHeader } from './kit.js';
import { PageHead, ScopeTab, Swatch } from './prism.js';
import { HUE } from '../lib/hues.js';
import StackedTrendChart from './StackedTrendChart.js';

const AMZ = '#4C63F0';
// bar-in-cell track (§3.6) — the old `--surface2` fill was a nested-ROW token, too heavy for a track
const TRACK = 'rgba(255,255,255,.05)';
const pct1 = (n, d) => (d > 0 ? (n / d) * 100 : 0);

// 'rtv_reported' is the FBA customer-returns report — a physical-returns COUNT that stays current,
// where the refund behind it can post weeks later. Kept in its own bucket, out of `total` and out of
// `unknown`, so it can headline the RTV unit count without ever being added to returns value (the
// same return is counted again in rtv/unknown once its refund posts).
function aggReturns(rows) {
  const k = { rto: { orders: 0, units: 0, value: 0 }, rtv: { orders: 0, units: 0, value: 0 },
              unknown: { orders: 0, units: 0, value: 0 }, rtvReported: { orders: 0, units: 0, value: 0 } };
  for (const r of (rows || [])) {
    const t = r.return_kind === 'rtv_reported' ? k.rtvReported : (k[r.return_kind] || k.unknown);
    t.orders += Number(r.orders) || 0; t.units += Number(r.units) || 0; t.value += Number(r.value) || 0;
  }
  return { ...k, total: k.rto.value + k.rtv.value + k.unknown.value };
}
// sum f_sales_rollup variant rows (one per code × date) → top 15 at the chosen rollup.
// mode 'variant' = per SKU (product_code, full variant label); 'product' = per product family
// (Shadow/Ghost/Flare…) via the code→product map (the RPC's own 'product' group is a no-op).
function topByCode(rows, mode, c2p) {
  const by = {};
  for (const r of (rows || [])) {
    const code = r.product_code; if (!code) continue;
    const key = mode === 'product' ? (c2p[code] || r.grp_label || code) : code;
    const label = mode === 'product' ? (c2p[code] || r.grp_label || code) : (r.grp_label || code);
    (by[key] = by[key] || { code: key, label, units: 0, gross: 0 });
    by[key].units += Number(r.units) || 0; by[key].gross += Number(r.gross_value) || 0;
  }
  const arr = Object.values(by).sort((a, b) => b.gross - a.gross).slice(0, 15);
  return { arr, max: Math.max(...arr.map(v => v.gross), 1) };
}

export default function AmazonPage() {
  const { session } = useAuth();
  const router = useRouter();
  const presets = rangePresets();
  const mtd = presets.find(p => p.key === 'mtd');
  const [from, setFrom] = useState(mtd.from);
  const [to, setTo] = useState(mtd.to);
  const [grp, setGrp] = useState('variant');         // sellers: variant=SKU | product=Model
  const [trendMetric, setTrendMetric] = useState('gross');
  const [d, setD] = useState(null);                  // { seg, segPrev, mkt, mktPrev, ret, geo, salesVar, salesProd }
  const [err, setErr] = useState('');

  // Amazon family channels (Amazon - FBA etc.) for getSegregation/getSales + trend groups
  const [amzCh, setAmzCh] = useState(null);
  const [c2p, setC2p] = useState({});                // product_code → product family (for the Model rollup)
  useEffect(() => {
    if (!session) return;
    salesGet('getBootstrap', {}, session)
      .then(b => setAmzCh((b?.channels || []).filter(c => familyOf(c.name) === 'amazon').map(c => ({ channel_id: c.channel_id || c.id, name: c.name }))))
      .catch(() => setAmzCh([]));
    salesGet('getVariants', {}, session)
      .then(r => { const m = {}; (r?.rows || []).forEach(v => { m[v.product_code] = v.product; }); setC2p(m); })
      .catch(() => {});
  }, [session]);
  const idsKey = (amzCh || []).map(c => c.channel_id).join(',');

  useEffect(() => {
    if (!session || amzCh === null) return;
    setD(null); setErr('');
    if (!idsKey) { setD({ seg: [], segPrev: [], mkt: [], mktPrev: [], ret: [], geo: [], salesVar: [], adProd: [], settle: { by_date: [], by_product: [], recon: [] } }); return; }
    const pp = priorPeriod(from, to);
    Promise.all([
      salesGet('getSegregation', { from, to, channel_id: idsKey }, session),
      salesGet('getSegregation', { from: pp.from, to: pp.to, channel_id: idsKey }, session),
      salesGet('getMarketing', { from, to, group: 'platform' }, session),
      salesGet('getMarketing', { from: pp.from, to: pp.to, group: 'platform' }, session),
      salesGet('getAmazonReturns', { from, to, group: 'overall' }, session),
      salesGet('getAmazonGeo', { from, to }, session),
      salesGet('getSales', { from, to, group: 'variant', channel_id: idsKey }, session),
      salesGet('getAdProduct', { from, to }, session),
      salesGet('getSettlement', { from, to }, session),
      // per-product returns for the sellers table. f_amazon_returns_rollup already supported
      // group='product'; only the read side was overall-only.
      salesGet('getAmazonReturns', { from, to, group: 'product' }, session),
      salesGet('getAmazonTraffic', { from, to, group: 'overall' }, session),
      salesGet('getAmazonTraffic', { from, to, group: 'date' }, session),
      salesGet('getAmazonTraffic', { from, to, group: 'product' }, session),
    ]).then(([seg, segPrev, mkt, mktPrev, ret, geo, sv, adp, setl, retP, trO, trD, trP]) => {
      setD({ seg: seg?.rows || [], segPrev: segPrev?.rows || [], mkt: mkt?.rows || [], mktPrev: mktPrev?.rows || [], ret: ret?.rows || [], geo: geo?.rows || [], salesVar: sv?.rows || [], adProd: adp?.rows || [], retProd: retP?.rows || [], trafficAll: trO?.rows || [], trafficDay: trD?.rows || [], trafficProd: trP?.rows || [], settle: { by_date: setl?.by_date || [], by_product: setl?.by_product || [], recon: setl?.recon || [] } });
    }).catch(e => setErr(e.message || String(e)));
  }, [session, amzCh, idsKey, from, to]);

  const seg = useMemo(() => aggOrders(d?.seg), [d]);
  const segP = useMemo(() => aggOrders(d?.segPrev), [d]);
  // Sponsored Ads (SP/SB/SD) = platform EXACTLY 'amazon'. Amazon DSP is a SEPARATE platform
  // ('amazon_dsp') — match each precisely so DSP never pollutes the Sponsored-Ads strip (they
  // attribute the same ASINs, so a regex that caught both would double-count ROAS).
  const ad = useMemo(() => (d?.mkt || []).find(r => (r.grp || '') === 'amazon') || {}, [d]);
  const adP = useMemo(() => (d?.mktPrev || []).find(r => (r.grp || '') === 'amazon') || {}, [d]);
  const dsp = useMemo(() => (d?.mkt || []).find(r => (r.grp || '') === 'amazon_dsp') || {}, [d]);
  const dspP = useMemo(() => (d?.mktPrev || []).find(r => (r.grp || '') === 'amazon_dsp') || {}, [d]);
  const ret = useMemo(() => aggReturns(d?.ret), [d]);
  const sellers = useMemo(() => topByCode(d?.salesVar, grp, c2p), [d, grp, c2p]);
  // ad metrics per sellers-key (SKU mode → product_code; Model mode → product family via c2p).
  // The '' unmapped-residual bucket from f_mkt_product_rollup is skipped (falsy code).
  const adByKey = useMemo(() => {
    const by = {};
    for (const r of (d?.adProd || [])) {
      const code = r.product_code; if (!code) continue;
      const key = grp === 'product' ? (c2p[code] || code) : code;
      (by[key] = by[key] || { spend: 0, adSales: 0, clicks: 0, impr: 0 });
      by[key].spend += Number(r.spend) || 0; by[key].adSales += Number(r.conv_value) || 0;
      by[key].clicks += Number(r.clicks) || 0; by[key].impr += Number(r.impressions) || 0;
    }
    return by;
  }, [d, grp, c2p]);
  // returns per sellers-key. Same bucket discipline as aggReturns: 'rtv_reported' is a COUNT that
  // stays current where its refund posts weeks later, so RTV units prefer it and fall back to the
  // refund-derived count — but it is NEVER added to a value total (that double-counts the refund).
  const retByKey = useMemo(() => {
    const by = {};
    for (const r of (d?.retProd || [])) {
      const code = r.product_code; if (!code || code === 'UNMAPPED') continue;
      const key = grp === 'product' ? (c2p[code] || code) : code;
      const t = (by[key] = by[key] || { rtoUnits: 0, rtoValue: 0, rtvUnits: 0, rtvReported: 0, rtvValue: 0, unknownUnits: 0 });
      const units = Number(r.units) || 0, value = Number(r.value) || 0;
      if (r.return_kind === 'rto') { t.rtoUnits += units; t.rtoValue += value; }
      else if (r.return_kind === 'rtv') { t.rtvUnits += units; t.rtvValue += value; }
      else if (r.return_kind === 'rtv_reported') { t.rtvReported += units; }
      else { t.unknownUnits += units; }   // refund posted, reason not yet classified
    }
    return by;
  }, [d, grp, c2p]);
  // Amazon traffic (S265). Absent until the connector has walked to this range, so every consumer
  // must tolerate zero rows — this is a backfilling feed, not a guaranteed one.
  const traffic = useMemo(() => {
    const t = (d?.trafficAll || [])[0] || null;
    if (!t) return null;
    const sessions = Number(t.sessions) || 0, units = Number(t.units_ordered) || 0;
    return {
      sessions, pageViews: Number(t.page_views) || 0, units,
      buyBox: t.buy_box_pct == null ? null : Number(t.buy_box_pct),
      usp: sessions ? (units / sessions) * 100 : 0,
      adClicks: Number(t.ad_clicks) || 0,
      inorganic: Number(t.inorganic_sessions) || 0,
      organic: Number(t.organic_sessions) || 0,
    };
  }, [d]);
  const trafficByCode = useMemo(() => {
    const by = {};
    for (const r of (d?.trafficProd || [])) {
      const code = r.grp; if (!code || code === 'UNMAPPED') continue;
      const key = grp === 'product' ? (c2p[code] || code) : code;
      const t = (by[key] = by[key] || { sessions: 0, units: 0 });
      t.sessions += Number(r.sessions) || 0; t.units += Number(r.units_ordered) || 0;
    }
    return by;
  }, [d, grp, c2p]);
  // Only add the traffic columns once the feed actually covers this range — two permanently-dashed
  // columns read as broken, where their absence reads as "not applicable to this range".
  const hasTraffic = Object.keys(trafficByCode).length > 0;
  const EMPTY_RET = { rtoUnits: 0, rtoValue: 0, rtvUnits: 0, rtvReported: 0, rtvValue: 0, unknownUnits: 0 };
  const retOf = code => {
    const t = retByKey[code] || EMPTY_RET;
    // Ret% must count UNCLASSIFIED refunds too. Classification trails the Finances feed by weeks,
    // so at any given moment `unknown` is the biggest bucket (1,061u vs 33 rtv / 1 rto over the
    // last 30d) — a rate built on rto+rtv alone would read ~0% for products that are genuinely
    // being returned. rto/rtv/unknown are mutually exclusive (one return_kind per row) so they
    // sum cleanly; rtv_reported is DELIBERATELY excluded from the sum because it re-counts the
    // same physical return once its refund posts.
    return { ...t, rtvShown: t.rtvReported || t.rtvUnits,
             totalReturned: t.rtoUnits + t.rtvUnits + t.unknownUnits };
  };
  const sellerSort = useTableSort(sellers.arr, { initialKey: 'gross', valueOf: (v, k) => {
    const a = adByKey[v.code] || { spend: 0, adSales: 0 };
    if (k === 'sessions') return (trafficByCode[v.code] || {}).sessions || 0;
    if (k === 'cvr') { const t = trafficByCode[v.code] || {}; return t.sessions ? t.units / t.sessions : 0; }
    if (k === 'rto') return retOf(v.code).rtoUnits;
    if (k === 'rtv') return retOf(v.code).rtvShown;
    if (k === 'retpct') return v.units ? retOf(v.code).totalReturned / v.units : 0;
    if (k === 'label') return v.label;
    if (k === 'asp') return v.units ? v.gross / v.units : 0;
    if (k === 'spend') return a.spend;
    if (k === 'adSales') return a.adSales;
    if (k === 'roas') return a.spend > 0 ? a.adSales / a.spend : 0;
    if (k === 'acos') return a.adSales > 0 ? a.spend / a.adSales : 0;
    if (k === 'tacos') return v.gross > 0 ? a.spend / v.gross : 0;
    if (k === 'organic') return v.gross > 0 ? (v.gross - a.adSales) / v.gross : 0;
    return v[k];
  } });

  const spend = Number(ad.spend) || 0, clicks = Number(ad.clicks) || 0, impr = Number(ad.impressions) || 0, convs = Number(ad.conversions) || 0, attr = Number(ad.conv_value) || 0;
  const pSpend = Number(adP.spend) || 0, pAttr = Number(adP.conv_value) || 0;
  const gross = seg.grossAll || 0, pGross = segP.grossAll || 0;
  const roas = spend > 0 ? attr / spend : 0,        pRoas = pSpend > 0 ? pAttr / pSpend : 0;
  const acos = attr > 0 ? (spend / attr) * 100 : 0,  pAcos = pAttr > 0 ? (pSpend / pAttr) * 100 : 0;
  // TACOS is total-ad-cost-of-sale, so its numerator is SPEND ACROSS EVERY AMAZON AD PRODUCT —
  // Sponsored (SP+SB+SD) plus DSP. Only attributed SALES can't be summed across the two (they
  // attribute the same purchases, which is why ROAS/ACOS below stay Sponsored-only); spend is
  // simply money out. Defined further down once DSP is read, so declared here.
  const ctr = pct1(clicks, impr), cpc = clicks > 0 ? spend / clicks : 0, cvr = pct1(convs, clicks);
  const organic = Math.max(gross - attr, 0), organicPct = pct1(organic, gross);
  const pOrganic = Math.max(pGross - pAttr, 0);

  // Amazon DSP (programmatic) — SEPARATE lens; conversions=purchases14d, conv_value=sales14d.
  const dSpend = Number(dsp.spend) || 0, dImpr = Number(dsp.impressions) || 0, dClicks = Number(dsp.clicks) || 0;
  const dPurch = Number(dsp.conversions) || 0, dSales = Number(dsp.conv_value) || 0;
  const dpSpend = Number(dspP.spend) || 0, dpSales = Number(dspP.conv_value) || 0;
  const dRoas = dSpend > 0 ? dSales / dSpend : 0, dpRoas = dpSpend > 0 ? dpSales / dpSpend : 0;
  const dCtr = pct1(dClicks, dImpr), dCpm = dImpr > 0 ? dSpend / dImpr * 1000 : 0;
  const dPurchRate = dImpr > 0 ? dPurch / dImpr * 100 : 0;
  const dspHasData = dSpend > 0 || dImpr > 0 || dSales > 0;
  // Total ad spend = Sponsored + DSP. This is what the e-commerce team means by "ad spend"
  // (sp + sb + sd + dsp); the Sponsored-only figure below is kept beside it because ROAS/ACOS
  // are computed on it.
  const totalSpend = spend + dSpend, pTotalSpend = pSpend + dpSpend;
  const tacos = gross > 0 ? (totalSpend / gross) * 100 : 0;
  const pTacos = pGross > 0 ? (pTotalSpend / pGross) * 100 : 0;

  // Settlement (true payout & fees) — sum the by_date rollup. Fees are negative; take/ad rates vs principal.
  const settle = useMemo(() => {
    const a = { principal: 0, promo: 0, tax: 0, advertising: 0, commission: 0, fba: 0, storage: 0, refund: 0, other: 0, fees: 0, net: 0, units: 0 };
    for (const r of (d?.settle?.by_date || [])) {
      a.principal += Number(r.principal) || 0; a.promo += Number(r.promo) || 0; a.tax += Number(r.tax_withheld) || 0;
      a.advertising += Number(r.fee_advertising) || 0; a.commission += Number(r.fee_commission) || 0; a.fba += Number(r.fee_fba) || 0;
      a.storage += Number(r.fee_storage) || 0; a.refund += Number(r.fee_refund) || 0; a.other += Number(r.fee_other) || 0;
      a.fees += Number(r.fees_total) || 0; a.net += Number(r.net_amount) || 0; a.units += Number(r.units) || 0;
    }
    a.takeRate = a.principal > 0 ? -a.fees / a.principal * 100 : 0;
    a.adRate = a.principal > 0 ? -a.advertising / a.principal * 100 : 0;
    a.netRate = a.principal > 0 ? a.net / a.principal * 100 : 0;
    return a;
  }, [d]);
  const settleRecon = d?.settle?.recon || [];
  const hasSettle = (d?.settle?.by_date || []).length > 0;

  // daily trend (gross/units) stacked by Amazon sub-channel (single band today = FBA)
  const trend = useMemo(() => {
    const g = {}, u = {};
    for (const r of (d?.salesVar || [])) {
      if (!r.sale_date) continue;
      const cid = r.channel_id;
      (g[r.sale_date] = g[r.sale_date] || {})[cid] = (g[r.sale_date][cid] || 0) + (Number(r.gross_value) || 0);
      (u[r.sale_date] = u[r.sale_date] || {})[cid] = (u[r.sale_date][cid] || 0) + (Number(r.units) || 0);
    }
    return { g, u, gDays: Object.keys(g).sort(), uDays: Object.keys(u).sort() };
  }, [d]);
  const trendGroups = (amzCh || []).map((c, i) => ({ key: c.channel_id, label: c.name, color: SUBCHANNEL_PALETTE[i % SUBCHANNEL_PALETTE.length] }));
  const tDays = trendMetric === 'units' ? trend.uDays : trend.gDays;
  const tVals = trendMetric === 'units' ? trend.u : trend.g;

  const geo = useMemo(() => {
    const arr = (d?.geo || []).map(r => ({ state: r.ship_state, units: Number(r.units) || 0, gross: Number(r.gross) || 0 }))
      .sort((a, b) => b.gross - a.gross).slice(0, 12);
    return { arr, max: Math.max(...arr.map(v => v.gross), 1) };
  }, [d]);

  const ready = amzCh !== null && d !== null;

  return (
    <div className="so-page">
      {/* Same PageHead as ChannelFamilyPage — this page hand-rolled its own header div, so it
          silently missed the h1 type scale, the swatch treatment and the sub-line every other
          family page shows. Amazon renders a bespoke component rather than the shared family
          page, which is exactly how the two drift. */}
      <PageHead
        title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 12 }}>
          <Swatch color={AMZ} size={13} glow style={{ borderRadius: 4 }} />{FAMILIES.amazon.label}
        </span>}
        sub={`${(amzCh || []).length} sub-channel${(amzCh || []).length === 1 ? '' : 's'} · vs prior period`}
      />
      {/* family scope tabs — identical strip to ChannelFamilyPage, and kept in the same position
          (ABOVE the RangePicker) so the two Channels surfaces agree. Amazon has its own bespoke
          page rather than the generic family page, so without this the route is a dead end: the
          rail's Channels item hard-routes to /channels/website and there is no other way back out. */}
      <div className="so-scopebar">
        {FAMILY_ORDER.map(k => (
          <ScopeTab key={k} on={k === 'amazon'} color={FAMILIES[k].color} label={FAMILIES[k].label}
            title={FAMILIES[k].label} onClick={() => { if (k !== 'amazon') router.push('/channels/' + k); }} />
        ))}
      </div>

      <RangePicker from={from} to={to} onChange={({ from, to }) => { setFrom(from); setTo(to); }} />

      {err && <div className="so-card" style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 12 }}>{err}</div>}
      {!ready ? <Spinner /> : (
        <>
          {/* ── Orders & sales value ── */}
          <div className="so-eyebrow" style={{ marginTop: 4 }}>Orders &amp; sales value</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12 }}>
            <Kpi hue={HUE.count} lbl="Total Orders" val={fmtInt(seg.totalOrders)} sub="incl. cancelled" now={seg.totalOrders} prev={segP.totalOrders} />
            {/* Both bases, deliberately. The e-commerce team works off the tax-INCLUSIVE figure
                (Akshay, 2026-07-31) while Odo reports ex-GST everywhere, and the two sitting ~15%
                apart with only one shown is what kept producing the "are we 17% out?" question.
                Presentation only — RULE-SALES-001 fixes the stored basis as tax-incl with GST
                captured separately, so do NOT change what is stored to make these agree. */}
            <Kpi hue={HUE.primary} lbl="Total Sales" val={inr(gross)}
                 sub={`gross incl-GST · ${inr(gross / (1 + GST_RATE))} ex-GST`}
                 now={gross} prev={pGross} />
            <Kpi hue={HUE.gross} lbl="Net Sales" val={inr(seg.netCancel)} sub="excl. cancellations" now={seg.netCancel} prev={segP.netCancel} />
            <Kpi hue={HUE.units} lbl="Net Revenue (ex-GST)" val={inr(seg.netExGst)} sub="after disc · returns · GST" now={seg.netExGst} prev={segP.netExGst} badge={<SettledBadge pct={seg.settledPct} />} />
            <Kpi hue={HUE.gross} lbl="Organic Sales" val={inr(organic)} sub={`${organicPct.toFixed(0)}% · not ad-attributed`} now={organic} prev={pOrganic} />
            <Kpi hue={HUE.derived} lbl="AOV" val={inr(seg.aov)} sub="gross / order · excl. cancelled" now={seg.aov} prev={segP.aov} />
            <Kpi hue={HUE.cancel} lbl="Cancellations" val={fmtInt(seg.cancelledOrders)} sub={`${seg.cancelRate.toFixed(1)}% · orders, not units`} now={seg.cancelledOrders} prev={segP.cancelledOrders} tone="neutral" />
            <Kpi hue={HUE.returns} lbl="Returns" val={fmtInt(seg.returnsCount)} sub={`${inr(seg.returnsValue)} refunded`} now={seg.returnsValue} prev={segP.returnsValue} tone="neutral" />
            <Kpi hue={HUE.returns} lbl="RTO" val={inr(ret.rto.value)} sub={`${fmtInt(ret.rto.units)}u · undelivered`} tone="neutral" />
            <Kpi hue={HUE.returns} lbl="RTV" val={fmtInt(ret.rtvReported.units || ret.rtv.units)} sub={ret.rtvReported.units ? `units returned · ${inr(ret.rtv.value)} refunded so far` : `${inr(ret.rtv.value)} · customer returns`} tone="neutral" />
            <Kpi hue={HUE.neutral} lbl="Total Discounts" val={inr(seg.discount)} sub="discount given" now={seg.discount} prev={segP.discount} tone="neutral" />
            {/* S273 — real now. Free replacements Amazon ships against an earlier order; every one is
                ₹0, so they never move revenue. They ARE counted in Total Orders and AOV above, on
                purpose: our AOV was tuned to Akshay's definition in S164 (June ₹1,958 vs his ₹1,953)
                and excluding ~8% of orders would break that reconciliation for no gain. */}
            <Kpi hue={HUE.neutral} lbl="Replacement" val={fmtInt(seg.repl)}
                 sub={seg.orders ? `${(seg.repl / seg.orders * 100).toFixed(1)}% of orders · ₹0 each` : 'free replacement orders'}
                 now={seg.repl} prev={segP.repl} tone="neutral" />
          </div>
          <div className="so-sub" style={{ fontSize: 10.5, color: 'var(--t3)', marginTop: -2 }}>
            Returns / RTO / RTV come from Amazon&apos;s Finances refund feed, which posts <b>weeks after</b> the sale — so a current-month figure understates and fills in as refunds settle. Older periods are the accurate read.
          </div>

          {/* ── Sponsored Ads (SP · SB · SD) — platform 'amazon', DSP excluded ── */}
          <div className="so-eyebrow" style={{ marginTop: 4 }}>Sponsored Ads <span style={{ color: 'var(--t3)', fontWeight: 400, fontSize: 11 }}>· SP · SB · SD</span></div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 12 }}>
            <Kpi hue={HUE.gross} lbl="Ad Spend" val={inr(totalSpend)} sub="SP + SB + SD + DSP" now={totalSpend} prev={pTotalSpend} tone="neutral" />
            <Kpi hue={HUE.neutral} lbl="Sponsored Spend" val={inr(spend)} sub="SP + SB + SD · basis for ROAS/ACOS" now={spend} prev={pSpend} tone="neutral" />
            <Kpi hue={HUE.primary} lbl="ROAS" val={roas.toFixed(2) + '×'} sub="attributed sales / spend" now={roas} prev={pRoas} />
            <Kpi hue={HUE.derived} lbl="ACOS" val={acos.toFixed(1) + '%'} sub="spend / attributed sales" now={acos} prev={pAcos} tone="neutral" />
            <Kpi hue={HUE.neutral} lbl="TACOS" val={tacos.toFixed(1) + '%'} sub="spend / total sales" now={tacos} prev={pTacos} tone="neutral" />
            <Kpi hue={HUE.count} lbl="CTR" val={ctr.toFixed(2) + '%'} sub="clicks / impressions" tone="neutral" />
            <Kpi hue={HUE.cancel} lbl="CPC" val={inr(cpc)} sub="spend / click" tone="neutral" />
            <Kpi hue={HUE.units} lbl="Conversion" val={cvr.toFixed(2) + '%'} sub="orders / click" tone="neutral" />
          </div>

          {/* ── Amazon DSP (programmatic) — SEPARATE lens, not summed into Sponsored Ads above ── */}
          <div className="so-eyebrow" style={{ marginTop: 4 }}>Amazon DSP <span style={{ color: 'var(--t3)', fontWeight: 400, fontSize: 11 }}>· programmatic display/video · separate lens</span></div>
          {dspHasData ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 12 }}>
              {/* DSP Spend keeps its bespoke violet — it is the separate-lens marker, not a metric hue. */}
              <Kpi lbl="DSP Spend" val={inr(dSpend)} now={dSpend} prev={dpSpend} tone="neutral" accent="#7C5CF0" />
              <Kpi hue={HUE.primary} lbl="DSP ROAS" val={dRoas.toFixed(2) + '×'} sub="sales (14d) / spend" now={dRoas} prev={dpRoas} />
              <Kpi hue={HUE.count} lbl="Impressions" val={fmtInt(dImpr)} tone="neutral" />
              <Kpi hue={HUE.derived} lbl="CTR" val={dCtr.toFixed(2) + '%'} sub="clicks / impressions" tone="neutral" />
              <Kpi hue={HUE.cancel} lbl="CPM" val={inr(dCpm)} sub="cost / 1000 impr" tone="neutral" />
              <Kpi hue={HUE.units} lbl="Purchases (14d)" val={fmtInt(dPurch)} sub={`${dPurchRate.toFixed(3)}% purch. rate`} tone="neutral" />
              <Kpi hue={HUE.gross} lbl="Sales (14d)" val={inr(dSales)} sub="DSP-attributed" tone="neutral" />
            </div>
          ) : (
            <div className="so-sub" style={{ fontSize: 11, color: 'var(--t3)' }}>No DSP spend in this range yet — the DSP connector backfills from 2026-04-16 forward (one report per day), so recent days fill in first.</div>
          )}
          <div className="so-sub" style={{ fontSize: 10.5, color: 'var(--t3)', marginTop: -2 }}>
            DSP (programmatic display/video) is reported <b>separately</b> from Sponsored Ads — the two attribute the same products, so their spend/ROAS must not be summed. Source: Amazon DSP reporting API.
          </div>

          {/* ── Daily trend ── */}
          <div className="so-card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <div className="so-eyebrow" style={{ margin: 0 }}>Daily {trendMetric === 'units' ? 'units' : 'gross'}</div>
              <SegmentedToggle options={['gross', 'units']} value={trendMetric} onChange={setTrendMetric} size="sm" />
            </div>
            <StackedTrendChart days={tDays} dayVals={tVals} metric={trendMetric} groups={trendGroups} />
          </div>

          {/* ── Returns: RTO vs RTV ── */}
          <div className="so-card">
            <div className="so-eyebrow" style={{ marginBottom: 12 }}>Returns — RTO vs RTV</div>
            {ret.total === 0 ? <div style={{ color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 12 }}>No returns in this range.</div> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                {[['rto', 'RTO · undelivered', 'var(--green)'], ['rtv', 'RTV · customer return', '#EC6A5E'], ['unknown', 'Unclassified (backfilling)', 'var(--t3)']].map(([key, label, color]) => {
                  const v = ret[key].value;
                  return (
                    <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ width: 200, fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t2)' }}>{label}</div>
                      <div style={{ flex: 1, height: 16, background: TRACK, borderRadius: 4, overflow: 'hidden' }}>
                        <div style={{ width: `${pct1(v, ret.total)}%`, height: '100%', background: color, opacity: 0.85 }} />
                      </div>
                      <div style={{ width: 150, textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t1)' }}>{inr(v)} · {pct1(v, ret.total).toFixed(0)}%</div>
                    </div>
                  );
                })}
                {ret.unknown.value > 0 && <div className="so-sub" style={{ fontSize: 10.5 }}>Unclassified returns reclassify to RTV as the FBA customer-returns report backfills.</div>}
              </div>
            )}
          </div>

          {/* ── Payout & fees (settlement → margin, net of marketplace cost) ── */}
          <div className="so-card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              <div className="so-eyebrow" style={{ margin: 0 }}>Payout &amp; fees · net of marketplace cost</div>
              <span className="so-sub" style={{ fontSize: 10.5 }}>from Amazon settlement reports · reconciles to deposits</span>
            </div>
            {!hasSettle ? (
              <div className="so-sub" style={{ color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 12 }}>
                No settlements in this range yet. Settlements post per disbursement (~14 days) and backfill over cron ticks — widen the date range or check back.
              </div>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12, marginBottom: 14 }}>
                  <Kpi lbl="Net payout" val={inr(settle.net)} sub={`${settle.netRate.toFixed(0)}% of revenue`} hue={HUE.units} />
                  <Kpi hue={HUE.primary} lbl="Revenue (ex-tax)" val={inr(settle.principal)} sub={`${fmtInt(settle.units)} units settled`} />
                  <Kpi lbl="Marketplace fees" val={inr(settle.fees)} sub={`${settle.takeRate.toFixed(1)}% take-rate`} tone="neutral" hue={HUE.returns} />
                  <Kpi lbl="Ad spend" val={inr(settle.advertising)} sub={`${settle.adRate.toFixed(1)}% of revenue · also in Marketing`} tone="neutral" accent="#E0903B" />
                  <Kpi hue={HUE.neutral} lbl="Tax (net)" val={inr(settle.tax)} sub="GST coll − TCS/TDS" tone="neutral" />
                </div>
                <div className="so-eyebrow" style={{ marginBottom: 8, fontSize: 11 }}>Where the revenue goes (% of revenue)</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                  {[
                    ['Commission & closing', settle.commission, 'var(--red)'],
                    ['FBA fulfilment', settle.fba, '#EC6A5E'],
                    ['Storage', settle.storage, '#C7584E'],
                    ['Refund fees', settle.refund, '#A8483F'],
                    ['Advertising', settle.advertising, '#E0903B'],
                    ['Promotions', settle.promo, '#B98BD9'],
                    ['Tax (net)', settle.tax, 'var(--t3)'],
                    ['Other', settle.other, 'var(--t3)'],
                  ].filter(([, v]) => Math.abs(v) >= 1).map(([label, v, color]) => {
                    const w = settle.principal > 0 ? Math.min(100, Math.abs(v) / settle.principal * 100) : 0;
                    return (
                      <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                        <div style={{ display: 'flex', alignItems: 'center', fontFamily: 'var(--mono)', fontSize: 11.5 }}>
                          <span className="so-dot" style={{ background: color, marginRight: 7 }} />
                          <span style={{ color: 'var(--t1)', flex: 1 }}>{label}</span>
                          <span style={{ color: 'var(--t3)', width: 46, textAlign: 'right' }}>{(Math.abs(v) / (settle.principal || 1) * 100).toFixed(1)}%</span>
                          <span style={{ color: v < 0 ? 'var(--red)' : 'var(--green-fg)', width: 96, textAlign: 'right' }}>{inr(v)}</span>
                        </div>
                        <div style={{ height: 6, background: TRACK, borderRadius: 4, overflow: 'hidden' }}>
                          <div style={{ width: `${w}%`, height: '100%', background: color }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
                {settleRecon.length > 0 && (
                  <div style={{ marginTop: 16 }}>
                    <div className="so-eyebrow" style={{ marginBottom: 8, fontSize: 11 }}>Settlement reconciliation</div>
                    <div style={{ overflowX: 'auto' }}>
                      <table className="so-table">
                        <thead><tr>
                          <th>Settlement</th><th>Deposit date</th><th className="so-num">Amazon deposit</th><th className="so-num">Our net</th><th className="so-num">Match</th>
                        </tr></thead>
                        <tbody>
                          {settleRecon.map(r => {
                            const ok = Math.abs(Number(r.diff)) < 1;
                            return (
                              <tr key={r.settlement_id}>
                                <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{r.settlement_id}</td>
                                <td>{r.deposit_date || '—'}</td>
                                <td className="so-num">{inr(Number(r.header_total))}</td>
                                <td className="so-num">{inr(Number(r.fact_net))}</td>
                                <td className="so-num" style={{ color: ok ? 'var(--green-fg)' : 'var(--red)' }}>{ok ? '✓' : inr(Number(r.diff))}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* ── Sales by state ── */}
          <div className="so-card">
            <div className="so-eyebrow" style={{ marginBottom: 12 }}>Sales by state</div>
            {geo.arr.length === 0 ? <div style={{ color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 12 }}>No location data in this range.</div> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {geo.arr.map(s => (
                  <div key={s.state} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 160, fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.state}</div>
                    <div style={{ flex: 1, height: 16, background: TRACK, borderRadius: 4, overflow: 'hidden' }}>
                      <div style={{ width: `${(s.gross / geo.max) * 100}%`, height: '100%', background: AMZ, opacity: 0.85 }} />
                    </div>
                    <div style={{ width: 130, textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t1)' }}>{inr(s.gross)} · {fmtInt(s.units)}u</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Traffic & conversion (S265) ── the Amazon analogue of the GA4 website funnel.
              Renders only once the connector has data for the range: it backfills one day per
              report, so an empty state here means "not walked back this far yet", NOT zero traffic.
              Saying so beats a row of honest-looking zeros. */}
          <div className="so-eyebrow" style={{ marginTop: 4 }}>Traffic &amp; conversion</div>
          {!traffic || !traffic.sessions ? (
            <div className="so-card so-sub" style={{ color: 'var(--t3)', fontSize: 12.5 }}>
              No Amazon traffic for this range yet — the Sales &amp; Traffic connector backfills one day per report, so recent ranges fill in first. It is not reporting zero sessions.
            </div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12 }}>
                <Kpi hue={HUE.count} lbl="Sessions" val={fmtInt(traffic.sessions)} sub="visits to the listing" />
                <Kpi hue={HUE.neutral} lbl="Page views" val={fmtInt(traffic.pageViews)} sub={traffic.sessions ? `${(traffic.pageViews / traffic.sessions).toFixed(2)} per session` : null} tone="neutral" />
                <Kpi hue={HUE.units} lbl="Unit-session %" val={`${traffic.usp.toFixed(2)}%`} sub="units ordered / sessions" />
                {traffic.buyBox == null ? null : <Kpi hue={HUE.derived} lbl="Buy Box %" val={`${traffic.buyBox.toFixed(1)}%`} sub="session-weighted" />}
                <Kpi hue={HUE.gross} lbl="Organic sessions" val={fmtInt(traffic.organic)} sub={`${traffic.sessions ? ((traffic.organic / traffic.sessions) * 100).toFixed(0) : 0}% · estimated`} />
                <Kpi hue={HUE.cancel} lbl="Inorganic sessions" val={fmtInt(traffic.inorganic)} sub="= ad clicks · estimated" tone="neutral" />
              </div>
              <div className="so-sub" style={{ fontSize: 11, color: 'var(--t3)', marginTop: -2, lineHeight: 1.55 }}>
                Organic / inorganic is an <b>estimate</b>: Amazon reports no traffic source, so inorganic uses Sponsored ad clicks as the proxy (the e-commerce team&apos;s own definition) and organic is the remainder, floored at zero. A click is not a session — treat the split as directional, and the total Sessions figure as the measured one.
                {traffic.adClicks > traffic.sessions ? <> <b style={{ color: 'var(--t2)' }}>In this range ad clicks ({fmtInt(traffic.adClicks)}) exceed sessions ({fmtInt(traffic.sessions)}), so the proxy has broken down and organic is pinned at 0 — read the split as unavailable, not as “no organic traffic”.</b></> : null}
              </div>
              {(d?.trafficDay || []).length > 1 && (
                <div className="so-card">
                  <div className="so-eyebrow" style={{ marginBottom: 10 }}>Sessions vs conversion by day</div>
                  {(() => {
                    const rows = (d.trafficDay || []).map(r => ({
                      date: r.grp, sessions: Number(r.sessions) || 0,
                      usp: Number(r.unit_session_pct) || 0,
                    }));
                    const maxS = Math.max(...rows.map(r => r.sessions), 1);
                    const maxC = Math.max(...rows.map(r => r.usp), 1);
                    return (
                      <div style={{ overflowX: 'auto' }}>
                        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 120, minWidth: Math.max(rows.length * 14, 200) }}>
                          {rows.map(r => (
                            <div key={r.date} title={`${r.date} · ${fmtInt(r.sessions)} sessions · ${r.usp.toFixed(2)}% conversion`}
                                 style={{ flex: '1 0 9px', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%', position: 'relative' }}>
                              <div style={{ height: `${(r.sessions / maxS) * 100}%`, background: 'rgba(45,168,240,.55)', borderRadius: '2px 2px 0 0' }} />
                              <div style={{ position: 'absolute', left: 0, right: 0, bottom: `${(r.usp / maxC) * 100}%`, height: 2, background: HUE.units, opacity: .95 }} />
                            </div>
                          ))}
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--t5)' }}>
                          <span>{rows[0]?.date}</span>
                          <span style={{ color: 'rgba(45,168,240,.9)' }}>▮ sessions</span>
                          <span style={{ color: HUE.units }}>▬ unit-session %</span>
                          <span>{rows[rows.length - 1]?.date}</span>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}
            </>
          )}

          {/* ── Top sellers (Model/SKU) ── */}
          <div className="so-card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <div className="so-eyebrow" style={{ margin: 0 }}>Top sellers</div>
              <SegmentedToggle options={[['product', 'Model'], ['variant', 'SKU']]} value={grp} onChange={setGrp} size="sm" />
            </div>
            {sellers.arr.length === 0 ? (
              <div style={{ color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 12 }}>No mapped sales in this range.</div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="so-table">
                  <thead><tr>
                    <SortHeader k="label" label={grp === 'product' ? 'Model' : 'SKU'} sort={sellerSort} />
                    <SortHeader k="units" label="Units" sort={sellerSort} numeric /><SortHeader k="gross" label="Gross" sort={sellerSort} numeric /><SortHeader k="asp" label="ASP" sort={sellerSort} numeric />
                    <SortHeader k="spend" label="Spend" sort={sellerSort} numeric /><SortHeader k="adSales" label="Ad Sales" sort={sellerSort} numeric />
                    <SortHeader k="roas" label="ROAS" sort={sellerSort} numeric /><SortHeader k="acos" label="ACOS" sort={sellerSort} numeric /><SortHeader k="tacos" label="TACOS" sort={sellerSort} numeric /><SortHeader k="organic" label="Organic%" sort={sellerSort} numeric />
                    {hasTraffic ? <><SortHeader k="sessions" label="Sessions" sort={sellerSort} numeric /><SortHeader k="cvr" label="CVR" sort={sellerSort} numeric /></> : null}
                    <SortHeader k="rto" label="RTO" sort={sellerSort} numeric /><SortHeader k="rtv" label="RTV" sort={sellerSort} numeric /><SortHeader k="retpct" label="Ret%" sort={sellerSort} numeric />
                  </tr></thead>
                  <tbody>
                    {sellerSort.sorted.map(v => {
                      const a = adByKey[v.code] || { spend: 0, adSales: 0 };
                      const sp = a.spend, ads = a.adSales, has = sp > 0;
                      const roas = has ? ads / sp : 0;
                      const acos = ads > 0 ? (sp / ads) * 100 : 0;
                      const tacos = v.gross > 0 ? (sp / v.gross) * 100 : 0;
                      const organicPct = v.gross > 0 ? ((v.gross - ads) / v.gross) * 100 : 0;
                      return (
                        <tr key={v.code}>
                          <td>{v.label}</td>
                          <td className="so-num">{fmtInt(v.units)}</td>
                          <td className="so-num">{inr(v.gross)}</td>
                          <td className="so-num">{inr(v.units ? v.gross / v.units : 0)}</td>
                          <td className="so-num">{has ? inr(sp) : '—'}</td>
                          <td className="so-num">{has ? inr(ads) : '—'}</td>
                          <td className="so-num">{has ? roas.toFixed(2) + '×' : '—'}</td>
                          <td className="so-num">{has ? acos.toFixed(1) + '%' : '—'}</td>
                          <td className="so-num">{has ? tacos.toFixed(1) + '%' : '—'}</td>
                          <td className="so-num">{has ? organicPct.toFixed(0) + '%' : '—'}</td>
                          {hasTraffic ? (() => {
                            const t = trafficByCode[v.code] || { sessions: 0, units: 0 };
                            return (<>
                              <td className="so-num">{t.sessions ? fmtInt(t.sessions) : '—'}</td>
                              <td className="so-num">{t.sessions ? ((t.units / t.sessions) * 100).toFixed(2) + '%' : '—'}</td>
                            </>);
                          })() : null}
                          {(() => {
                            const rr = retOf(v.code);
                            return (<>
                              <td className="so-num" title={rr.rtoValue ? `${inr(rr.rtoValue)} refunded` : undefined}>{rr.rtoUnits ? fmtInt(rr.rtoUnits) : '—'}</td>
                              <td className="so-num" title={rr.rtvValue ? `${inr(rr.rtvValue)} refunded so far` : undefined}>{rr.rtvShown ? fmtInt(rr.rtvShown) : '—'}</td>
                              <td className="so-num" title={rr.unknownUnits ? `incl. ${fmtInt(rr.unknownUnits)}u refunded but not yet classified rto/rtv` : undefined}>
                                {rr.totalReturned && v.units ? ((rr.totalReturned / v.units) * 100).toFixed(1) + '%' : '—'}
                              </td>
                            </>);
                          })()}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
