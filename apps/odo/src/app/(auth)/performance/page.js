'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { salesGet, inr, fmtInt, rangePresets, priorPeriod, istToday } from '../../../lib/api.js';
import { aggOrders } from '../../../lib/segregation.js';
import { Delta, Kpi } from '../../../components/kit.js';

export default function PerformancePage() {
  const { session } = useAuth();
  const presets = rangePresets();
  const mtd = presets.find(p => p.key === 'mtd');
  const [from, setFrom] = useState(mtd.from);
  const [to, setTo] = useState(mtd.to);
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
  const chById = {}; (data?.channels || []).forEach(c => { chById[c.id] = c.name; });

  // per-channel rollup for the breakdown table
  const byCh = {};
  for (const r of (data?.rows || [])) {
    const k = r.channel_id; (byCh[k] = byCh[k] || []).push(r);
  }
  const chRows = Object.entries(byCh).map(([id, rs]) => ({ id, name: chById[id] || id, ...aggOrders(rs) }))
    .sort((x, y) => y.grossAll - x.grossAll);

  return (
    <div style={{ padding: 28, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {presets.map(pr => (
          <button key={pr.key}
            className={`so-btn${(pr.from === from && pr.to === to) ? '' : ' ghost'}`}
            onClick={() => { setFrom(pr.from); setTo(pr.to); }} style={{ padding: '5px 12px', fontSize: 12 }}>
            {pr.label}
          </button>
        ))}
        <span style={{ width: 1, height: 22, background: 'var(--border)', margin: '0 4px' }} />
        <input className="so-input" type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} />
        <input className="so-input" type="date" value={to} min={from} max={istToday()} onChange={e => setTo(e.target.value)} />
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', marginLeft: 'auto' }}>vs prior period · order-grain channels</span>
      </div>

      {err && <div className="so-card" style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 12 }}>{err}</div>}
      {!a ? <Spinner /> : (
        <>
          {/* Headline ladder + tiles */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12 }}>
            <Kpi lbl="Total Orders" val={fmtInt(a.totalOrders)} sub="placed (incl. cancelled)" now={a.totalOrders} prev={p.totalOrders} />
            <Kpi lbl="Total Sales" val={inr(a.grossAll)} sub="gross revenue" now={a.grossAll} prev={p.grossAll} />
            <Kpi lbl="Net Sales" val={inr(a.netCancel)} sub="excl. cancellations" now={a.netCancel} prev={p.netCancel} />
            <Kpi lbl="Net Revenue (ex-GST)" val={inr(a.netExGst)} sub="after disc · returns · GST" now={a.netExGst} prev={p.netExGst} />
            <Kpi lbl="AOV" val={inr(a.aov)} sub="gross / order" now={a.aov} prev={p.aov} />
            <Kpi lbl="Cancellations" val={`${fmtInt(a.cancelledOrders)} · ${a.cancelRate.toFixed(1)}%`} sub={inr(a.cancelledValue)} now={a.cancelledOrders} prev={p.cancelledOrders} tone="neutral" />
            <Kpi lbl="Returns" val={`${fmtInt(a.returnsCount)} · ${inr(a.returnsValue)}`} sub="refund value" now={a.returnsValue} prev={p.returnsValue} tone="neutral" />
            <Kpi lbl="Total Discounts" val={inr(a.discount)} sub="discount given" now={a.discount} prev={p.discount} tone="neutral" />
          </div>

          {/* Order-type tiles (Shopify MO tags) */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12 }}>
            <Kpi lbl="Replacements" val={fmtInt(a.repl)} sub="mo_replacement" now={a.repl} prev={p.repl} tone="neutral" />
            <Kpi lbl="Influencer Orders" val={fmtInt(a.infl)} sub="mo_influencer" now={a.infl} prev={p.infl} tone="neutral" />
            <Kpi lbl="Repairs" val={fmtInt(a.repair)} sub="mo_repair" now={a.repair} prev={p.repair} tone="neutral" />
          </div>

          {/* Per-channel breakdown */}
          <div className="so-card">
            <div className="so-kpi-lbl">By channel</div>
            <div style={{ overflowX: 'auto' }}>
              <table className="so-table" style={{ marginTop: 10 }}>
                <thead><tr>
                  <th>Channel</th><th className="so-num">Orders</th><th className="so-num">Gross</th>
                  <th className="so-num">Net (excl. canc.)</th><th className="so-num">Discounts</th>
                  <th className="so-num">GST</th><th className="so-num">Cancellations</th><th className="so-num">Returns</th>
                </tr></thead>
                <tbody>
                  {chRows.length === 0 && <tr><td colSpan={8} style={{ color: 'var(--t3)', padding: 14 }}>
                    No order-grain data in this range yet — Website (Shopify) backfills first; Amazon / GT-MT join as those connectors are extended.
                  </td></tr>}
                  {chRows.map(c => (
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
