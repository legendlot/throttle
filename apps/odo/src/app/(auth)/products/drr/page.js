'use client';
// Products — cross-channel matrix. Rows = products (families), columns = channels, cells = the
// chosen metric (DRR default · Units · Gross). Read across a product's row for its channel-wise
// DRR; click a product to expand its SKUs as channel-wise sub-rows.
//
// ⭐ DRR IS DRIVEN BY THE RANGE PICKER (2026-08-10, Afshaan). The denominator IS the selected
// range: 7D → a 7-day DRR, 90D → a 90-day DRR, a custom range → its own day count. It used to be
// a fixed trailing window from the `drr_window_days` admin setting, which meant DRR and the
// Units/Gross beside it described DIFFERENT periods on the same row — the thing that made the
// matrix hard to read. No API or SQL change was needed: `sales.f_product_drr(p_window, p_ref_date)`
// already computes over `[ref-(w-1) … ref]`, so passing `window = days in range` and
// `ref_date = to` reproduces the range exactly. The admin setting now only supplies the RPC's
// default for callers that pass no window (nothing else does today).
//
// Prism redesign (§9.7): the pivot and the colMax heat-shading maths are untouched — only the
// chrome changed (the DRR window contract above post-dates it). Channel headers now carry their family swatch, the sticky
// product column is OPAQUE (--surface-solid) so the matrix can't bleed through it while scrolling,
// and expanded SKU rows sit on --surface2 with the code in mono beneath the name.
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { useRouter } from 'next/navigation';
import { Spinner } from '@throttle/ui';
import { salesGet, inr, fmtInt, rangePresets } from '../../../../lib/api.js';
import { RangePicker, SegmentedToggle } from '../../../../components/kit.js';
import { PageHead, PanelHead, Pill, ScopeTab, Swatch } from '../../../../components/prism.js';
import { FAMILIES, familyOf } from '../../../../lib/families.js';
import { ChevronRight, ChevronDown } from 'lucide-react';

const drrFmt = (n) => (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 1 });
// The Total column is fenced off from the month/channel columns by this divider (§9.6/§9.7).
const TOT_BD = '1px solid #2a2d35';

export default function ProductsPage() {
  const { session } = useAuth();
  const router = useRouter();
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
  // Days in the selected range, inclusive of both ends — the DRR denominator, and exactly what
  // the range chip says (7D → 7). Dates are IST `YYYY-MM-DD`; parsed as UTC midnight on both
  // sides so the subtraction can't be knocked off by a DST/offset shift.
  const rangeDays = useMemo(() => {
    const a = Date.parse(`${from}T00:00:00Z`), b = Date.parse(`${to}T00:00:00Z`);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 1;
    return Math.max(1, Math.round((b - a) / 86400000) + 1);
  }, [from, to]);
  // A range ending today counts a day that is still being lived, so its DRR is understated until
  // midnight. Say so rather than quietly shrinking the window — the denominator must keep matching
  // the chip the user pressed.
  const partialToday = to >= rangePresets()[0].to;
  useEffect(() => {
    if (!session) return;
    salesGet('getBootstrap', {}, session)
      .then(b => { setChName(Object.fromEntries((b?.channels || []).map(c => [c.channel_id || c.id, c.name]))); })
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
      salesGet('getProductDrr', { window: rangeDays, ref_date: to }, session),
    ]).then(([sv, dr]) => setD({ salesVar: sv?.rows || [], drr: dr?.rows || [] }))
      .catch(e => setErr(e.message || String(e)));
  }, [session, from, to, rangeDays]);

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
  // Heat shade: same v/colMax ratio as before, capped at .26 alpha of the LOT yellow (§9.7).
  const shade = (v) => v > 0 ? `rgba(242,205,26,${((v / colMax) * 0.26).toFixed(3)})` : 'transparent';
  const toggle = (f) => setExpanded(e => ({ ...e, [f]: !e[f] }));
  // Every channel reference carries its family colour (§3.5).
  const chColor = (cid) => FAMILIES[familyOf(chName[cid] || String(cid))]?.color || FAMILIES.other.color;

  const ready = d !== null;
  const cell = (o, em, key) => (
    <td key={key} className="so-num" style={{ background: shade(cellVal(o)), color: cellVal(o) ? 'var(--t1-cell)' : 'var(--t5)', fontWeight: em ? 600 : 400 }}>{fmtCell(cellVal(o))}</td>
  );

  const drrNote = metric === 'drr'
    ? `DRR = avg units/day across the selected range — ${rangeDays} ${rangeDays === 1 ? 'day' : 'days'}${partialToday ? ', today still in progress' : ''}. Click a product to expand its SKUs.`
    : 'For the selected range. Click a product to expand its SKUs.';

  return (
    <div className="so-page">
      <PageHead
        title="Products · cross-channel"
        sub={drrNote}
        right={<>
          <Pill color="#F2CD1A" title={`DRR = units sold in the selected range ÷ ${rangeDays} ${rangeDays === 1 ? 'day' : 'days'}. Change the range to change the denominator — DRR, Units and Gross all describe the same period.${partialToday ? ' The range ends today, which is still in progress, so DRR reads low until midnight.' : ''}`}>DRR · {rangeDays}d</Pill>
          <SegmentedToggle options={[['drr', 'DRR /day'], ['units', 'Units'], ['gross', 'Gross']]} value={metric} onChange={setMetric} />
        </>} />

      {/* The rail no longer lists Products' children (the IA moved scope selection in-page), so
          this strip is what keeps /products/pnl reachable. Same routes as the old sidebar
          children — links and bookmarks are unaffected. */}
      <div className="so-scopebar">
        <ScopeTab on label="Cross-channel" onClick={() => {}} />
        <ScopeTab label="P&L by product" onClick={() => router.push('/products/pnl')} />
      </div>

      <RangePicker from={from} to={to} onChange={({ from, to }) => { setFrom(from); setTo(to); }} />

      {err && <div className="so-card" style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 12 }}>{err}</div>}
      {!ready ? <Spinner /> : fams.length === 0 ? (
        <div className="so-card" style={{ padding: 40, textAlign: 'center', color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 12.5 }}>No mapped product sales in this range.</div>
      ) : (
        <div className="so-card flush" style={{ overflow: 'hidden' }}>
          <PanelHead title="Cross-channel matrix"
            qual={`· ${metric === 'drr' ? 'DRR / day' : metric === 'units' ? 'units' : 'gross'} · shaded vs the busiest cell`} />
          <div style={{ overflowX: 'auto' }}>
            <table className="so-table" style={{ minWidth: 900 }}>
              <thead>
                <tr>
                  <th style={{ position: 'sticky', left: 0, background: 'var(--surface-solid)', zIndex: 2, minWidth: 230 }}>Product</th>
                  {cols.map(c => (
                    <th key={c} className="so-num" title={chName[c] || c}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <Swatch color={chColor(c)} size={7} />{chName[c] || c}
                      </span>
                    </th>
                  ))}
                  <th className="so-num" style={{ color: 'var(--t1)', borderLeft: TOT_BD }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {fams.map(f => (
                  <Row key={f.family} f={f} cols={cols} expanded={!!expanded[f.family]} toggle={toggle} cell={cell} fmtCell={fmtCell} cellVal={cellVal} />
                ))}
                {/* all-products total row */}
                <tr style={{ borderTop: '2px solid var(--border-strong)' }}>
                  <td style={{ position: 'sticky', left: 0, zIndex: 1, background: 'var(--surface-solid)', fontWeight: 600, color: 'var(--t2)' }}>All products</td>
                  {cols.map(c => <td key={c} className="so-num" style={{ color: 'var(--t2-cell)' }}>{fmtCell(cellVal(chTot[c]))}</td>)}
                  <td className="so-num" style={{ borderLeft: TOT_BD, fontWeight: 700, color: 'var(--t1)' }}>{fmtCell(cols.reduce((s, c) => s + cellVal(chTot[c]), 0))}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ f, cols, expanded, toggle, cell, fmtCell, cellVal }) {
  const codes = Object.values(f.codes).sort((a, b) => b.tot.gross - a.tot.gross);
  return (
    <>
      <tr onClick={() => toggle(f.family)} style={{ cursor: 'pointer' }}>
        <td style={{ position: 'sticky', left: 0, zIndex: 1, background: 'var(--surface-solid)', fontWeight: 600, color: 'var(--t1)', whiteSpace: 'nowrap' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {expanded ? <ChevronDown size={13} strokeWidth={1.75} /> : <ChevronRight size={13} strokeWidth={1.75} />}{f.family}
          </span>
        </td>
        {cols.map(c => cell(f.ch[c], true, c))}
        <td className="so-num" style={{ borderLeft: TOT_BD, fontWeight: 700, color: 'var(--t1)' }}>{fmtCell(cellVal(f.tot))}</td>
      </tr>
      {expanded && codes.map(co => (
        <tr key={co.code} style={{ background: 'rgba(255,255,255,.018)' }}>
          <td style={{ position: 'sticky', left: 0, zIndex: 1, background: 'var(--surface2)', paddingLeft: 34, color: 'var(--t2)', whiteSpace: 'nowrap' }}>
            {co.label}
            {co.code !== co.label && <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--t5)', marginTop: 2 }}>{co.code}</div>}
          </td>
          {cols.map(c => cell(co.ch[c], false, c))}
          <td className="so-num" style={{ borderLeft: TOT_BD, color: 'var(--t2-cell)' }}>{fmtCell(cellVal(co.tot))}</td>
        </tr>
      ))}
    </>
  );
}
