'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { salesGet, inr, fmtInt, rangePresets, priorPeriod, istToday } from '../lib/api.js';
import { FAMILIES, FAMILY_ORDER, familyOf, SUBCHANNEL_PALETTE } from '../lib/families.js';
import { aggOrders } from '../lib/segregation.js';
import { Kpi, SettledBadge, RangePicker, SegmentedToggle, useTableSort, SortHeader } from './kit.js';
import { PageHead, PanelHead, ScopeTab, Swatch, Bar, Nil } from './prism.js';
import { HUE } from '../lib/hues.js';
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
  const router = useRouter();
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
  const chSort = useTableSort(chRows, { initialKey: 'grossAll', valueOf: (c, k) => {
    const o = c.o || {};
    if (k === 'name') return c.name;
    if (k === 'grossAll') return o.grossAll ?? c.gross;
    if (k === 'orders') return o.totalOrders || 0;
    if (k === 'netCancel') return o.netCancel || 0;
    if (k === 'discount') return o.discount || 0;
    if (k === 'tax') return o.tax || 0;
    if (k === 'cancelledValue') return o.cancelledValue || 0;
    if (k === 'returnsValue') return o.returnsValue || 0;
    if (k === 'asp') return c.units ? c.gross / c.units : 0;
    return c[k];
  } });

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
  // one lookup so the legend, the table swatches and the chart all read the SAME cycled colour
  const subColor = Object.fromEntries(trendGroups.map(g => [g.key, g.color]));
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
    <div className="so-page" style={{ gap: 12 }}>
      {/* family header — swatch + label + sub-channel count */}
      <PageHead
        title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 12 }}>
          <Swatch color={fam.color} size={13} glow style={{ borderRadius: 4 }} />{fam.label}
        </span>}
        sub={`${famChannels.length} sub-channel${famChannels.length === 1 ? '' : 's'} · vs prior period`}
      />
      <RangePicker from={from} to={to} onChange={({ from, to }) => { setFrom(from); setTo(to); }} />

      {/* family scope tabs — the strip that emptied the rail. Each tab is still its own
          existing route (/channels/<family>), so links and bookmarks keep working. */}
      <div className="so-scopebar">
        {FAMILY_ORDER.map(k => (
          <ScopeTab key={k} on={k === familyKey} color={FAMILIES[k].color} label={FAMILIES[k].label}
            title={FAMILIES[k].label} onClick={() => { if (k !== familyKey) router.push('/channels/' + k); }} />
        ))}
      </div>

      {err && <div className="so-card" style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 12 }}>{err}</div>}
      {!ready ? <div style={{ padding: 60, textAlign: 'center' }}><Spinner /></div> : !hasAnyData ? (
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
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
                <Kpi dense hue={HUE.count} lbl="Total Orders" val={fmtInt(segA.totalOrders)} sub="placed (incl. cancelled)" now={segA.totalOrders} prev={segP.totalOrders} />
                <Kpi dense hue={HUE.primary} lbl="Total Sales" val={inr(segA.grossAll)} sub="gross revenue" now={segA.grossAll} prev={segP.grossAll} />
                <Kpi dense hue={HUE.gross} lbl="Net Sales" val={inr(segA.netCancel)} sub="excl. cancellations" now={segA.netCancel} prev={segP.netCancel} />
                <Kpi dense hue={HUE.units} lbl="Net Revenue (ex-GST)" val={inr(segA.netExGst)} sub="after disc · returns · GST" now={segA.netExGst} prev={segP.netExGst} badge={<SettledBadge pct={segA.settledPct} />} />
                <Kpi dense hue={HUE.derived} lbl="AOV" val={inr(segA.aov)} sub="gross / order" now={segA.aov} prev={segP.aov} />
                <Kpi dense hue={HUE.cancel} lbl="Cancellations" val={`${fmtInt(segA.cancelledOrders)} · ${segA.cancelRate.toFixed(1)}%`} sub={inr(segA.cancelledValue)} now={segA.cancelledOrders} prev={segP.cancelledOrders} tone="neutral" />
                <Kpi dense hue={HUE.returns} lbl="Returns" val={`${fmtInt(segA.returnsCount)} · ${inr(segA.returnsValue)}`} sub="refund value" now={segA.returnsValue} prev={segP.returnsValue} tone="neutral" />
                <Kpi dense hue={HUE.neutral} lbl="Total Discounts" val={inr(segA.discount)} sub="discount given" now={segA.discount} prev={segP.discount} tone="neutral" />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
                <Kpi dense hue="#A78BFA" lbl="Replacements" val={fmtInt(segA.repl)} sub="mo_replacement" now={segA.repl} prev={segP.repl} tone="neutral" />
                <Kpi dense hue="#F2CD1A" lbl="Influencer Orders" val={fmtInt(segA.infl)} sub="mo_influencer" now={segA.infl} prev={segP.infl} tone="neutral" />
                <Kpi dense hue="#2DA8F0" lbl="Repairs" val={fmtInt(segA.repair)} sub="mo_repair" now={segA.repair} prev={segP.repair} tone="neutral" />
              </div>
            </>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
                <Kpi dense hue={HUE.primary} lbl="Gross sales" val={inr(salesA.gross)} sub="sell-out (pre-GST n/a yet)" now={salesA.gross} prev={salesP.gross} />
                <Kpi dense hue={HUE.units} lbl="Units sold" val={fmtInt(salesA.units)} now={salesA.units} prev={salesP.units} />
                <Kpi dense hue={HUE.derived} lbl="Avg selling price" val={inr(salesA.units ? salesA.gross / salesA.units : 0)} sub="gross / unit" now={salesA.units ? salesA.gross / salesA.units : 0} prev={salesP.units ? salesP.gross / salesP.units : 0} />
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>
                Gross + units only for now — the full ladder (cancellations, returns, discounts, GST) fills in once order-grain segregation extends to this channel.
              </div>
            </>
          )}

          {/* trend stacked by sub-channel — the chart itself ships unchanged (§7); only the panel
              around it is restyled. Plain wrapper so .so-card's backdrop-filter is never its DIRECT parent. */}
          <div className="so-card">
            <PanelHead
              title={`Daily ${metric === 'units' ? 'units' : 'gross'} by channel`}
              right={<div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', gap: 13, flexWrap: 'wrap' }}>
                  {trendGroups.map(g => (
                    <span key={g.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t2)' }}>
                      <Swatch color={g.color} />{g.label}
                    </span>
                  ))}
                </div>
                <SegmentedToggle options={['gross', 'units']} value={metric} onChange={setMetric} size="sm" />
              </div>}
            />
            <div>
              <StackedTrendChart days={shownTrend.days} dayVals={shownTrend.dv} metric={metric} groups={trendGroups} />
            </div>
          </div>

          {/* split: by channel | top sellers */}
          <div style={{ display: 'grid', gridTemplateColumns: '1.25fr 1fr', gap: 12, alignItems: 'start' }}>
            <div className="so-card flush" style={{ overflow: 'hidden' }}>
              <PanelHead title="By channel" style={{ marginBottom: 0 }} />
              <div style={{ overflowX: 'auto' }}>
                {hasOrderGrain ? (
                  <table className="so-table">
                    <thead><tr>
                      <SortHeader k="name" label="Channel" sort={chSort} /><SortHeader k="orders" label="Orders" sort={chSort} numeric /><SortHeader k="grossAll" label="Gross" sort={chSort} numeric />
                      <SortHeader k="netCancel" label="Net (excl. canc.)" sort={chSort} numeric /><SortHeader k="discount" label="Discounts" sort={chSort} numeric />
                      <SortHeader k="tax" label="GST" sort={chSort} numeric /><SortHeader k="cancelledValue" label="Cancellations" sort={chSort} numeric /><SortHeader k="returnsValue" label="Returns" sort={chSort} numeric />
                    </tr></thead>
                    <tbody>
                      {chSort.sorted.map(c => (
                        <tr key={c.id}>
                          <td style={{ whiteSpace: 'nowrap' }}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                              <Swatch color={subColor[c.id] || fam.color} />{c.name}
                            </span>
                          </td>
                          <td className="so-num">{c.o ? fmtInt(c.o.totalOrders) : <Nil />}</td>
                          <td className="so-num bright">{c.o ? inr(c.o.grossAll) : inr(c.gross)}</td>
                          <td className="so-num">{c.o ? inr(c.o.netCancel) : <Nil />}</td>
                          <td className="so-num">{c.o ? inr(c.o.discount) : <Nil />}</td>
                          <td className="so-num">{c.o ? inr(c.o.tax) : <Nil />}</td>
                          <td className="so-num">{c.o ? `${fmtInt(c.o.cancelledOrders)} · ${inr(c.o.cancelledValue)}` : <Nil />}</td>
                          <td className="so-num">{c.o ? `${fmtInt(c.o.returnsCount)} · ${inr(c.o.returnsValue)}` : <Nil />}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <table className="so-table">
                    <thead><tr>
                      <SortHeader k="name" label="Channel" sort={chSort} /><SortHeader k="gross" label="Gross" sort={chSort} numeric /><SortHeader k="units" label="Units" sort={chSort} numeric /><SortHeader k="asp" label="ASP" sort={chSort} numeric />
                    </tr></thead>
                    <tbody>
                      {chSort.sorted.map(c => (
                        <tr key={c.id}>
                          <td style={{ whiteSpace: 'nowrap' }}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                              <Swatch color={subColor[c.id] || fam.color} />{c.name}
                            </span>
                          </td>
                          <td className="so-num bright">{inr(c.gross)}</td>
                          <td className="so-num">{fmtInt(c.units)}</td>
                          <td className="so-num">{inr(c.units ? c.gross / c.units : 0)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            {/* top sellers within the family — bars in the family hue */}
            <div className="so-card">
              <PanelHead title="Top sellers" qual={metric === 'units' ? '· by units' : '· by gross'} />
              {topVar.arr.length === 0 ? <div style={{ color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 12 }}>No mapped variants in this range.</div> : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                  {topVar.arr.map(v => {
                    const val = metric === 'units' ? v.units : v.gross;
                    return (
                      <div key={v.code}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                          <span style={{ flex: 1, minWidth: 0, fontFamily: 'var(--ui)', fontSize: 12.5, color: 'var(--t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.label}</span>
                          <span style={{ width: 74, textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t1-cell)' }}>{fmt(val)}</span>
                        </div>
                        <Bar pct={(val / topVar.max) * 100} color={fam.color} height={7} />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
