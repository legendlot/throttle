'use client';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { salesGet, inr, fmtInt, rangePresets, priorPeriod } from '../../../lib/api.js';
import { Kpi, RangePicker, SegmentedToggle, useTableSort, SortHeader } from '../../../components/kit.js';
import { PageHead, PanelHead, Pill, Nil } from '../../../components/prism.js';
import { HUE, STATUS } from '../../../lib/hues.js';
import PerfTrendChart from '../../../components/PerfTrendChart.js';

const sumBy = (rows, k) => (rows || []).reduce((a, r) => a + Number(r[k] || 0), 0);
const grossOf = (rows) => (rows || []).reduce((a, r) => a + Number(r.gross_value ?? r.gross ?? 0), 0);
const roasOf = (r) => (Number(r.spend) > 0 ? Number(r.conv_value || 0) / Number(r.spend) : 0);
// Colour ROAS by the Ad Engine's gates: >=4 graduate (green), <2 kill (red), between = iterate.
const roasTone = (v) => (v >= 4 ? 'var(--green)' : v > 0 && v < 2 ? 'var(--red)' : 'var(--t1)');
const GROUP_LABEL = { platform: 'Platform', campaign: 'Campaign', adset: 'Ad set', ad: 'Ad' };
const PLAT_COLOR = { meta: '#4C63F0', google: '#E8A33D', amazon: '#FF9900', amazon_dsp: '#7C5CF0', ga4: '#E8643D' };
// Amazon Sponsored Ads (SP/SB/SD) = 'amazon'; Amazon DSP = 'amazon_dsp' — a distinct platform lens.
const PLAT_LABEL = { meta: 'Meta', google: 'Google', amazon: 'Amazon (Sponsored)', amazon_dsp: 'Amazon DSP', ga4: 'GA4' };
const platLabel = (p) => PLAT_LABEL[p] || p || '—';
// Platform chip — the Prism status pill in the platform's own colour. PLAT_LABEL casing is
// product vocabulary ("Amazon (Sponsored)"), so the pill's uppercase transform is switched off.
const PlatChip = ({ p }) => (
  <Pill color={PLAT_COLOR[p] || 'var(--t3)'} style={{ textTransform: 'none', whiteSpace: 'nowrap' }}>{platLabel(p)}</Pill>
);
// Live/Paused marker — green = ACTIVE, grey = paused/other. null (no status synced yet) → no dot.
const StatusDot = ({ live }) => live == null ? null : (
  <span title={live ? 'Live' : 'Paused'} style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
    marginRight: 7, verticalAlign: 'middle', background: live ? 'var(--green)' : 'var(--t3)' }} />
);
const microLbl = { fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t5)', whiteSpace: 'nowrap',
  display: 'inline-flex', alignItems: 'center', gap: 5 };

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

  // Hero sparklines read the SAME daily series the chart plots — nothing new is aggregated.
  // Clicks has no daily series on this page (the merge keeps spend + conversions only), so that
  // tile ships without one rather than inventing a rollup.
  const sparks = useMemo(() => ({
    spend: series.map(d => d.spend),
    revenue: series.map(d => d.revenue),
    roas: series.map(d => d.roas),
    conversions: series.map(d => d.conversions),
  }), [series]);

  return (
    <div className="so-page">
      <PageHead title="Marketing" sub="Spend, ROAS and attribution across ad platforms" />

      <RangePicker from={from} to={to} onChange={({ from, to }) => { setFrom(from); setTo(to); }} />

      {err && <div className="so-card" style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 12 }}>{err}</div>}
      {!rows ? <div style={{ padding: 60, textAlign: 'center' }}><Spinner /></div> : (
        <>
          {/* Hues are keyed to the trend chart directly below, which is spec-fixed: spend = blue,
              revenue = green, ROAS = the yellow right-axis line, conversions = violet. A tile whose
              colour contradicts the chart under it makes both unreadable, so the tiles follow it. */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 14 }}>
            <Kpi lbl="Ad spend" val={inr(spend)} now={spend} prev={pv.spend} tone="neutral" hue={HUE.gross} spark={sparks.spend} />
            <Kpi lbl="Sales gross" val={inr(salesGross)} sub="blended, all channels" now={salesGross} prev={pv.gross} hue={HUE.units} spark={sparks.revenue} />
            <Kpi lbl="Blended ROAS" val={roas.toFixed(2) + '×'} sub="gross / spend" now={roas} prev={prevRoas} hue={HUE.primary} spark={sparks.roas} />
            <Kpi lbl="Clicks" val={fmtInt(clicks)} now={clicks} prev={pv.clicks} tone="neutral" hue={HUE.count} />
            <Kpi lbl="Conversions" val={fmtInt(convs)} now={convs} prev={pv.convs} hue={HUE.derived} spark={sparks.conversions} />
          </div>

          <PerfTrendChart data={series} />
        </>
      )}

      {/* grouping — swaps the table's source (getMarketing ↔ getAdMetrics for ad set / ad).
          Deliberately OUTSIDE the loading guard: changing `group` sets rows=null, so a control
          rendered inside the guard would unmount the instant it's clicked and a misclick couldn't
          be corrected until a 7-call Promise.all resolved. It stays mounted while data loads. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <SegmentedToggle options={[['platform', 'By platform'], ['campaign', 'By campaign'], ['adset', 'By ad set'], ['ad', 'By ad']]} value={group} onChange={setGroup} />
      </div>

      {rows && (
        <>
          <div className="so-card flush" style={{ overflow: 'hidden' }}>
            <PanelHead
              style={{ marginBottom: 0 }}
              title={`${GROUP_LABEL[group]}s · spend & performance`}
              qual={adMode ? '· Meta, last ~14d · ROAS = Meta-attributed' : undefined}
              right={
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                  {group !== 'platform' && (
                    <span style={microLbl}>
                      <span className="so-dot" style={{ background: 'var(--green)' }} /> live
                      <span className="so-dot" style={{ background: 'var(--t3)', marginLeft: 6 }} /> paused
                    </span>
                  )}
                  <span style={microLbl}>
                    ROAS gates · <span style={{ color: STATUS.good }}>≥4 graduate</span> · <span style={{ color: STATUS.bad }}>&lt;2 kill</span>
                  </span>
                </div>
              } />
            <div style={{ overflowX: 'auto' }}>
              <table className="so-table">
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
                  {sort.sorted.map((r, i) => {
                    const rv = roasOf(r);
                    const name = (adMode ? r.label : (group === 'platform' ? platLabel(r.grp) : r.grp)) || '—';
                    return (<tr key={i}>
                      <td style={{ whiteSpace: 'nowrap' }}><StatusDot live={r.is_live} />{name === '—' ? <Nil /> : name}</td>
                      {group !== 'platform' && <td><PlatChip p={r.platform} /></td>}
                      <td className="so-num">{inr(r.spend)}</td>
                      <td className="so-num" style={{ color: roasTone(rv), fontWeight: 500 }}>{rv ? rv.toFixed(2) + '×' : <Nil />}</td>
                      <td className="so-num">{fmtInt(r.impressions)}</td>
                      <td className="so-num">{fmtInt(r.clicks)}</td>
                      <td className="so-num">{fmtInt(r.conversions)}</td>
                      <td className="so-num">{inr(r.conv_value)}</td>
                    </tr>);
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
