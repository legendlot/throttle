'use client';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { ArrowLeftRight, Sparkles, Wrench } from 'lucide-react';
import { salesGet, inr, fmtInt, rangePresets, priorPeriod } from '../../../lib/api.js';
import { aggOrders } from '../../../lib/segregation.js';
import { Kpi, Delta, SettledBadge, RangePicker, SegmentedToggle, useTableSort, SortHeader } from '../../../components/kit.js';
import { PageHead, PanelHead, Swatch } from '../../../components/prism.js';
import { HUE } from '../../../lib/hues.js';
import { familyOf, FAMILIES, SUBCHANNEL_PALETTE } from '../../../lib/families.js';
import StackedTrendChart from '../../../components/StackedTrendChart.js';

// Order-type tile (Shopify MO tags) — icon + mono label + Sora value + mono sub.
// Its own panel rather than a hue-tinted KPI: these are qualitative order flags, not
// ladder metrics, and the icon is what makes them scannable at a glance.
// Carries the same period-over-period <Delta> a Kpi tile does (tone="neutral" — these are
// volume flags, so up isn't inherently good); dropping it would lose vs-prior-period context.
function OrderTypeTile({ icon: Icon, color, lbl, val, sub, now, prev }) {
  return (
    <div className="so-card" style={{ borderRadius: 'var(--r-xl)', padding: '13px 15px', display: 'flex', alignItems: 'center', gap: 13 }}>
      <Icon size={22} strokeWidth={1.75} color={color} style={{ flex: 'none' }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="so-stat-lbl">{lbl}</span>
          <Delta now={now} prev={prev} tone="neutral" />
        </div>
        <div style={{ fontFamily: 'var(--cond)', fontSize: 19, fontWeight: 700, color: 'var(--t1)', marginTop: 3 }}>{val}</div>
      </div>
      <span className="so-otile-sub" style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t4)', whiteSpace: 'nowrap' }}>{sub}</span>
    </div>
  );
}

export default function PerformancePage() {
  const { session } = useAuth();
  const mtd = rangePresets().find(p => p.key === 'mtd');
  const [from, setFrom] = useState(mtd.from);
  const [to, setTo] = useState(mtd.to);
  const [metric, setMetric] = useState('gross');   // trend: gross (Total Sales) | net (ex-GST)
  const [data, setData] = useState(null);   // { rows, channels }
  const [prev, setPrev] = useState(null);    // prior-period agg
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!session) return;
    setData(null); setPrev(null); setErr('');
    const pp = priorPeriod(from, to);
    Promise.all([
      salesGet('getSegregation', { from, to }, session),
      salesGet('getSegregation', { from: pp.from, to: pp.to }, session),
    ]).then(([cur, prv]) => {
      setData({ rows: cur?.rows || [], channels: cur?.channels || [] });
      setPrev(aggOrders(prv?.rows || []));
    }).catch(e => setErr(e.message || String(e)));
  }, [session, from, to]);

  const a = data ? aggOrders(data.rows) : null;
  const p = prev || {};
  const chById = useMemo(() => Object.fromEntries((data?.channels || []).map(c => [c.id, c.name])), [data]);

  // per-channel rollup for the breakdown table
  const chRows = useMemo(() => {
    const byCh = {};
    for (const r of (data?.rows || [])) (byCh[r.channel_id] = byCh[r.channel_id] || []).push(r);
    return Object.entries(byCh).map(([id, rs]) => ({ id, name: chById[id] || id, ...aggOrders(rs) }))
      .sort((x, y) => y.grossAll - x.grossAll);
  }, [data, chById]);

  // daily trend, stacked by channel — Total Sales (gross) or Net Revenue ex-GST per day
  const trend = useMemo(() => {
    const byDayCh = {};
    for (const r of (data?.rows || [])) {
      const k = `${r.sale_date}|${r.channel_id}`;
      (byDayCh[k] = byDayCh[k] || []).push(r);
    }
    const dv = {};
    for (const [k, rs] of Object.entries(byDayCh)) {
      const [d, ch] = k.split('|'); const ag = aggOrders(rs);
      (dv[d] = dv[d] || {})[ch] = metric === 'net' ? ag.netExGst : ag.grossAll;
    }
    return { days: Object.keys(dv).sort(), dv };
  }, [data, metric]);

  const trendGroups = useMemo(() => chRows.map((c, i) => {
    const fam = FAMILIES[familyOf(c.name)];
    return { key: c.id, label: c.name, color: fam?.color || SUBCHANNEL_PALETTE[i % SUBCHANNEL_PALETTE.length] };
  }), [chRows]);
  // colour every channel reference in the table with the same family hue the chart uses
  const chColor = useMemo(() => Object.fromEntries(trendGroups.map(g => [g.key, g.color])), [trendGroups]);
  const sort = useTableSort(chRows, { initialKey: 'grossAll' });

  return (
    <div className="so-page" style={{ gap: 12 }}>
      <PageHead title="Performance" sub="Order-grain ladder · vs prior period · order-grain channels" />
      <RangePicker from={from} to={to} onChange={({ from, to }) => { setFrom(from); setTo(to); }} />

      {err && <div className="so-card" style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 12 }}>{err}</div>}
      {!a ? <div style={{ padding: 60, textAlign: 'center' }}><Spinner /></div> : (
        <>
          {/* Headline ladder — dense 8-up, two rows of four, one hue per metric */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
            <Kpi dense hue={HUE.count} lbl="Total Orders" val={fmtInt(a.totalOrders)} sub="incl. cancelled · excl. ₹0 replacements" now={a.totalOrders} prev={p.totalOrders} />
            <Kpi dense hue={HUE.primary} lbl="Total Sales" val={inr(a.grossAll)} sub="gross revenue" now={a.grossAll} prev={p.grossAll} />
            <Kpi dense hue={HUE.gross} lbl="Net Sales" val={inr(a.netCancel)} sub="excl. cancellations" now={a.netCancel} prev={p.netCancel} />
            <Kpi dense hue={HUE.units} lbl="Net Revenue (ex-GST)" val={inr(a.netExGst)} sub="after disc · returns · GST" now={a.netExGst} prev={p.netExGst} badge={<SettledBadge pct={a.settledPct} />} />
            <Kpi dense hue={HUE.derived} lbl="AOV" val={inr(a.aov)} sub="gross / order · excl. replacements" now={a.aov} prev={p.aov} />
            <Kpi dense hue={HUE.cancel} lbl="Cancellations" val={`${fmtInt(a.cancelledOrders)} · ${a.cancelRate.toFixed(1)}%`} sub={inr(a.cancelledValue)} now={a.cancelledOrders} prev={p.cancelledOrders} tone="neutral" />
            <Kpi dense hue={HUE.returns} lbl="Returns" val={`${fmtInt(a.returnsCount)} · ${inr(a.returnsValue)}`} sub="refund value" now={a.returnsValue} prev={p.returnsValue} tone="neutral" />
            <Kpi dense hue={HUE.neutral} lbl="Total Discounts" val={inr(a.discount)} sub="discount given" now={a.discount} prev={p.discount} tone="neutral" />
          </div>

          {/* trend — the chart itself ships unchanged (§7); only the panel around it is restyled.
              The chart sits in a plain wrapper so .so-card's backdrop-filter is never its DIRECT parent. */}
          <div className="so-card">
            <PanelHead
              title={`Daily ${metric === 'net' ? 'net revenue (ex-GST)' : 'total sales'} by channel`}
              right={<SegmentedToggle options={[['gross', 'Total Sales'], ['net', 'Net ex-GST']]} value={metric} onChange={setMetric} size="sm" />}
            />
            <div>
              <StackedTrendChart days={trend.days} dayVals={trend.dv} metric="gross" groups={trendGroups} />
            </div>
          </div>

          {/* Order-type tiles (Shopify MO tags) */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
            <OrderTypeTile icon={ArrowLeftRight} color="#A78BFA" lbl="Replacements" val={fmtInt(a.repl)} sub="replacement orders" now={a.repl} prev={p.repl} />
            <OrderTypeTile icon={Sparkles} color="#F2CD1A" lbl="Influencer Orders" val={fmtInt(a.infl)} sub="influencer / seeding" now={a.infl} prev={p.infl} />
            <OrderTypeTile icon={Wrench} color="#2DA8F0" lbl="Repairs" val={fmtInt(a.repair)} sub="repair orders" now={a.repair} prev={p.repair} />
          </div>

          {/* Per-channel breakdown — full-bleed table panel */}
          <div className="so-card flush" style={{ overflow: 'hidden' }}>
            <PanelHead title="By channel" style={{ marginBottom: 0 }} />
            <div style={{ overflowX: 'auto' }}>
              <table className="so-table">
                <thead><tr>
                  <SortHeader k="name" label="Channel" sort={sort} /><SortHeader k="totalOrders" label="Orders" sort={sort} numeric /><SortHeader k="grossAll" label="Gross" sort={sort} numeric />
                  <SortHeader k="netCancel" label="Net (excl. canc.)" sort={sort} numeric /><SortHeader k="discount" label="Discounts" sort={sort} numeric />
                  <SortHeader k="tax" label="GST" sort={sort} numeric /><SortHeader k="cancelledValue" label="Cancellations" sort={sort} numeric /><SortHeader k="returnsValue" label="Returns" sort={sort} numeric />
                </tr></thead>
                <tbody>
                  {sort.sorted.length === 0 && <tr><td colSpan={8} style={{ color: 'var(--t3)', padding: 14 }}>
                    No order-grain data in this range yet — Website (Shopify) backfills first; Amazon / GT-MT join as those connectors are extended.
                  </td></tr>}
                  {sort.sorted.map(c => (
                    <tr key={c.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                          <Swatch color={chColor[c.id] || FAMILIES.other.color} />{c.name}
                        </span>
                      </td>
                      <td className="so-num">{fmtInt(c.totalOrders)}</td>
                      <td className="so-num bright">{inr(c.grossAll)}</td>
                      <td className="so-num">{inr(c.netCancel)}</td>
                      <td className="so-num">{inr(c.discount)}</td>
                      <td className="so-num">{inr(c.tax)}</td>
                      <td className="so-num">{fmtInt(c.cancelledOrders)} · {inr(c.cancelledValue)}</td>
                      <td className="so-num">{fmtInt(c.returnsCount)} · {inr(c.returnsValue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
