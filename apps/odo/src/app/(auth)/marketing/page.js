'use client';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { salesGet, inr, fmtInt, rangePresets, priorPeriod } from '../../../lib/api.js';
import { Kpi, RangePicker, SegmentedToggle, useTableSort, SortHeader } from '../../../components/kit.js';
import PerfTrendChart from '../../../components/PerfTrendChart.js';

const sumBy = (rows, k) => (rows || []).reduce((a, r) => a + Number(r[k] || 0), 0);
const grossOf = (rows) => (rows || []).reduce((a, r) => a + Number(r.gross_value ?? r.gross ?? 0), 0);
const roasOf = (r) => (Number(r.spend) > 0 ? Number(r.conv_value || 0) / Number(r.spend) : 0);
// Colour ROAS by the Ad Engine's gates: >=4 graduate (green), <2 kill (red), between = iterate.
const roasTone = (v) => (v >= 4 ? 'var(--green)' : v > 0 && v < 2 ? 'var(--red)' : 'var(--t1)');
const GROUP_LABEL = { platform: 'Platform', campaign: 'Campaign', adset: 'Ad set', ad: 'Ad' };
const PLAT_COLOR = { meta: '#4C63F0', google: '#E8A33D', amazon: '#FF9900', ga4: '#E8643D' };
const PlatChip = ({ p }) => (
  <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, padding: '2px 7px', borderRadius: 5,
    background: (PLAT_COLOR[p] || 'var(--t3)') + '22', color: PLAT_COLOR[p] || 'var(--t2)',
    border: `1px solid ${(PLAT_COLOR[p] || 'var(--t3)')}44` }}>{p || '—'}</span>
);

export default function MarketingPage() {
  const { session } = useAuth();
  const mtd = rangePresets().find(p => p.key === 'mtd');
  const [from, setFrom] = useState(mtd.from);
  const [to, setTo] = useState(mtd.to);
  const [group, setGroup] = useState('platform');
  const [rows, setRows] = useState(null);        // table rows for the active grouping
  const sort = useTableSort(rows, { initialKey: 'spend', valueOf: (r, k) => k === 'roas' ? roasOf(r) : k === 'name' ? (r.label ?? r.grp ?? '') : r[k] });
  const [kpiRows, setKpiRows] = useState([]);     // always platform-level → stable KPIs across groupings
  const [mktDaily, setMktDaily] = useState([]);   // marketing by day (chart)
  const [salesRows, setSalesRows] = useState([]); // sales by variant (revenue + total)
  const [trafDaily, setTrafDaily] = useState([]); // traffic by day (chart)
  const [prevAgg, setPrevAgg] = useState(null);   // prior-period { spend, gross, clicks, convs }
  const [err, setErr] = useState('');

  // ad-set / ad come from the ad-level fact (getAdMetrics → f_mkt_ad_rollup, Meta only); platform /
  // campaign come from the all-platform marketing rollup. KPIs always use the all-platform set.
  const adMode = group === 'adset' || group === 'ad';

  useEffect(() => {
    if (!session) return;
    setRows(null); setErr('');
    const pp = priorPeriod(from, to);
    Promise.all([
      adMode ? salesGet('getAdMetrics', { from, to, group }, session)
             : salesGet('getMarketing', { from, to, group }, session),
      salesGet('getMarketing', { from, to, group: 'date' }, session),
      salesGet('getSales', { from, to, group: 'variant' }, session),
      salesGet('getTraffic', { from, to, group: 'date' }, session),
      salesGet('getMarketing', { from: pp.from, to: pp.to, group: 'platform' }, session),
      salesGet('getSales', { from: pp.from, to: pp.to, group: 'variant' }, session),
      salesGet('getMarketing', { from, to, group: 'platform' }, session), // KPI base (all-platform)
    ]).then(([tbl, md, s, tr, pm, ps, kp]) => {
      setRows(tbl?.rows || []);
      setMktDaily(md?.rows || []);
      setSalesRows(s?.rows || []);
      setTrafDaily(tr?.rows || []);
      setKpiRows(kp?.rows || []);
      setPrevAgg({
        spend: sumBy(pm?.rows, 'spend'), gross: grossOf(ps?.rows),
        clicks: sumBy(pm?.rows, 'clicks'), convs: sumBy(pm?.rows, 'conversions'),
      });
    }).catch(e => setErr(e.message || String(e)));
  }, [session, from, to, group, adMode]);

  const spend = sumBy(kpiRows, 'spend');
  const clicks = sumBy(kpiRows, 'clicks');
  const convs = sumBy(kpiRows, 'conversions');
  const salesGross = grossOf(salesRows);
  const roas = spend > 0 ? salesGross / spend : 0;
  const pv = prevAgg || {};
  const prevRoas = pv.spend > 0 ? pv.gross / pv.spend : 0;

  // Merge marketing-daily + sales-daily(summed by date) + traffic-daily → one series.
  const series = useMemo(() => {
    const day = {};
    const touch = d => (day[d] = day[d] || { date: d, spend: 0, revenue: 0, conversions: 0, sessions: 0, purchases: 0 });
    mktDaily.forEach(r => { const d = r.grp; if (!d) return; const x = touch(d); x.spend = Number(r.spend) || 0; x.conversions = Number(r.conversions) || 0; });
    salesRows.forEach(r => { const d = r.sale_date; if (!d) return; touch(d).revenue += Number(r.gross_value ?? r.gross ?? 0); });
    trafDaily.forEach(r => { const d = r.src_group; if (!d) return; const x = touch(d); x.sessions = Number(r.sessions) || 0; x.purchases = Number(r.purchases) || 0; });
    return Object.values(day).sort((a, b) => a.date.localeCompare(b.date)).map(d => ({
      ...d,
      roas: d.spend > 0 ? +(d.revenue / d.spend).toFixed(2) : 0,
      cac: d.conversions > 0 ? Math.round(d.spend / d.conversions) : 0,
    }));
  }, [mktDaily, salesRows, trafDaily]);

  return (
    <div className="so-page">
      <RangePicker from={from} to={to} onChange={({ from, to }) => { setFrom(from); setTo(to); }}
        right={<SegmentedToggle options={[['platform', 'By platform'], ['campaign', 'By campaign'], ['adset', 'By ad set'], ['ad', 'By ad']]} value={group} onChange={setGroup} size="sm" />} />

      {err && <div className="so-card" style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 12 }}>{err}</div>}
      {!rows ? <div style={{ padding: 60, textAlign: 'center' }}><Spinner /></div> : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(165px,1fr))', gap: 12 }}>
            <Kpi lbl="Ad spend" val={inr(spend)} now={spend} prev={pv.spend} tone="neutral" />
            <Kpi lbl="Sales gross" val={inr(salesGross)} sub="blended, all channels" now={salesGross} prev={pv.gross} />
            <Kpi lbl="Blended ROAS" val={roas.toFixed(2) + '×'} sub="gross / spend" now={roas} prev={prevRoas} />
            <Kpi lbl="Clicks" val={fmtInt(clicks)} now={clicks} prev={pv.clicks} tone="neutral" />
            <Kpi lbl="Conversions" val={fmtInt(convs)} now={convs} prev={pv.convs} />
          </div>

          <PerfTrendChart data={series} />

          <div className="so-card" style={{ padding: 0, overflow: 'hidden' }}>
            <div className="so-kpi-lbl" style={{ padding: '16px 18px 0' }}>
              {GROUP_LABEL[group]}s · spend & performance
              {adMode && <span style={{ color: 'var(--t3)', fontWeight: 400 }}> · Meta, last ~14d · ROAS = Meta-attributed</span>}
            </div>
            <table className="so-table" style={{ marginTop: 8 }}>
              <thead><tr>
                <SortHeader k="name" label={GROUP_LABEL[group]} sort={sort} />
                {group !== 'platform' && <SortHeader k="platform" label="Platform" sort={sort} />}
                <SortHeader k="spend" label="Spend" sort={sort} numeric />
                <SortHeader k="roas" label="ROAS" sort={sort} numeric />
                <SortHeader k="impressions" label="Impressions" sort={sort} numeric />
                <SortHeader k="clicks" label="Clicks" sort={sort} numeric />
                <SortHeader k="conversions" label="Conversions" sort={sort} numeric />
                <SortHeader k="conv_value" label="Conv. value" sort={sort} numeric />
              </tr></thead>
              <tbody>
                {sort.sorted.length === 0 && <tr><td colSpan={group === 'platform' ? 7 : 8} style={{ color: 'var(--t3)', padding: 14 }}>{adMode ? 'No ad-level data yet — the engine pulls the last ~14 days on the next Meta refresh.' : 'No spend in this range yet — connector may still be backfilling.'}</td></tr>}
                {sort.sorted.map((r, i) => { const rv = roasOf(r); return (<tr key={i}>
                  <td>{(adMode ? r.label : r.grp) || '—'}</td>
                  {group !== 'platform' && <td><PlatChip p={r.platform} /></td>}
                  <td className="so-num">{inr(r.spend)}</td>
                  <td className="so-num" style={{ color: roasTone(rv), fontWeight: 500 }}>{rv ? rv.toFixed(2) + '×' : '—'}</td>
                  <td className="so-num">{fmtInt(r.impressions)}</td>
                  <td className="so-num">{fmtInt(r.clicks)}</td>
                  <td className="so-num">{fmtInt(r.conversions)}</td>
                  <td className="so-num">{inr(r.conv_value)}</td>
                </tr>); })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
