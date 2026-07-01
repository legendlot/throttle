'use client';
// Products — cross-channel matrix. Rows = products (families), columns = channels, cells = the
// chosen metric (DRR default · Units · Gross). Read across a product's row for its channel-wise
// DRR; click a product to expand its SKUs as channel-wise sub-rows. DRR comes from the reusable
// sales.f_product_drr contract (trailing global window); Units/Gross are for the selected range.
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { salesGet, inr, fmtInt, rangePresets } from '../../../../lib/api.js';
import { RangePicker, SegmentedToggle } from '../../../../components/kit.js';
import { ChevronRight, ChevronDown } from 'lucide-react';

const drrFmt = (n) => (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 1 });

export default function ProductsPage() {
  const { session } = useAuth();
  const presets = rangePresets();
  const mtd = presets.find(p => p.key === 'mtd');
  const [from, setFrom] = useState(mtd.from);
  const [to, setTo] = useState(mtd.to);
  const [metric, setMetric] = useState('drr');        // drr | units | gross
  const [expanded, setExpanded] = useState({});       // family → bool
  const [d, setD] = useState(null);                   // { salesVar, drr }
  const [err, setErr] = useState('');

  const [chName, setChName] = useState({});
  const [c2p, setC2p] = useState({});
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

  // Build the matrix: family → {ch:{cid:{units,gross,drr}}, tot, codes:{code:{...}}}, + per-channel totals.
  const { fams, cols, chTot } = useMemo(() => {
    const fam = {}, chTot = {};
    const ensureFam = f => (fam[f] = fam[f] || { family: f, ch: {}, tot: { units: 0, gross: 0, drr: 0 }, codes: {} });
    const ensureCode = (F, c, lbl) => (F.codes[c] = F.codes[c] || { code: c, label: lbl || c, ch: {}, tot: { units: 0, gross: 0, drr: 0 } });
    const bump = (o, cid, k, v) => { (o.ch[cid] = o.ch[cid] || { units: 0, gross: 0, drr: 0 })[k] += v; o.tot[k] += v; };
    for (const r of (d?.salesVar || [])) {
      const c = r.product_code; if (!c) continue;
      const f = c2p[c] || r.grp_label || c, cid = r.channel_id, u = Number(r.units) || 0, g = Number(r.gross_value) || 0;
      const F = ensureFam(f), C = ensureCode(F, c, r.grp_label);
      bump(F, cid, 'units', u); bump(F, cid, 'gross', g); bump(C, cid, 'units', u); bump(C, cid, 'gross', g);
      (chTot[cid] = chTot[cid] || { units: 0, gross: 0, drr: 0 }).units += u; chTot[cid].gross += g;
    }
    for (const r of (d?.drr || [])) {
      const c = r.product_code; if (!c) continue;
      const f = c2p[c] || r.product || c, cid = r.channel_id, v = Number(r.drr) || 0;
      const F = ensureFam(f), C = ensureCode(F, c);
      bump(F, cid, 'drr', v); bump(C, cid, 'drr', v);
      (chTot[cid] = chTot[cid] || { units: 0, gross: 0, drr: 0 }).drr += v;
    }
    const cols = Object.keys(chTot).sort((a, b) => chTot[b].gross - chTot[a].gross);
    const famArr = Object.values(fam).sort((a, b) => b.tot.gross - a.tot.gross);
    return { fams: famArr, cols, chTot };
  }, [d, c2p]);

  const cellVal = (o) => !o ? 0 : (metric === 'drr' ? o.drr : metric === 'units' ? o.units : o.gross);
  const fmtCell = (v) => !v ? '·' : (metric === 'drr' ? drrFmt(v) : metric === 'units' ? fmtInt(v) : inr(v));
  const colMax = useMemo(() => Math.max(...fams.flatMap(f => cols.map(c => cellVal(f.ch[c]))), 1), [fams, cols, metric]);
  const shade = (v) => v > 0 ? `color-mix(in srgb, var(--accent) ${Math.round((v / colMax) * 26)}%, transparent)` : 'transparent';
  const toggle = (f) => setExpanded(e => ({ ...e, [f]: !e[f] }));

  const ready = d !== null;
  const cell = (o, em) => (
    <td className="so-num" style={{ background: shade(cellVal(o)), color: cellVal(o) ? 'var(--t1)' : 'var(--t3)', fontWeight: em ? 600 : 400 }}>{fmtCell(cellVal(o))}</td>
  );

  return (
    <div className="so-page">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <span className="so-h2" style={{ fontSize: 18 }}>Products · cross-channel</span>
        <span className="so-pill" style={{ background: 'var(--surface2)', color: 'var(--t2)' }} title={`DRR = avg units sold/day over the last ${drrWindow} full days (set in Admin). Units/Gross use the selected range.`}>DRR · {drrWindow}d</span>
      </div>
      <RangePicker from={from} to={to} onChange={({ from, to }) => { setFrom(from); setTo(to); }}
        right={<SegmentedToggle options={[['drr', 'DRR /day'], ['units', 'Units'], ['gross', 'Gross']]} value={metric} onChange={setMetric} size="sm" />} />
      <div className="so-sub" style={{ fontSize: 11, marginTop: -8 }}>
        {metric === 'drr' ? `DRR = avg units/day over the last ${drrWindow} days (independent of the range above). Click a product to expand its SKUs.` : 'For the selected range. Click a product to expand its SKUs.'}
      </div>

      {err && <div className="so-card" style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 12 }}>{err}</div>}
      {!ready ? <Spinner /> : fams.length === 0 ? (
        <div className="so-card" style={{ padding: 40, textAlign: 'center', color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 12.5 }}>No mapped product sales in this range.</div>
      ) : (
        <div className="so-card" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="so-table" style={{ minWidth: 640 }}>
            <thead>
              <tr>
                <th style={{ position: 'sticky', left: 0, background: 'var(--surface)', zIndex: 1 }}>Product</th>
                {cols.map(c => <th key={c} className="so-num">{chName[c] || c}</th>)}
                <th className="so-num" style={{ color: 'var(--t1)' }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {fams.map(f => (
                <Row key={f.family} f={f} cols={cols} expanded={!!expanded[f.family]} toggle={toggle} cell={cell} fmtCell={fmtCell} cellVal={cellVal} chName={chName} />
              ))}
              {/* all-products total row */}
              <tr style={{ borderTop: '2px solid var(--border-strong)' }}>
                <td style={{ position: 'sticky', left: 0, background: 'var(--surface)', fontWeight: 600, color: 'var(--t2)' }}>All products</td>
                {cols.map(c => <td key={c} className="so-num" style={{ color: 'var(--t2)' }}>{fmtCell(cellVal(chTot[c]))}</td>)}
                <td className="so-num" style={{ fontWeight: 700, color: 'var(--t1)' }}>{fmtCell(cols.reduce((s, c) => s + cellVal(chTot[c]), 0))}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Row({ f, cols, expanded, toggle, cell, fmtCell, cellVal, chName }) {
  const codes = Object.values(f.codes).sort((a, b) => b.tot.gross - a.tot.gross);
  return (
    <>
      <tr onClick={() => toggle(f.family)} style={{ cursor: 'pointer' }}>
        <td style={{ position: 'sticky', left: 0, background: 'var(--surface)', fontWeight: 600, color: 'var(--t1)' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}{f.family}
          </span>
        </td>
        {cols.map(c => cell(f.ch[c], true))}
        <td className="so-num" style={{ fontWeight: 700, color: 'var(--t1)' }}>{fmtCell(cellVal(f.tot))}</td>
      </tr>
      {expanded && codes.map(co => (
        <tr key={co.code} style={{ background: 'color-mix(in srgb, var(--surface2) 50%, transparent)' }}>
          <td style={{ position: 'sticky', left: 0, background: 'var(--surface)', paddingLeft: 30, color: 'var(--t2)', fontFamily: 'var(--mono)', fontSize: 12 }}>{co.label}</td>
          {cols.map(c => cell(co.ch[c], false))}
          <td className="so-num" style={{ color: 'var(--t2)' }}>{fmtCell(cellVal(co.tot))}</td>
        </tr>
      ))}
    </>
  );
}
