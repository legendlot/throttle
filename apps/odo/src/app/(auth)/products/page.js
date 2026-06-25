'use client';
// Products — product-centric view (mirror of Channels, but product is the hero). Master list of
// product families → drill into one: channel distribution + per-channel DRR + SKU breakdown +
// trend. DRR (daily run rate) comes from the reusable sales.f_product_drr contract (global window
// from sales.settings); shown here, consumed by other systems (Redline planning) later.
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { salesGet, inr, fmtInt, rangePresets, priorPeriod } from '../../../lib/api.js';
import { SUBCHANNEL_PALETTE } from '../../../lib/families.js';
import { Kpi, RangePicker, SegmentedToggle } from '../../../components/kit.js';
import StackedTrendChart from '../../../components/StackedTrendChart.js';

const drrFmt = (n) => (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 1 });

export default function ProductsPage() {
  const { session } = useAuth();
  const presets = rangePresets();
  const mtd = presets.find(p => p.key === 'mtd');
  const [from, setFrom] = useState(mtd.from);
  const [to, setTo] = useState(mtd.to);
  const [metric, setMetric] = useState('gross');     // distribution + trend: gross | units
  const [sel, setSel] = useState(null);              // selected product family
  const [d, setD] = useState(null);                  // { salesVar, drr }
  const [err, setErr] = useState('');

  const [chName, setChName] = useState({});          // channel_id → name
  const [c2p, setC2p] = useState({});                // product_code → family
  const [drrWindow, setDrrWindow] = useState(7);
  useEffect(() => {
    if (!session) return;
    salesGet('getBootstrap', {}, session)
      .then(b => { setChName(Object.fromEntries((b?.channels || []).map(c => [c.channel_id || c.id, c.name]))); if (b?.drr_window_days) setDrrWindow(b.drr_window_days); })
      .catch(() => {});
    salesGet('getVariants', {}, session)
      .then(r => { const m = {}; (r?.rows || []).forEach(v => { m[v.product_code] = v.product; }); setC2p(m); })
      .catch(() => {});
  }, [session]);

  useEffect(() => {
    if (!session) return;
    setD(null); setErr('');
    Promise.all([
      salesGet('getSales', { from, to, group: 'variant' }, session),
      salesGet('getProductDrr', {}, session),
    ]).then(([sv, dr]) => setD({ salesVar: sv?.rows || [], drr: dr?.rows || [] }))
      .catch(e => setErr(e.message || String(e)));
  }, [session, from, to]);

  // roll the variant rows up to product family (units/gross + per-channel + per-SKU)
  const fams = useMemo(() => {
    const f = {};
    for (const r of (d?.salesVar || [])) {
      const code = r.product_code; if (!code) continue;
      const fam = c2p[code] || r.grp_label || code;
      const u = Number(r.units) || 0, g = Number(r.gross_value) || 0;
      const o = (f[fam] = f[fam] || { family: fam, units: 0, gross: 0, ch: {}, codes: {} });
      o.units += u; o.gross += g;
      (o.ch[r.channel_id] = o.ch[r.channel_id] || { units: 0, gross: 0 }); o.ch[r.channel_id].units += u; o.ch[r.channel_id].gross += g;
      (o.codes[code] = o.codes[code] || { code, label: r.grp_label || code, units: 0, gross: 0 }); o.codes[code].units += u; o.codes[code].gross += g;
    }
    return f;
  }, [d, c2p]);

  // DRR roll-ups from f_product_drr rows (product_code × channel)
  const drr = useMemo(() => {
    const byFam = {}, byCode = {}, byFamCh = {};
    for (const r of (d?.drr || [])) {
      const code = r.product_code; const fam = c2p[code] || r.product || code; const v = Number(r.drr) || 0;
      byFam[fam] = (byFam[fam] || 0) + v;
      byCode[code] = (byCode[code] || 0) + v;
      (byFamCh[fam] = byFamCh[fam] || {})[r.channel_id] = ((byFamCh[fam] || {})[r.channel_id] || 0) + v;
    }
    return { byFam, byCode, byFamCh };
  }, [d, c2p]);

  // master rows
  const master = useMemo(() => Object.values(fams).map(o => {
    const chs = Object.entries(o.ch).sort((a, b) => b[1].gross - a[1].gross);
    return { family: o.family, units: o.units, gross: o.gross, drr: drr.byFam[o.family] || 0, top: chs[0] ? (chName[chs[0][0]] || chs[0][0]) : '—', nCh: chs.length };
  }).sort((a, b) => b.gross - a.gross), [fams, drr, chName]);

  // default selection = top product once data is in
  useEffect(() => { if (master.length && (!sel || !fams[sel])) setSel(master[0].family); }, [master]); // eslint-disable-line

  const det = sel ? fams[sel] : null;
  const detChannels = useMemo(() => !det ? [] : Object.entries(det.ch)
    .map(([cid, v]) => ({ cid, name: chName[cid] || cid, units: v.units, gross: v.gross, drr: (drr.byFamCh[sel] || {})[cid] || 0 }))
    .sort((a, b) => b.gross - a.gross), [det, drr, chName, sel]);
  const detVariants = useMemo(() => !det ? [] : Object.values(det.codes)
    .map(v => ({ ...v, drr: drr.byCode[v.code] || 0 })).sort((a, b) => b.gross - a.gross), [det, drr]);

  // family daily trend, stacked by channel
  const trend = useMemo(() => {
    if (!det) return { days: [], dv: {}, groups: [] };
    const codes = new Set(Object.keys(det.codes));
    const dv = {};
    for (const r of (d?.salesVar || [])) {
      if (!r.sale_date || !codes.has(r.product_code)) continue;
      const val = metric === 'units' ? (Number(r.units) || 0) : (Number(r.gross_value) || 0);
      (dv[r.sale_date] = dv[r.sale_date] || {})[r.channel_id] = (dv[r.sale_date][r.channel_id] || 0) + val;
    }
    const groups = detChannels.map((c, i) => ({ key: c.cid, label: c.name, color: SUBCHANNEL_PALETTE[i % SUBCHANNEL_PALETTE.length] }));
    return { days: Object.keys(dv).sort(), dv, groups };
  }, [det, d, metric, detChannels]);

  const fmt = metric === 'units' ? fmtInt : inr;
  const maxChan = Math.max(...detChannels.map(c => metric === 'units' ? c.units : c.gross), 1);
  const ready = d !== null;

  return (
    <div className="so-page">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <span className="so-h2" style={{ fontSize: 18 }}>Products</span>
        <span className="so-pill" style={{ background: 'var(--surface2)', color: 'var(--t2)' }} title={`DRR = average units sold per day over the last ${drrWindow} full days (set in Admin)`}>DRR · {drrWindow}d</span>
      </div>
      <RangePicker from={from} to={to} onChange={({ from, to }) => { setFrom(from); setTo(to); }}
        right={<SegmentedToggle options={['gross', 'units']} value={metric} onChange={setMetric} size="sm" />} />

      {err && <div className="so-card" style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 12 }}>{err}</div>}
      {!ready ? <Spinner /> : master.length === 0 ? (
        <div className="so-card" style={{ padding: 40, textAlign: 'center', color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 12.5 }}>No mapped product sales in this range.</div>
      ) : (
        <>
          {/* master list */}
          <div className="so-card">
            <div className="so-kpi-lbl" style={{ marginBottom: 4 }}>Products</div>
            <div style={{ overflowX: 'auto' }}>
              <table className="so-table">
                <thead><tr>
                  <th>Product</th><th className="so-num">Units</th><th className="so-num">Gross</th>
                  <th className="so-num">DRR /day</th><th>Top channel</th><th className="so-num">Channels</th>
                </tr></thead>
                <tbody>
                  {master.map(m => (
                    <tr key={m.family} onClick={() => setSel(m.family)}
                      style={{ cursor: 'pointer', background: sel === m.family ? 'var(--surface2)' : undefined }}>
                      <td style={{ color: sel === m.family ? 'var(--t1)' : 'var(--t2)', fontWeight: sel === m.family ? 600 : 400 }}>{m.family}</td>
                      <td className="so-num">{fmtInt(m.units)}</td>
                      <td className="so-num">{inr(m.gross)}</td>
                      <td className="so-num" style={{ color: 'var(--accent)' }}>{drrFmt(m.drr)}</td>
                      <td>{m.top}</td>
                      <td className="so-num">{m.nCh}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {det && (
            <>
              {/* detail KPIs */}
              <div className="so-kpi-lbl" style={{ marginTop: 4 }}>{det.family}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12 }}>
                <Kpi lbl="Units" val={fmtInt(det.units)} sub="in range" accent="var(--blue)" />
                <Kpi lbl="Gross" val={inr(det.gross)} sub="in range" accent="var(--blue)" />
                <Kpi lbl="DRR (overall)" val={`${drrFmt(drr.byFam[det.family] || 0)} /day`} sub={`last ${drrWindow}d avg units`} accent="var(--accent)" />
                <Kpi lbl="Channels" val={fmtInt(detChannels.length)} sub="selling this product" />
              </div>

              {/* channel distribution */}
              <div className="so-card">
                <div className="so-kpi-lbl" style={{ marginBottom: 12 }}>Distribution across channels</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 14 }}>
                  {detChannels.map((c, i) => {
                    const val = metric === 'units' ? c.units : c.gross;
                    return (
                      <div key={c.cid} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div style={{ width: 150, fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</div>
                        <div style={{ flex: 1, height: 16, background: 'var(--surface2)', borderRadius: 4, overflow: 'hidden' }}>
                          <div style={{ width: `${(val / maxChan) * 100}%`, height: '100%', background: SUBCHANNEL_PALETTE[i % SUBCHANNEL_PALETTE.length], opacity: 0.85 }} />
                        </div>
                        <div style={{ width: 110, textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t1)' }}>{fmt(val)}</div>
                      </div>
                    );
                  })}
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table className="so-table">
                    <thead><tr><th>Channel</th><th className="so-num">Units</th><th className="so-num">Gross</th><th className="so-num">Share</th><th className="so-num">DRR /day</th></tr></thead>
                    <tbody>
                      {detChannels.map(c => (
                        <tr key={c.cid}>
                          <td>{c.name}</td>
                          <td className="so-num">{fmtInt(c.units)}</td>
                          <td className="so-num">{inr(c.gross)}</td>
                          <td className="so-num">{det.gross ? ((c.gross / det.gross) * 100).toFixed(0) : 0}%</td>
                          <td className="so-num" style={{ color: 'var(--accent)' }}>{drrFmt(c.drr)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* daily trend */}
              <div className="so-card">
                <div className="so-kpi-lbl" style={{ marginBottom: 10 }}>Daily {metric === 'units' ? 'units' : 'gross'} by channel</div>
                <StackedTrendChart days={trend.days} dayVals={trend.dv} metric={metric} groups={trend.groups} />
              </div>

              {/* SKU breakdown */}
              <div className="so-card">
                <div className="so-kpi-lbl" style={{ marginBottom: 10 }}>Variants (SKU)</div>
                <div style={{ overflowX: 'auto' }}>
                  <table className="so-table">
                    <thead><tr><th>SKU</th><th className="so-num">Units</th><th className="so-num">Gross</th><th className="so-num">ASP</th><th className="so-num">DRR /day</th></tr></thead>
                    <tbody>
                      {detVariants.map(v => (
                        <tr key={v.code}>
                          <td>{v.label}</td>
                          <td className="so-num">{fmtInt(v.units)}</td>
                          <td className="so-num">{inr(v.gross)}</td>
                          <td className="so-num">{inr(v.units ? v.gross / v.units : 0)}</td>
                          <td className="so-num" style={{ color: 'var(--accent)' }}>{drrFmt(v.drr)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
