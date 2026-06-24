'use client';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { salesGet, inr, fmtInt, rangePresets, priorPeriod } from '../../../lib/api.js';
import { Kpi, RangePicker, SegmentedToggle } from '../../../components/kit.js';
import PerfTrendChart from '../../../components/PerfTrendChart.js';

const sumBy = (rows, k) => (rows || []).reduce((a, r) => a + Number(r[k] || 0), 0);
const grossOf = (rows) => (rows || []).reduce((a, r) => a + Number(r.gross_value ?? r.gross ?? 0), 0);

export default function MarketingPage() {
  const { session } = useAuth();
  const d30 = rangePresets().find(p => p.key === '30d');
  const [from, setFrom] = useState(d30.from);
  const [to, setTo] = useState(d30.to);
  const [group, setGroup] = useState('platform');
  const [rows, setRows] = useState(null);        // marketing by platform/campaign (table)
  const [mktDaily, setMktDaily] = useState([]);   // marketing by day (chart)
  const [salesRows, setSalesRows] = useState([]); // sales by variant (revenue + total)
  const [trafDaily, setTrafDaily] = useState([]); // traffic by day (chart)
  const [prevAgg, setPrevAgg] = useState(null);   // prior-period { spend, gross, clicks, convs }
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!session) return;
    setRows(null); setErr('');
    const pp = priorPeriod(from, to);
    Promise.all([
      salesGet('getMarketing', { from, to, group }, session),
      salesGet('getMarketing', { from, to, group: 'date' }, session),
      salesGet('getSales', { from, to, group: 'variant' }, session),
      salesGet('getTraffic', { from, to, group: 'date' }, session),
      salesGet('getMarketing', { from: pp.from, to: pp.to, group: 'platform' }, session),
      salesGet('getSales', { from: pp.from, to: pp.to, group: 'variant' }, session),
    ]).then(([mt, md, s, tr, pm, ps]) => {
      setRows(mt?.rows || []);
      setMktDaily(md?.rows || []);
      setSalesRows(s?.rows || []);
      setTrafDaily(tr?.rows || []);
      setPrevAgg({
        spend: sumBy(pm?.rows, 'spend'), gross: grossOf(ps?.rows),
        clicks: sumBy(pm?.rows, 'clicks'), convs: sumBy(pm?.rows, 'conversions'),
      });
    }).catch(e => setErr(e.message || String(e)));
  }, [session, from, to, group]);

  const spend = sumBy(rows, 'spend');
  const clicks = sumBy(rows, 'clicks');
  const convs = sumBy(rows, 'conversions');
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
        right={<SegmentedToggle options={[['platform', 'By platform'], ['campaign', 'By campaign']]} value={group} onChange={setGroup} size="sm" />} />

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
            <div className="so-kpi-lbl" style={{ padding: '16px 18px 0' }}>{group === 'campaign' ? 'Campaigns' : 'Platforms'} · spend & performance</div>
            <table className="so-table" style={{ marginTop: 8 }}>
              <thead><tr>
                <th>{group === 'campaign' ? 'Campaign' : 'Platform'}</th>
                <th className="so-num">Spend</th><th className="so-num">Impressions</th>
                <th className="so-num">Clicks</th><th className="so-num">Conversions</th><th className="so-num">Conv. value</th>
              </tr></thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={6} style={{ color: 'var(--t3)', padding: 14 }}>No spend in this range yet — connector may still be backfilling.</td></tr>}
                {rows.map((r, i) => (<tr key={i}>
                  <td>{r.grp || '—'}</td>
                  <td className="so-num">{inr(r.spend)}</td>
                  <td className="so-num">{fmtInt(r.impressions)}</td>
                  <td className="so-num">{fmtInt(r.clicks)}</td>
                  <td className="so-num">{fmtInt(r.conversions)}</td>
                  <td className="so-num">{inr(r.conv_value)}</td>
                </tr>))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
