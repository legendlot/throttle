'use client';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { salesGet, inr, fmtInt, rangePresets, priorPeriod } from '../../../lib/api.js';
import { aggOrders } from '../../../lib/segregation.js';
import { Kpi, SettledBadge, RangePicker, SegmentedToggle, useTableSort, SortHeader } from '../../../components/kit.js';
import { familyOf, FAMILIES, SUBCHANNEL_PALETTE } from '../../../lib/families.js';
import StackedTrendChart from '../../../components/StackedTrendChart.js';

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
  const sort = useTableSort(chRows, { initialKey: 'grossAll' });

  return (
    <div className="so-page">
      <RangePicker from={from} to={to} onChange={({ from, to }) => { setFrom(from); setTo(to); }}
        right={<span className="so-sub">vs prior period · order-grain channels</span>} />

      {err && <div className="so-card" style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 12 }}>{err}</div>}
      {!a ? <div style={{ padding: 60, textAlign: 'center' }}><Spinner /></div> : (
        <>
          {/* Headline ladder + tiles */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: 12 }}>
            <Kpi lbl="Total Orders" val={fmtInt(a.totalOrders)} sub="placed (incl. cancelled)" now={a.totalOrders} prev={p.totalOrders} />
            <Kpi lbl="Total Sales" val={inr(a.grossAll)} sub="gross revenue" now={a.grossAll} prev={p.grossAll} />
            <Kpi lbl="Net Sales" val={inr(a.netCancel)} sub="excl. cancellations" now={a.netCancel} prev={p.netCancel} />
            <Kpi lbl="Net Revenue (ex-GST)" val={inr(a.netExGst)} sub="after disc · returns · GST" now={a.netExGst} prev={p.netExGst} badge={<SettledBadge pct={a.settledPct} />} />
            <Kpi lbl="AOV" val={inr(a.aov)} sub="gross / order" now={a.aov} prev={p.aov} />
            <Kpi lbl="Cancellations" val={`${fmtInt(a.cancelledOrders)} · ${a.cancelRate.toFixed(1)}%`} sub={inr(a.cancelledValue)} now={a.cancelledOrders} prev={p.cancelledOrders} tone="neutral" />
            <Kpi lbl="Returns" val={`${fmtInt(a.returnsCount)} · ${inr(a.returnsValue)}`} sub="refund value" now={a.returnsValue} prev={p.returnsValue} tone="neutral" />
            <Kpi lbl="Total Discounts" val={inr(a.discount)} sub="discount given" now={a.discount} prev={p.discount} tone="neutral" />
          </div>

          {/* trend */}
          <div className="so-card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 10 }}>
              <div className="so-kpi-lbl" style={{ margin: 0 }}>Daily {metric === 'net' ? 'net revenue (ex-GST)' : 'total sales'} by channel</div>
              <SegmentedToggle options={[['gross', 'Total Sales'], ['net', 'Net ex-GST']]} value={metric} onChange={setMetric} size="sm" />
            </div>
            <StackedTrendChart days={trend.days} dayVals={trend.dv} metric="gross" groups={trendGroups} />
          </div>

          {/* Order-type tiles (Shopify MO tags) */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: 12 }}>
            <Kpi lbl="Replacements" val={fmtInt(a.repl)} sub="replacement orders" now={a.repl} prev={p.repl} tone="neutral" />
            <Kpi lbl="Influencer Orders" val={fmtInt(a.infl)} sub="influencer / seeding" now={a.infl} prev={p.infl} tone="neutral" />
            <Kpi lbl="Repairs" val={fmtInt(a.repair)} sub="repair orders" now={a.repair} prev={p.repair} tone="neutral" />
          </div>

          {/* Per-channel breakdown */}
          <div className="so-card" style={{ padding: 0, overflow: 'hidden' }}>
            <div className="so-kpi-lbl" style={{ padding: '16px 18px 0' }}>By channel</div>
            <div style={{ overflowX: 'auto' }}>
              <table className="so-table" style={{ marginTop: 8 }}>
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
                      <td>{c.name}</td>
                      <td className="so-num">{fmtInt(c.totalOrders)}</td>
                      <td className="so-num">{inr(c.grossAll)}</td>
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
