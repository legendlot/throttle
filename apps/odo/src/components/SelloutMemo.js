'use client';
import { useEffect, useState } from 'react';
import { salesGet, inr, fmtInt } from '../lib/api.js';
import { Kpi } from './kit.js';
import { PanelHead, Nil } from './prism.js';

const PLAT = { national: 'National', minutes: 'Minutes', total: 'Total' };
const fmtD = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '—';
const n = v => v == null ? <Nil /> : fmtInt(v);
const r = v => v == null ? <Nil /> : inr(v);

// Secondary sell-out from the channel's daily report. Memo only — never part of revenue/P&L (Afshaan, S397).
// Rendered OUTSIDE the page's revenue-empty gate, so it shows even on a range with no PO revenue.
export default function SelloutMemo({ channelIds, from, to, session, meta }) {
  const [d, setD] = useState(null);
  const key = (channelIds || []).join(',');
  useEffect(() => {
    if (!session || !key) return;
    let live = true;
    const empty = { reports: [], daily: [], latest: null, coverage: { days: 0, reported: 0 } };
    salesGet('getSellout', { channel_id: key, from, to }, session)
      .then(x => { if (live) setD(x || empty); })
      .catch(() => { if (live) setD(empty); });
    return () => { live = false; };
  }, [session, key, from, to]);
  if (!d) return null;
  const reports = d.reports || [];
  const latest = reports.filter(x => x.report_date === d.latest?.report_date);
  const tot = latest.find(x => x.platform === 'total');
  const cov = d.coverage || { days: 0, reported: 0 };
  // Same pill shape as <SettledBadge> (kit.js) — mono 9px, --border-ctl, pill radius.
  const badge = <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', border: '1px solid var(--border-ctl)', borderRadius: 999, padding: '1px 6px', whiteSpace: 'nowrap' }}>memo · not revenue</span>;
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
        <Kpi dense hue="#2DA8F0" lbl="Sell-out"
          val={tot && tot.mtd_units != null ? `${fmtInt(tot.mtd_units)} u · ${tot.mtd_gmv == null ? '—' : inr(tot.mtd_gmv)}` : '—'}
          sub={<>{badge} {tot ? `${meta.label} · MTD · latest ${fmtD(d.latest.report_date)}` : `${meta.label} · no report in this range`}</>}
          now={tot?.d1_units} prev={tot?.d2_units} deltaNote="D-1 vs D-2 units" tone="neutral" />
        <Kpi dense hue="#2DA8F0" lbl="ATP on platform" val={tot && tot.atp_qty != null ? fmtInt(tot.atp_qty) : '—'} sub="current stock at Flipkart" tone="neutral" />
        <Kpi dense hue="#2DA8F0" lbl="Days reported" val={`${cov.reported} / ${cov.days}`} sub="days with a report · capped at yesterday · Fridays never covered (Mon–Fri emails report D-1 / D-2)" tone="neutral" />
      </div>
      <div className="so-card">
        <PanelHead title="Platform sell-out" qual={`${meta.source} · memo only`} />
        {!latest.length ? <div style={{ padding: 20, color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 12 }}>No Flipkart report in this range yet.</div> : (
          <table className="so-table"><thead><tr>
            <th>Platform</th><th className="so-num">ATP</th><th className="so-num">MTD units</th><th className="so-num">MTD GMV</th>
            <th className="so-num">{fmtD(tot?.d1_date)} units</th><th className="so-num">GMV</th><th className="so-num">{fmtD(tot?.d2_date)} units</th><th className="so-num">GMV</th>
          </tr></thead><tbody>
            {['national', 'minutes', 'total'].map(p => { const x = latest.find(y => y.platform === p); return x ? (
              <tr key={p} style={p === 'total' ? { fontWeight: 600 } : undefined}>
                <td>{PLAT[p]}</td><td className="so-num">{n(x.atp_qty)}</td><td className="so-num">{n(x.mtd_units)}</td><td className="so-num">{r(x.mtd_gmv)}</td>
                <td className="so-num">{n(x.d1_units)}</td><td className="so-num">{r(x.d1_gmv)}</td><td className="so-num">{n(x.d2_units)}</td><td className="so-num">{r(x.d2_gmv)}</td>
              </tr>) : null; })}
          </tbody></table>
        )}
      </div>
    </>
  );
}
