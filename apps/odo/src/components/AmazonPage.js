'use client';
// Amazon — the merged channel page (lives under Channels, replaces the generic family page for
// Amazon). Combines the rich Amazon cockpit (orders/sales value + Organic/RTO/RTV, ad metrics,
// returns split, sales-by-state, Model/SKU sellers) with the family page's daily trend. Built on
// the shared S169 kit. Order-type tiles (Replacements/Influencer/Repairs) are intentionally NOT
// shown — they're Shopify-tag-driven and always 0 for Amazon.
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { salesGet, inr, fmtInt, rangePresets, priorPeriod } from '../lib/api.js';
import { familyOf, SUBCHANNEL_PALETTE } from '../lib/families.js';
import { aggOrders } from '../lib/segregation.js';
import { Kpi, SettledBadge, RangePicker, SegmentedToggle, useTableSort, SortHeader } from './kit.js';
import StackedTrendChart from './StackedTrendChart.js';

const AMZ = '#4C63F0';
const pct1 = (n, d) => (d > 0 ? (n / d) * 100 : 0);

function aggReturns(rows) {
  const k = { rto: { orders: 0, units: 0, value: 0 }, rtv: { orders: 0, units: 0, value: 0 }, unknown: { orders: 0, units: 0, value: 0 } };
  for (const r of (rows || [])) {
    const t = k[r.return_kind] || k.unknown;
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
    if (!idsKey) { setD({ seg: [], segPrev: [], mkt: [], mktPrev: [], ret: [], geo: [], salesVar: [], adProd: [] }); return; }
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
    ]).then(([seg, segPrev, mkt, mktPrev, ret, geo, sv, adp]) => {
      setD({ seg: seg?.rows || [], segPrev: segPrev?.rows || [], mkt: mkt?.rows || [], mktPrev: mktPrev?.rows || [], ret: ret?.rows || [], geo: geo?.rows || [], salesVar: sv?.rows || [], adProd: adp?.rows || [] });
    }).catch(e => setErr(e.message || String(e)));
  }, [session, amzCh, idsKey, from, to]);

  const seg = useMemo(() => aggOrders(d?.seg), [d]);
  const segP = useMemo(() => aggOrders(d?.segPrev), [d]);
  const ad = useMemo(() => (d?.mkt || []).find(r => /amazon/i.test(r.grp || '')) || {}, [d]);
  const adP = useMemo(() => (d?.mktPrev || []).find(r => /amazon/i.test(r.grp || '')) || {}, [d]);
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
  const sellerSort = useTableSort(sellers.arr, { initialKey: 'gross', valueOf: (v, k) => {
    const a = adByKey[v.code] || { spend: 0, adSales: 0 };
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
  const tacos = gross > 0 ? (spend / gross) * 100 : 0, pTacos = pGross > 0 ? (pSpend / pGross) * 100 : 0;
  const ctr = pct1(clicks, impr), cpc = clicks > 0 ? spend / clicks : 0, cvr = pct1(convs, clicks);
  const organic = Math.max(gross - attr, 0), organicPct = pct1(organic, gross);
  const pOrganic = Math.max(pGross - pAttr, 0);

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
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ width: 11, height: 11, borderRadius: 3, background: AMZ }} />
        <span className="so-h2" style={{ fontSize: 18 }}>Amazon</span>
      </div>
      <RangePicker from={from} to={to} onChange={({ from, to }) => { setFrom(from); setTo(to); }} />

      {err && <div className="so-card" style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 12 }}>{err}</div>}
      {!ready ? <Spinner /> : (
        <>
          {/* ── Orders & sales value ── */}
          <div className="so-kpi-lbl" style={{ marginTop: 4 }}>Orders &amp; sales value</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12 }}>
            <Kpi lbl="Total Orders" val={fmtInt(seg.totalOrders)} sub="incl. cancelled" now={seg.totalOrders} prev={segP.totalOrders} />
            <Kpi lbl="Total Sales" val={inr(gross)} sub="gross (tax-incl)" now={gross} prev={pGross} />
            <Kpi lbl="Net Sales" val={inr(seg.netCancel)} sub="excl. cancellations" now={seg.netCancel} prev={segP.netCancel} />
            <Kpi lbl="Net Revenue (ex-GST)" val={inr(seg.netExGst)} sub="after disc · returns · GST" now={seg.netExGst} prev={segP.netExGst} badge={<SettledBadge pct={seg.settledPct} />} />
            <Kpi lbl="Organic Sales" val={inr(organic)} sub={`${organicPct.toFixed(0)}% · not ad-attributed`} now={organic} prev={pOrganic} />
            <Kpi lbl="AOV" val={inr(seg.aov)} sub="gross / order" now={seg.aov} prev={segP.aov} />
            <Kpi lbl="Cancellations" val={fmtInt(seg.cancelledOrders)} sub={`${seg.cancelRate.toFixed(1)}% · ${inr(seg.cancelledValue)}`} now={seg.cancelledOrders} prev={segP.cancelledOrders} tone="neutral" />
            <Kpi lbl="Returns" val={fmtInt(seg.returnsCount)} sub={`${inr(seg.returnsValue)} refunded`} now={seg.returnsValue} prev={segP.returnsValue} tone="neutral" />
            <Kpi lbl="RTO" val={inr(ret.rto.value)} sub={`${fmtInt(ret.rto.units)}u · undelivered`} tone="neutral" />
            <Kpi lbl="RTV" val={inr(ret.rtv.value)} sub={`${fmtInt(ret.rtv.units)}u · customer returns`} tone="neutral" />
            <Kpi lbl="Total Discounts" val={inr(seg.discount)} sub="discount given" now={seg.discount} prev={segP.discount} tone="neutral" />
            <Kpi lbl="Replacement" val="—" sub="from another Amazon report (later)" tone="neutral" />
          </div>

          {/* ── Advertising ── */}
          <div className="so-kpi-lbl" style={{ marginTop: 4 }}>Advertising</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 12 }}>
            <Kpi lbl="Ad Spend" val={inr(spend)} now={spend} prev={pSpend} tone="neutral" />
            <Kpi lbl="ROAS" val={roas.toFixed(2) + '×'} sub="attributed sales / spend" now={roas} prev={pRoas} />
            <Kpi lbl="ACOS" val={acos.toFixed(1) + '%'} sub="spend / attributed sales" now={acos} prev={pAcos} tone="neutral" />
            <Kpi lbl="TACOS" val={tacos.toFixed(1) + '%'} sub="spend / total sales" now={tacos} prev={pTacos} tone="neutral" />
            <Kpi lbl="CTR" val={ctr.toFixed(2) + '%'} sub="clicks / impressions" tone="neutral" />
            <Kpi lbl="CPC" val={inr(cpc)} sub="spend / click" tone="neutral" />
            <Kpi lbl="Conversion" val={cvr.toFixed(2) + '%'} sub="orders / click" tone="neutral" />
          </div>

          {/* ── Daily trend ── */}
          <div className="so-card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <div className="so-kpi-lbl" style={{ margin: 0 }}>Daily {trendMetric === 'units' ? 'units' : 'gross'}</div>
              <SegmentedToggle options={['gross', 'units']} value={trendMetric} onChange={setTrendMetric} size="sm" />
            </div>
            <StackedTrendChart days={tDays} dayVals={tVals} metric={trendMetric} groups={trendGroups} />
          </div>

          {/* ── Returns: RTO vs RTV ── */}
          <div className="so-card">
            <div className="so-kpi-lbl" style={{ marginBottom: 12 }}>Returns — RTO vs RTV</div>
            {ret.total === 0 ? <div style={{ color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 12 }}>No returns in this range.</div> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                {[['rto', 'RTO · undelivered', 'var(--green)'], ['rtv', 'RTV · customer return', '#EC6A5E'], ['unknown', 'Unclassified (backfilling)', 'var(--t3)']].map(([key, label, color]) => {
                  const v = ret[key].value;
                  return (
                    <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ width: 200, fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t2)' }}>{label}</div>
                      <div style={{ flex: 1, height: 16, background: 'var(--surface2)', borderRadius: 4, overflow: 'hidden' }}>
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

          {/* ── Sales by state ── */}
          <div className="so-card">
            <div className="so-kpi-lbl" style={{ marginBottom: 12 }}>Sales by state</div>
            {geo.arr.length === 0 ? <div style={{ color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 12 }}>No location data in this range.</div> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {geo.arr.map(s => (
                  <div key={s.state} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 160, fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.state}</div>
                    <div style={{ flex: 1, height: 16, background: 'var(--surface2)', borderRadius: 4, overflow: 'hidden' }}>
                      <div style={{ width: `${(s.gross / geo.max) * 100}%`, height: '100%', background: AMZ, opacity: 0.85 }} />
                    </div>
                    <div style={{ width: 130, textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t1)' }}>{inr(s.gross)} · {fmtInt(s.units)}u</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Top sellers (Model/SKU) ── */}
          <div className="so-card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <div className="so-kpi-lbl" style={{ margin: 0 }}>Top sellers</div>
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
