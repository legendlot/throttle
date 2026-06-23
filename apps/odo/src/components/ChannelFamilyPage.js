'use client';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { salesGet, inr, fmtInt, rangePresets, priorPeriod, istToday } from '../lib/api.js';
import { FAMILIES, familyOf, SUBCHANNEL_PALETTE } from '../lib/families.js';
import { aggOrders } from '../lib/segregation.js';
import { Kpi } from './kit.js';
import StackedTrendChart from './StackedTrendChart.js';

// gross/units totals + per-channel + per-variant from f_sales_rollup (group=variant) rows.
function aggSales(rows) {
  let units = 0, gross = 0; const ch = {}, variant = {}, day = {};
  for (const r of (rows || [])) {
    const u = Number(r.units) || 0, g = Number(r.gross_value) || 0;
    units += u; gross += g;
    (ch[r.channel_id] = ch[r.channel_id] || { units: 0, gross: 0 }); ch[r.channel_id].units += u; ch[r.channel_id].gross += g;
    (variant[r.product_code] = variant[r.product_code] || { units: 0, gross: 0, label: r.grp_label || r.product_code }); variant[r.product_code].units += u; variant[r.product_code].gross += g;
    if (r.sale_date) { (day[r.sale_date] = day[r.sale_date] || {}); day[r.sale_date][r.channel_id] = (day[r.sale_date][r.channel_id] || 0) + g; }
  }
  return { units, gross, ch, variant, day };
}
// per-channel order-grain ladder.
function segByChannel(rows) {
  const by = {};
  for (const r of (rows || [])) (by[r.channel_id] = by[r.channel_id] || []).push(r);
  const out = {};
  for (const [id, rs] of Object.entries(by)) out[id] = aggOrders(rs);
  return out;
}

export default function ChannelFamilyPage({ familyKey }) {
  const { session } = useAuth();
  const fam = FAMILIES[familyKey];
  const presets = rangePresets();
  const mtd = presets.find(p => p.key === 'mtd');
  const [from, setFrom] = useState(mtd.from);
  const [to, setTo] = useState(mtd.to);
  const [metric, setMetric] = useState('gross');     // trend gross|units
  const [channels, setChannels] = useState(null);    // [{channel_id,name}]
  const [data, setData] = useState(null);            // { seg, sales }
  const [prev, setPrev] = useState(null);            // { seg, sales }
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!session) return;
    salesGet('getBootstrap', {}, session)
      .then(b => setChannels((b?.channels || []).map(c => ({ channel_id: c.channel_id || c.id, name: c.name }))))
      .catch(() => setChannels([]));
  }, [session]);

  // channels in this family
  const famChannels = useMemo(() => (channels || []).filter(c => familyOf(c.name) === familyKey), [channels, familyKey]);
  const famIds = useMemo(() => famChannels.map(c => c.channel_id), [famChannels]);
  const chName = useMemo(() => Object.fromEntries(famChannels.map(c => [c.channel_id, c.name])), [famChannels]);
  const idsKey = famIds.join(',');

  useEffect(() => {
    if (!session || channels === null) return;
    setData(null); setPrev(null); setErr('');
    if (!famIds.length) { setData({ seg: [], sales: [] }); setPrev({ seg: [], sales: [] }); return; }
    const pp = priorPeriod(from, to);
    Promise.all([
      salesGet('getSegregation', { from, to, channel_id: idsKey }, session),
      salesGet('getSales', { from, to, group: 'variant', channel_id: idsKey }, session),
      salesGet('getSegregation', { from: pp.from, to: pp.to, channel_id: idsKey }, session),
      salesGet('getSales', { from: pp.from, to: pp.to, group: 'variant', channel_id: idsKey }, session),
    ]).then(([sc, slc, sp, slp]) => {
      setData({ seg: sc?.rows || [], sales: slc?.rows || [] });
      setPrev({ seg: sp?.rows || [], sales: slp?.rows || [] });
    }).catch(e => setErr(e.message || String(e)));
  }, [session, channels, idsKey, from, to]);

  const ready = channels !== null && data !== null;
  const segA = useMemo(() => aggOrders(data?.seg), [data]);
  const segP = useMemo(() => aggOrders(prev?.seg), [prev]);
  const salesA = useMemo(() => aggSales(data?.sales), [data]);
  const salesP = useMemo(() => aggSales(prev?.sales), [prev]);
  const segCh = useMemo(() => segByChannel(data?.seg), [data]);
  const hasOrderGrain = (data?.seg || []).length > 0;
  const hasAnyData = hasOrderGrain || salesA.gross > 0 || salesA.units > 0;

  // sub-channel rows (only those with data), sorted by gross desc
  const chRows = useMemo(() => famChannels.map(c => {
    const s = salesA.ch[c.channel_id] || { gross: 0, units: 0 };
    const o = segCh[c.channel_id] || null;
    return { id: c.channel_id, name: c.name, gross: s.gross, units: s.units, o };
  }).filter(r => r.gross > 0 || r.units > 0 || r.o).sort((a, b) => b.gross - a.gross), [famChannels, salesA, segCh]);

  // top variants within the family
  const topVar = useMemo(() => {
    const arr = Object.entries(salesA.variant).map(([code, v]) => ({ code, ...v }))
      .sort((a, b) => (metric === 'units' ? b.units - a.units : b.gross - a.gross)).slice(0, 12);
    const max = Math.max(...arr.map(v => metric === 'units' ? v.units : v.gross), 1);
    return { arr, max };
  }, [salesA, metric]);

  // trend (stacked by sub-channel)
  const trend = useMemo(() => {
    const days = Object.keys(salesA.day).sort();
    return { days, dv: salesA.day };
  }, [salesA]);
  const trendGroups = famChannels.map((c, i) => ({ key: c.channel_id, label: c.name, color: SUBCHANNEL_PALETTE[i % SUBCHANNEL_PALETTE.length] }));
  // StackedTrendChart sums values; for units we need a units day-map too:
  const trendUnits = useMemo(() => {
    const day = {};
    for (const r of (data?.sales || [])) {
      if (!r.sale_date) continue;
      (day[r.sale_date] = day[r.sale_date] || {});
      day[r.sale_date][r.channel_id] = (day[r.sale_date][r.channel_id] || 0) + (Number(r.units) || 0);
    }
    return { days: Object.keys(day).sort(), dv: day };
  }, [data]);
  const shownTrend = metric === 'units' ? trendUnits : trend;

  const fmt = metric === 'units' ? fmtInt : inr;

  return (
    <div style={{ padding: 28, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* header: title + range */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ width: 10, height: 10, borderRadius: 3, background: fam.color }} />
        <span style={{ fontFamily: 'var(--cond)', fontWeight: 700, fontSize: 18, letterSpacing: '0.03em', color: 'var(--t1)' }}>{fam.label}</span>
        <div style={{ flex: 1 }} />
        {presets.map(pr => (
          <button key={pr.key}
            className={`so-btn${(pr.from === from && pr.to === to) ? '' : ' ghost'}`}
            onClick={() => { setFrom(pr.from); setTo(pr.to); }} style={{ padding: '5px 12px', fontSize: 12 }}>
            {pr.label}
          </button>
        ))}
        <input className="so-input" type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} />
        <input className="so-input" type="date" value={to} min={from} max={istToday()} onChange={e => setTo(e.target.value)} />
      </div>

      {err && <div className="so-card" style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 12 }}>{err}</div>}
      {!ready ? <Spinner /> : !hasAnyData ? (
        <div className="so-card" style={{ padding: 40, textAlign: 'center', color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 12.5 }}>
          {fam.emptyReason}
          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--t3)' }}>
            Channels: {famChannels.length ? famChannels.map(c => c.name).join(' · ') : '—'}
          </div>
        </div>
      ) : (
        <>
          {/* combined header KPIs */}
          {hasOrderGrain ? (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12 }}>
                <Kpi lbl="Total Orders" val={fmtInt(segA.totalOrders)} sub="placed (incl. cancelled)" now={segA.totalOrders} prev={segP.totalOrders} />
                <Kpi lbl="Total Sales" val={inr(segA.grossAll)} sub="gross revenue" now={segA.grossAll} prev={segP.grossAll} />
                <Kpi lbl="Net Sales" val={inr(segA.netCancel)} sub="excl. cancellations" now={segA.netCancel} prev={segP.netCancel} />
                <Kpi lbl="Net Revenue (ex-GST)" val={inr(segA.netExGst)} sub="after disc · returns · GST" now={segA.netExGst} prev={segP.netExGst} />
                <Kpi lbl="AOV" val={inr(segA.aov)} sub="gross / order" now={segA.aov} prev={segP.aov} />
                <Kpi lbl="Cancellations" val={`${fmtInt(segA.cancelledOrders)} · ${segA.cancelRate.toFixed(1)}%`} sub={inr(segA.cancelledValue)} now={segA.cancelledOrders} prev={segP.cancelledOrders} tone="neutral" />
                <Kpi lbl="Returns" val={`${fmtInt(segA.returnsCount)} · ${inr(segA.returnsValue)}`} sub="refund value" now={segA.returnsValue} prev={segP.returnsValue} tone="neutral" />
                <Kpi lbl="Total Discounts" val={inr(segA.discount)} sub="discount given" now={segA.discount} prev={segP.discount} tone="neutral" />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12 }}>
                <Kpi lbl="Replacements" val={fmtInt(segA.repl)} sub="mo_replacement" now={segA.repl} prev={segP.repl} tone="neutral" />
                <Kpi lbl="Influencer Orders" val={fmtInt(segA.infl)} sub="mo_influencer" now={segA.infl} prev={segP.infl} tone="neutral" />
                <Kpi lbl="Repairs" val={fmtInt(segA.repair)} sub="mo_repair" now={segA.repair} prev={segP.repair} tone="neutral" />
              </div>
            </>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: 12 }}>
                <Kpi lbl="Gross sales" val={inr(salesA.gross)} sub="sell-out (pre-GST n/a yet)" now={salesA.gross} prev={salesP.gross} />
                <Kpi lbl="Units sold" val={fmtInt(salesA.units)} now={salesA.units} prev={salesP.units} />
                <Kpi lbl="Avg selling price" val={inr(salesA.units ? salesA.gross / salesA.units : 0)} sub="gross / unit" now={salesA.units ? salesA.gross / salesA.units : 0} prev={salesP.units ? salesP.gross / salesP.units : 0} />
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>
                Gross + units only for now — the full ladder (cancellations, returns, discounts, GST) fills in once order-grain segregation extends to this channel.
              </div>
            </>
          )}

          {/* trend stacked by sub-channel */}
          <div className="so-card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <div className="so-kpi-lbl" style={{ margin: 0 }}>Daily {metric === 'units' ? 'units' : 'gross'} by channel</div>
              <div style={{ display: 'flex', gap: 4, background: 'var(--surface2)', borderRadius: 7, padding: 3 }}>
                {['gross', 'units'].map(m => (
                  <button key={m} onClick={() => setMetric(m)}
                    style={{ background: metric === m ? 'var(--accent)' : 'transparent', color: metric === m ? 'var(--accent-fg)' : 'var(--t2)', border: 'none', borderRadius: 5, padding: '5px 10px', fontFamily: 'var(--mono)', fontSize: 10.5, cursor: 'pointer', textTransform: 'capitalize' }}>{m}</button>
                ))}
              </div>
            </div>
            <StackedTrendChart days={shownTrend.days} dayVals={shownTrend.dv} metric={metric} groups={trendGroups} />
          </div>

          {/* split: by channel */}
          <div className="so-card">
            <div className="so-kpi-lbl">By channel</div>
            <div style={{ overflowX: 'auto' }}>
              {hasOrderGrain ? (
                <table className="so-table" style={{ marginTop: 10 }}>
                  <thead><tr>
                    <th>Channel</th><th className="so-num">Orders</th><th className="so-num">Gross</th>
                    <th className="so-num">Net (excl. canc.)</th><th className="so-num">Discounts</th>
                    <th className="so-num">GST</th><th className="so-num">Cancellations</th><th className="so-num">Returns</th>
                  </tr></thead>
                  <tbody>
                    {chRows.map(c => (
                      <tr key={c.id}>
                        <td>{c.name}</td>
                        <td className="so-num">{c.o ? fmtInt(c.o.totalOrders) : '—'}</td>
                        <td className="so-num">{c.o ? inr(c.o.grossAll) : inr(c.gross)}</td>
                        <td className="so-num">{c.o ? inr(c.o.netCancel) : '—'}</td>
                        <td className="so-num">{c.o ? inr(c.o.discount) : '—'}</td>
                        <td className="so-num">{c.o ? inr(c.o.tax) : '—'}</td>
                        <td className="so-num">{c.o ? `${fmtInt(c.o.cancelledOrders)} · ${inr(c.o.cancelledValue)}` : '—'}</td>
                        <td className="so-num">{c.o ? `${fmtInt(c.o.returnsCount)} · ${inr(c.o.returnsValue)}` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <table className="so-table" style={{ marginTop: 10 }}>
                  <thead><tr>
                    <th>Channel</th><th className="so-num">Gross</th><th className="so-num">Units</th><th className="so-num">ASP</th>
                  </tr></thead>
                  <tbody>
                    {chRows.map(c => (
                      <tr key={c.id}>
                        <td>{c.name}</td>
                        <td className="so-num">{inr(c.gross)}</td>
                        <td className="so-num">{fmtInt(c.units)}</td>
                        <td className="so-num">{inr(c.units ? c.gross / c.units : 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {/* top sellers within the family */}
          <div className="so-card">
            <div className="so-kpi-lbl" style={{ marginBottom: 12 }}>Top sellers</div>
            {topVar.arr.length === 0 ? <div style={{ color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 12 }}>No mapped variants in this range.</div> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {topVar.arr.map(v => {
                  const val = metric === 'units' ? v.units : v.gross;
                  return (
                    <div key={v.code} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ width: 200, fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.label}</div>
                      <div style={{ flex: 1, height: 16, background: 'var(--surface2)', borderRadius: 4, overflow: 'hidden' }}>
                        <div style={{ width: `${(val / topVar.max) * 100}%`, height: '100%', background: fam.color, opacity: 0.85 }} />
                      </div>
                      <div style={{ width: 90, textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t1)' }}>{fmt(val)}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
