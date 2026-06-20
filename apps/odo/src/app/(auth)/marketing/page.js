'use client';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { salesGet, istToday, istDaysAgo } from '../../../lib/api.js';
import PerfTrendChart from '../../../components/PerfTrendChart.js';

const inr = n => '₹' + Math.round(Number(n || 0)).toLocaleString('en-IN');
const numfmt = n => Number(n || 0).toLocaleString('en-IN');

export default function MarketingPage() {
  const { session } = useAuth();
  const [from, setFrom] = useState(istDaysAgo(30));
  const [to, setTo] = useState(istToday());
  const [group, setGroup] = useState('platform');
  const [rows, setRows] = useState(null);        // marketing by platform/campaign (table)
  const [mktDaily, setMktDaily] = useState([]);   // marketing by day (chart)
  const [salesRows, setSalesRows] = useState([]); // sales by variant (revenue + total)
  const [trafDaily, setTrafDaily] = useState([]); // traffic by day (chart)
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!session) return;
    setRows(null); setErr('');
    Promise.all([
      salesGet('getMarketing', { from, to, group }, session),
      salesGet('getMarketing', { from, to, group: 'date' }, session),
      salesGet('getSales', { from, to, group: 'variant' }, session),
      salesGet('getTraffic', { from, to, group: 'date' }, session),
    ]).then(([mt, md, s, tr]) => {
      setRows(mt?.rows || []);
      setMktDaily(md?.rows || []);
      setSalesRows(s?.rows || []);
      setTrafDaily(tr?.rows || []);
    }).catch(e => setErr(e.message || String(e)));
  }, [session, from, to, group]);

  const spend = (rows || []).reduce((a, r) => a + Number(r.spend || 0), 0);
  const clicks = (rows || []).reduce((a, r) => a + Number(r.clicks || 0), 0);
  const convs = (rows || []).reduce((a, r) => a + Number(r.conversions || 0), 0);
  const salesGross = salesRows.reduce((a, r) => a + Number(r.gross_value ?? r.gross ?? 0), 0);
  const roas = spend > 0 ? salesGross / spend : 0;

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

  const KPIS = [
    { lbl: 'Ad spend', val: inr(spend) },
    { lbl: 'Sales gross', val: inr(salesGross) },
    { lbl: 'Blended ROAS', val: roas.toFixed(2) + '×' },
    { lbl: 'Clicks', val: numfmt(clicks) },
    { lbl: 'Conversions', val: numfmt(convs) },
  ];

  return (
    <div style={{ padding: 28, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <input className="so-input" type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} />
        <input className="so-input" type="date" value={to} min={from} max={istToday()} onChange={e => setTo(e.target.value)} />
        <button className={`so-chip${group === 'platform' ? ' active' : ''}`} onClick={() => setGroup('platform')}>By platform</button>
        <button className={`so-chip${group === 'campaign' ? ' active' : ''}`} onClick={() => setGroup('campaign')}>By campaign</button>
      </div>

      {err && <div className="so-card" style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 12 }}>{err}</div>}
      {!rows ? <Spinner /> : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12 }}>
            {KPIS.map((k, i) => (
              <div key={i} className="so-card" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div className="so-kpi-lbl">{k.lbl}</div>
                <span className="so-kpi-val">{k.val}</span>
              </div>
            ))}
          </div>

          <div>
            <div className="so-kpi-lbl" style={{ marginBottom: 10 }}>Performance Trends</div>
            <PerfTrendChart data={series} />
          </div>

          <div className="so-card">
            <div className="so-kpi-lbl">{group === 'campaign' ? 'Campaigns' : 'Platforms'} · spend & performance</div>
            <table className="so-table" style={{ marginTop: 10 }}>
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
                  <td className="so-num">{numfmt(r.impressions)}</td>
                  <td className="so-num">{numfmt(r.clicks)}</td>
                  <td className="so-num">{numfmt(r.conversions)}</td>
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
