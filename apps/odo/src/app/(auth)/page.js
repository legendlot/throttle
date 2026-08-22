'use client';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, Modal, Combobox } from '@throttle/ui';
import { salesGet, inr, fmtInt, istToday, istDaysAgo, downloadCsv, rangePresets, priorPeriod } from '../../lib/api.js';
import { downloadXlsx } from '../../lib/xlsx.js';
import StackedTrendChart from '../../components/StackedTrendChart.js';
import { Kpi, Delta, RangePicker, SegmentedToggle, SettledBadge, useTableSort, SortHeader } from '../../components/kit.js';
import ChannelFilter from '../../components/ChannelFilter.js';
import { hybridHeadline } from '../../lib/segregation.js';
// Prism atoms — shared vocabulary, presentational only.
import { Swatch, PanelHead, PageHead, Bar, Donut, Nil } from '../../components/prism.js';
import { HUE, STATUS } from '../../lib/hues.js';
// Channel families — single source of truth (shared with the Channels section). Aliased so the
// existing chart/chip code keeps its names.
import { FAMILIES as GROUP_META, FAMILY_ORDER as GROUP_ORDER, familyOf as channelGroup } from '../../lib/families.js';

const GROUPS = [
  { key: 'variant', label: 'By Variant' },
  { key: 'product', label: 'By Product' },
  { key: 'date',    label: 'By Day' },
  { key: 'channel', label: 'By Channel' },
];

// relative "time ago" for connector freshness
function ago(iso) {
  if (!iso) return 'never';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!isFinite(s)) return 'never';
  if (s < 90) return 'just now';
  if (s < 5400) return Math.round(s / 60) + 'm ago';
  if (s < 172800) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}
// Semantic status never borrows a family hue (handoff §3.5) — these are the STATUS tokens.
const HEALTH_COLOR = { ok: STATUS.good, partial: STATUS.warn, error: STATUS.bad, never: STATUS.none };

const PRESETS = rangePresets();

// shared row primitives — names in the UI font, every number in mono tabular
const NAME = { fontFamily: 'var(--ui)', fontSize: 12, color: 'var(--t1)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const NUM = { fontFamily: 'var(--mono)', fontSize: 11, fontVariantNumeric: 'tabular-nums', textAlign: 'right' };
const EMPTY = { fontFamily: 'var(--ui)', fontSize: 12.5, color: 'var(--t3)' };

export default function Dashboard() {
  const { session } = useAuth();
  const [channels, setChannels] = useState([]);
  const [sel, setSel] = useState([]);            // selected channel ids ([] = all)
  const MTD = PRESETS.find(p => p.key === 'mtd');
  const [preset, setPreset] = useState('mtd');
  const [from, setFrom] = useState(MTD.from);
  const [to, setTo] = useState(MTD.to);
  const [group, setGroup] = useState('variant'); // drill table axis
  const [drill, setDrill] = useState(null);      // S294 — { title, params } → underlying-orders modal
  const [trendMetric, setTrendMetric] = useState('gross');
  const [variantMetric, setVariantMetric] = useState('gross');
  const [sellerRollup, setSellerRollup] = useState('variant'); // variant | product
  const [connectors, setConnectors] = useState([]);
  const [unmappedCount, setUnmappedCount] = useState(0);
  const [codeToProduct, setCodeToProduct] = useState({});
  const [variants, setVariants] = useState([]);   // product_master rows — feeds the Detail product search
  // Detail-only product filter. '' = everything. 'p:<product>' = every variant of a product,
  // 'v:<product_code>' = one variant. Deliberately scoped to the Detail table (that is what was
  // asked for) — the KPIs, mix board and movers above stay whole-catalogue, so the panel head
  // names the selection loudly enough that the two are never read as the same number.
  const [productFilter, setProductFilter] = useState('');
  const [rows, setRows] = useState([]);
  const [prevRows, setPrevRows] = useState([]);
  const [segRows, setSegRows] = useState([]);        // order-grain (f_order_rollup) — headline only
  const [segPrevRows, setSegPrevRows] = useState([]);
  // "Accessories & others" MEMO — unmapped spares/gift-wrap/service. Deliberately NOT folded into
  // any total: it is read off staging, never sales_fact. Kept in its own state so it can't leak in.
  const [acc, setAcc] = useState({ rows: [], total: { units: 0, gross: 0, skus: 0 } });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!session) return;
    salesGet('getBootstrap', {}, session)
      .then(b => {
        setChannels((b?.channels || []).map(c => ({ channel_id: c.channel_id || c.id, name: c.name, type: c.type })));
        setConnectors(b?.connectors || []);
        setUnmappedCount(b?.unmapped_count || 0);
      })
      .catch(() => {});
    salesGet('getVariants', {}, session)
      .then(r => {
        const rows = r?.rows || [];
        const m = {}; rows.forEach(v => { m[v.product_code] = v.product; });
        setCodeToProduct(m); setVariants(rows);
      })
      .catch(() => {});
  }, [session]);

  const chName = useMemo(() => Object.fromEntries(channels.map(c => [c.channel_id, c.name])), [channels]);

  useEffect(() => {
    if (!session) return;
    setLoading(true); setErr('');
    const pp = priorPeriod(from, to);
    const chArg = sel.join(',');
    Promise.all([
      salesGet('getSales', { from, to, group: 'variant', channel_id: chArg }, session),
      salesGet('getSales', { from: pp.from, to: pp.to, group: 'variant', channel_id: chArg }, session),
      // order-grain (complete, sku-map-independent) — drives the hybrid headline totals only
      salesGet('getSegregation', { from, to, channel_id: chArg }, session),
      salesGet('getSegregation', { from: pp.from, to: pp.to, channel_id: chArg }, session),
      // ⚠️ The accessories MEMO must never be load-bearing. It shipped inside this Promise.all
      // without a catch and took the WHOLE dashboard down when its RPC 502'd on an FY range:
      // every KPI, the mix board and the drill table silently kept the previous range's numbers
      // under the new range's labels — stale data reading as fresh, the worst failure shape here.
      // A decorative panel gets its own catch so it can only ever fail to itself.
      salesGet('getAccessories', { from, to, channel_id: chArg }, session).catch(() => 'ERR'),
    ]).then(([cur, prev, seg, segPrev, accessories]) => {
      setRows(cur?.rows || []); setPrevRows(prev?.rows || []);
      setSegRows(seg?.rows || []); setSegPrevRows(segPrev?.rows || []);
      // Distinguish FAILED from GENUINELY EMPTY. Swallowing the error entirely would hide the strip,
      // which reads as "no accessories sold this period" — and there is ~₹1.5L of them. A memo may
      // fail quietly; it must not lie quietly.
      setAcc(accessories === 'ERR'
        ? { rows: [], total: { units: 0, gross: 0, skus: 0 }, failed: true }
        : { rows: accessories?.rows || [], total: accessories?.total || { units: 0, gross: 0, skus: 0 }, failed: false });
    })
      .catch(e => setErr(e.message || 'Failed to load'))
      .finally(() => setLoading(false));
  }, [session, from, to, sel]);

  // ── aggregations ──
  const aggOf = (rs) => {
    let units = 0, gross = 0; const day = {}, ch = {}, variant = {};
    for (const r of rs) {
      const u = Number(r.units) || 0, g = Number(r.gross_value) || 0;
      units += u; gross += g;
      (day[r.sale_date] = day[r.sale_date] || { units: 0, gross: 0 }); day[r.sale_date].units += u; day[r.sale_date].gross += g;
      (ch[r.channel_id] = ch[r.channel_id] || { units: 0, gross: 0 }); ch[r.channel_id].units += u; ch[r.channel_id].gross += g;
      (variant[r.product_code] = variant[r.product_code] || { units: 0, gross: 0, label: r.grp_label || r.product_code }); variant[r.product_code].units += u; variant[r.product_code].gross += g;
    }
    return { units, gross, day, ch, variant };
  };
  const cur = useMemo(() => aggOf(rows), [rows]);
  const prev = useMemo(() => aggOf(prevRows), [prevRows]);

  const daySeries = useMemo(() => {
    const ds = Object.keys(cur.day).sort();
    return { ds, gross: ds.map(d => cur.day[d].gross), units: ds.map(d => cur.day[d].units), asp: ds.map(d => cur.day[d].units ? cur.day[d].gross / cur.day[d].units : 0) };
  }, [cur]);

  // ── hybrid headline: order-grain where a channel has it (complete, sku-map-independent),
  // product-grain gross as fallback for channels without it (QC). Drives the headline TOTALS only;
  // the mix below (channel board, variants, movers, trend, drill) stays product-grain. ──
  const head = useMemo(() => hybridHeadline(segRows, rows), [segRows, rows]);
  const headPrev = useMemo(() => hybridHeadline(segPrevRows, prevRows), [segPrevRows, prevRows]);
  const headDaily = useMemo(() => {
    const byO = {}, byP = {};
    for (const r of segRows) (byO[r.sale_date] = byO[r.sale_date] || []).push(r);
    for (const r of rows) (byP[r.sale_date] = byP[r.sale_date] || []).push(r);
    const ds = [...new Set([...Object.keys(byO), ...Object.keys(byP)])].sort();
    return {
      net: ds.map(d => hybridHeadline(byO[d] || [], byP[d] || []).netExGst),
      gross: ds.map(d => hybridHeadline(byO[d] || [], byP[d] || []).grossAll),
    };
  }, [segRows, rows]);

  const trend = useMemo(() => {
    const dv = {};
    for (const r of rows) {
      const gk = channelGroup(chName[r.channel_id] || '');
      const v = trendMetric === 'units' ? (Number(r.units) || 0) : (Number(r.gross_value) || 0);
      (dv[r.sale_date] = dv[r.sale_date] || {}); dv[r.sale_date][gk] = (dv[r.sale_date][gk] || 0) + v;
    }
    return { dv, days: Object.keys(dv).sort() };
  }, [rows, chName, trendMetric]);

  const channelBoard = useMemo(() => {
    const arr = Object.entries(cur.ch).map(([id, v]) => ({
      id, name: chName[id] || id, gk: channelGroup(chName[id] || ''),
      gross: v.gross, units: v.units, prevGross: prev.ch[id]?.gross || 0,
    })).sort((a, b) => b.gross - a.gross);
    const max = Math.max(...arr.map(c => c.gross), 1);
    return { arr, max };
  }, [cur, prev, chName]);

  // family roll-up of the same product-grain channel aggregate — one donut arc per family.
  // Derived client-side from rows already loaded; no additional read.
  const famMix = useMemo(() => {
    const t = {};
    for (const [id, v] of Object.entries(cur.ch)) {
      const k = channelGroup(chName[id] || '');
      (t[k] = t[k] || { key: k, label: GROUP_META[k].label, color: GROUP_META[k].color, value: 0 });
      t[k].value += v.gross;
    }
    return GROUP_ORDER.filter(k => t[k] && t[k].value > 0).map(k => t[k]);
  }, [cur, chName]);

  const variantBoard = useMemo(() => {
    const src = {};
    for (const [code, v] of Object.entries(cur.variant)) {
      const key = sellerRollup === 'product' ? (codeToProduct[code] || v.label) : code;
      const label = sellerRollup === 'product' ? (codeToProduct[code] || v.label) : v.label;
      const s = src[key] || (src[key] = { key, label, gross: 0, units: 0 });
      s.gross += v.gross; s.units += v.units;
    }
    const arr = Object.values(src).sort((a, b) => (variantMetric === 'units' ? b.units - a.units : b.gross - a.gross)).slice(0, 12);
    const max = Math.max(...arr.map(v => variantMetric === 'units' ? v.units : v.gross), 1);
    return { arr, max };
  }, [cur, variantMetric, sellerRollup, codeToProduct]);

  // biggest gainers / decliners by gross ₹ vs prior period (variant grain)
  const movers = useMemo(() => {
    const codes = new Set([...Object.keys(cur.variant), ...Object.keys(prev.variant)]);
    const arr = [];
    for (const code of codes) {
      const c = cur.variant[code]?.gross || 0, p = prev.variant[code]?.gross || 0;
      const delta = c - p;
      if (Math.abs(delta) < 1 || Math.max(c, p) < 2000) continue; // drop noise
      arr.push({ code, label: cur.variant[code]?.label || prev.variant[code]?.label || code, c, p, delta, pct: p ? (delta / p) * 100 : null });
    }
    return {
      up: arr.filter(x => x.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 6),
      down: arr.filter(x => x.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 6),
    };
  }, [cur, prev]);

  // connector freshness (enabled connectors only)
  const health = useMemo(() => connectors.filter(c => c.enabled).map(c => ({
    ...c, statusKey: c.last_error ? 'error' : (c.last_run?.status || (c.last_ok_at ? 'ok' : 'never')),
  })).sort((a, b) => (a.name || '').localeCompare(b.name || '')), [connectors]);

  const activeChannels = useMemo(() => Object.values(cur.ch).filter(c => c.gross > 0).length, [cur]);
  const prevActive = useMemo(() => Object.values(prev.ch).filter(c => c.gross > 0).length, [prev]);
  const curAsp = cur.units ? cur.gross / cur.units : 0;
  const prevAsp = prev.units ? prev.gross / prev.units : 0;
  const pct = (c, p) => (p ? ((c - p) / p) * 100 : null);

  // ── Detail product search ──────────────────────────────────────────────────
  // One flat list carrying BOTH grains: a whole-product entry and each of its variants,
  // contiguous under a per-product `group` header (Combobox emits a header on change, so
  // same-group options must stay adjacent). Colour and model live in the label; the product
  // name and the codes ride in `search`, which is matched but never rendered — so typing a
  // product ("Flare"), a variant ("Base"), a colour ("Red") or a code all find the same rows.
  const productOptions = useMemo(() => {
    const byProduct = new Map();
    for (const v of variants) {
      const p = v.product || v.product_code;
      if (!p) continue;
      if (!byProduct.has(p)) byProduct.set(p, []);
      byProduct.get(p).push(v);
    }
    const out = [];
    for (const p of [...byProduct.keys()].sort((a, b) => a.localeCompare(b))) {
      const vs = byProduct.get(p);
      const codes = vs.map(v => v.product_code).filter(Boolean);
      out.push({
        value: `p:${p}`, label: p, group: p,
        hint: vs.length > 1 ? `all ${vs.length} variants` : 'all variants',
        search: [...vs.map(v => `${v.model || ''} ${v.color || ''} ${v.sku || ''}`), ...codes].join(' '),
      });
      for (const v of vs.sort((a, b) => `${a.model} ${a.color}`.localeCompare(`${b.model} ${b.color}`))) {
        const bits = [v.model, v.color].filter(Boolean).join(' · ');
        out.push({
          value: `v:${v.product_code}`, group: p,
          label: bits ? `${p} · ${bits}` : `${p} · ${v.product_code}`,
          hint: v.product_code,
          search: `${p} ${v.model || ''} ${v.color || ''} ${v.sku || ''} ${v.ean || ''}`,
        });
      }
    }
    return out;
  }, [variants]);

  // The set of product_codes the Detail table is restricted to — null when unfiltered.
  // Built from product_master, NOT from the codes present in `rows`, so selecting a product
  // that sold nothing in the range correctly yields an EMPTY table rather than silently
  // falling back to everything.
  const filterCodes = useMemo(() => {
    if (!productFilter) return null;
    if (productFilter.startsWith('v:')) return new Set([productFilter.slice(2)]);
    const p = productFilter.slice(2);
    return new Set(variants.filter(v => (v.product || v.product_code) === p).map(v => v.product_code));
  }, [productFilter, variants]);

  const filterLabel = useMemo(
    () => (productFilter ? (productOptions.find(o => o.value === productFilter)?.label || '') : ''),
    [productFilter, productOptions]);

  // drill table (re-aggregate rows on the chosen axis)
  const table = useMemo(() => {
    const agg = {};
    for (const r of rows) {
      if (filterCodes && !filterCodes.has(r.product_code)) continue;
      const prod = codeToProduct[r.product_code] || r.product_code;
      const key = group === 'date' ? r.sale_date : group === 'channel' ? r.channel_id : group === 'product' ? prod : r.product_code;
      const label = group === 'date' ? r.sale_date : group === 'channel' ? (chName[r.channel_id] || r.channel_id) : group === 'product' ? prod : (r.grp_label || r.product_code);
      const a = agg[key] || (agg[key] = { key, label, units: 0, gross: 0, disc: 0, retU: 0, retV: 0 });
      a.units += Number(r.units) || 0; a.gross += Number(r.gross_value) || 0;
      a.disc += Number(r.discount_value) || 0; a.retU += Number(r.returned_units) || 0; a.retV += Number(r.returned_value) || 0;
    }
    return Object.values(agg).sort((a, b) => b.gross - a.gross);
  }, [rows, group, chName, codeToProduct, filterCodes]);
  const tblSort = useTableSort(table, { initialKey: 'gross' });

  // Totals for the current Detail selection — the "how much has this product sold" answer,
  // summed off the same rows the table renders so the two can never disagree.
  const tableTotals = useMemo(() => table.reduce((a, r) => ({
    units: a.units + r.units, gross: a.gross + r.gross, retU: a.retU + r.retU,
  }), { units: 0, gross: 0, retU: 0 }), [table]);

  const orderedChannels = useMemo(() => [...channels].sort((a, b) =>
    (GROUP_ORDER.indexOf(channelGroup(a.name)) - GROUP_ORDER.indexOf(channelGroup(b.name))) || a.name.localeCompare(b.name)
  ), [channels]);

  const applyPreset = (p) => { setPreset(p.key); setFrom(p.from); setTo(p.to); };
  const setCustomFrom = v => { setFrom(v); setPreset(''); };
  const setCustomTo = v => { setTo(v); setPreset(''); };
  // One fetch, two formats. XLSX is preferred by finance (types survive: a 13-digit
  // EAN stays text instead of turning into 5.9e+12, and numbers arrive summable).
  const exportRows = (fmt) => salesGet('getSalesExport', { from, to, group, channel_id: sel.join(',') }, session)
    .then(r => {
      // The export is a SEPARATE fetch from the table, so the Detail product filter has to be
      // re-applied to it by hand. Without this the screen shows one product and the file
      // silently contains the whole catalogue under a filename that says otherwise.
      const rows = (r?.rows || []).filter(x => !filterCodes || filterCodes.has(x.product_code));
      const slug = filterLabel ? '_' + filterLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : '';
      const base = `odo_${group}${slug}_${from}_${to}`;
      if (fmt === 'xlsx') downloadXlsx(rows, `${base}.xlsx`, `Odo ${group}`);
      else downloadCsv(rows, `${base}.csv`);
    }).catch(() => {});
  const toggleCh = (id) => setSel(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);

  const ppLabel = preset ? `prior ${PRESETS.find(p => p.key === preset)?.label || ''}` : 'prior period';
  const rangeLabel = (preset && PRESETS.find(p => p.key === preset)?.label) || `${from} → ${to}`;

  // S294 — drill-through: a Detail row opens the order lines underneath that slice.
  // Params mirror what the row aggregated: axis value + the page's current range + channel filter.
  const openDrill = (r) => {
    const base = { from, to, channel_id: sel.join(',') };
    // On the date and channel axes the row carries no product of its own, so a Detail product
    // filter has to be threaded into the drill explicitly — otherwise clicking a filtered row
    // opens EVERY product's orders for that day/channel and the modal's total contradicts the
    // row it was opened from (the mismatch the DrillModal banner already warns about).
    const filtered = filterCodes ? [...filterCodes].join(',') : '';
    if (group === 'variant') setDrill({ title: `${r.label} · ${rangeLabel}`, params: { ...base, products: r.key } });
    else if (group === 'product') {
      const codes = Object.keys(codeToProduct).filter(c => codeToProduct[c] === r.key);
      setDrill({ title: `${r.label} · ${rangeLabel}`, params: { ...base, products: (codes.length ? codes : [r.key]).join(',') } });
    }
    else if (group === 'date') setDrill({ title: filterLabel ? `${filterLabel} · ${r.key}` : r.key, params: { ...base, from: r.key, to: r.key, ...(filtered ? { products: filtered } : {}) } });
    else setDrill({ title: `${filterLabel ? filterLabel + ' · ' : ''}${r.label} · ${rangeLabel}`, params: { ...base, channel_id: r.key, ...(filtered ? { products: filtered } : {}) } });
  };

  return (
    <div className="so-page">
      <PageHead
        title="Cross-channel dashboard"
        sub={<>Net revenue, mix and movers across every sales channel <span className="so-qual">· {rangeLabel}</span></>}
      />

      {/* controls — range + channel filter + export, one row. Stays a PAGE-LEVEL sticky
          header; never nest it inside a .so-card. */}
      <RangePicker from={from} to={to}
        onChange={({ from, to, preset }) => { setFrom(from); setTo(to); setPreset(preset); }}
        right={<>
          <ChannelFilter channels={orderedChannels} value={sel} onChange={setSel} />
          <button className="so-btn ghost" onClick={() => exportRows('xlsx')} disabled={!rows.length}>Export Excel</button>
          <button className="so-btn ghost" onClick={() => exportRows('csv')} disabled={!rows.length}>CSV</button>
        </>} />

      {err && <div className="so-card" style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 12 }}>{err}</div>}

      {loading && !rows.length ? <div style={{ padding: 60, textAlign: 'center' }}><Spinner /></div> : (
      <>
        {/* ── hero KPI 5-up — every tile owns a metric hue (handoff §3.4) ── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,minmax(0,1fr))', gap: 14 }}>
          {[
            { lbl: 'Net revenue (ex-GST)', val: inr(head.netExGst), d: pct(head.netExGst, headPrev.netExGst), spark: headDaily.net, hue: HUE.primary, sub: 'after disc · returns · GST', badge: <SettledBadge pct={head.settledPct} /> },
            { lbl: 'Gross sales', val: inr(head.grossAll), d: pct(head.grossAll, headPrev.grossAll), spark: headDaily.gross, hue: HUE.gross, sub: 'tax-incl · all channels' },
            { lbl: 'Units sold', val: fmtInt(head.units), d: pct(head.units, headPrev.units), spark: daySeries.units, hue: HUE.units },
            { lbl: 'Avg selling price', val: inr(curAsp), d: pct(curAsp, prevAsp), spark: daySeries.asp, hue: HUE.derived },
            { lbl: 'Active channels', val: fmtInt(activeChannels), d: pct(activeChannels, prevActive), spark: null, hue: HUE.count },
          ].map((k, i) => (
            <Kpi key={i} lbl={k.lbl} val={k.val} pct={k.d} sub={k.sub} badge={k.badge} spark={k.spark} hue={k.hue} deltaNote={`vs ${ppLabel}`} />
          ))}
        </div>

        {/* ── stacked family trend — the chart itself ships UNCHANGED (handoff §7).
               Only the panel around it is restyled; the chart's direct parent carries no
               backdrop-filter. ── */}
        <div className="so-card">
          <PanelHead
            style={{ marginBottom: 6 }}
            title={`Daily ${trendMetric === 'units' ? 'units' : 'gross'} by channel family`}
            right={
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', gap: 13, flexWrap: 'wrap' }}>
                  {GROUP_ORDER.filter(g => trend.days.some(d => (trend.dv[d]?.[g] || 0) > 0)).map(g => (
                    <span key={g} style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t2)' }}>
                      <Swatch color={GROUP_META[g].color} />{GROUP_META[g].label}
                    </span>
                  ))}
                </div>
                <SegmentedToggle options={['gross', 'units']} value={trendMetric} onChange={setTrendMetric} size="sm" />
              </div>
            } />
          <div>
            <StackedTrendChart days={trend.days} dayVals={trend.dv} metric={trendMetric}
              groups={GROUP_ORDER.map(k => ({ key: k, label: GROUP_META[k].label, color: GROUP_META[k].color }))} />
          </div>
        </div>

        {/* ── channel-mix donut + top variants ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>

          {/* channel mix — one donut arc per family, then the per-channel leaderboard */}
          <div className="so-card">
            <PanelHead title="Channel mix" qual="· gross share" />
            {channelBoard.arr.length === 0 ? <div style={EMPTY}>No sales in range.</div> : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 22, flexWrap: 'wrap' }}>
                <Donut segments={famMix.map(f => ({ key: f.key, label: f.label, value: f.value, color: f.color }))}
                  total={inr(cur.gross)} centerLabel="GROSS" />
                <div style={{ flex: 1, minWidth: 190, display: 'flex', flexDirection: 'column', gap: 9 }}>
                  {famMix.map(f => (
                    <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Swatch color={f.color} />
                      <span style={NAME}>{f.label}</span>
                      <span style={{ ...NUM, color: 'var(--t3)', width: 46 }}>{cur.gross ? ((f.value / cur.gross) * 100).toFixed(1) : '0.0'}%</span>
                      <span style={{ ...NUM, color: 'var(--t1-cell)', width: 78 }}>{inr(f.value)}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--row-border)' }}>
                <div className="so-eyebrow" style={{ marginBottom: 10 }}>By channel</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {channelBoard.arr.map(c => {
                    const share = cur.gross ? (c.gross / cur.gross) * 100 : 0;
                    return (
                      <div key={c.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <Swatch color={GROUP_META[c.gk].color} />
                          <span style={NAME}>{c.name}</span>
                          <Delta pct={pct(c.gross, c.prevGross)} />
                          <span style={{ ...NUM, color: 'var(--t3)', width: 38 }}>{share.toFixed(0)}%</span>
                          <span style={{ ...NUM, color: 'var(--t1-cell)', width: 78 }}>{inr(c.gross)}</span>
                        </div>
                        <Bar pct={(c.gross / channelBoard.max) * 100} color={GROUP_META[c.gk].color} />
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
            )}
          </div>

          {/* top sellers — ranking bars */}
          <div className="so-card">
            <PanelHead
              title={`Top ${sellerRollup === 'product' ? 'products' : 'variants'}`}
              right={
                <div style={{ display: 'flex', gap: 8 }}>
                  <SegmentedToggle options={[['variant', 'Variant'], ['product', 'Product']]} value={sellerRollup} onChange={setSellerRollup} size="sm" />
                  <SegmentedToggle options={['gross', 'units']} value={variantMetric} onChange={setVariantMetric} size="sm" />
                </div>
              } />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              {variantBoard.arr.length === 0 && <div style={EMPTY}>No sales in range.</div>}
              {variantBoard.arr.map(v => {
                const onUnits = variantMetric === 'units';
                const m = onUnits ? v.units : v.gross;
                // Both numbers show, but the SELECTED metric is the emphasised one (bright + wider
                // slot) and the other drops to secondary — otherwise the toggle changes the sort
                // without changing what the eye reads. ₹ keeps its 78px slot in both states so a
                // long value never spills into the name column.
                return (
                  <div key={v.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={NAME}>{v.label}</span>
                      <span style={{ ...NUM, color: onUnits ? 'var(--t1-cell)' : 'var(--t3)', fontWeight: onUnits ? 600 : 400, width: onUnits ? 78 : 54 }}>{fmtInt(v.units)}</span>
                      <span style={{ ...NUM, color: onUnits ? 'var(--t3)' : 'var(--t1-cell)', fontWeight: onUnits ? 400 : 600, width: 78 }}>{inr(v.gross)}</span>
                    </div>
                    <Bar pct={(m / variantBoard.max) * 100} color="linear-gradient(90deg,#4C63F0,#F2CD1A)" />
                  </div>
                );
              })}
            </div>

            {/* Accessories & others — ONE bundled MEMO line. Sits below the variant board on
                purpose: these are real sales that have no product variant (gift wrap, spares,
                paid repairs), so they can be seen without being attributed to a car. NOT in any
                total above — mapping them to variants would inflate variant units. */}
            {acc.failed && (
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)',
                            fontFamily: 'var(--ui)', fontSize: 11, color: 'var(--t3)' }}>
                Accessories &amp; others — <span style={{ color: STATUS.warn }}>couldn’t load</span>. The totals above are unaffected.
              </div>
            )}
            {!acc.failed && acc.total.gross > 0 && (
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ ...NAME, color: 'var(--t2)' }}>Accessories &amp; others</span>
                  <span style={{ ...NUM, color: 'var(--t3)', width: 54 }}>{fmtInt(acc.total.units)}</span>
                  <span style={{ ...NUM, color: 'var(--t2)', fontWeight: 600, width: 78 }}>{inr(acc.total.gross)}</span>
                </div>
                <div style={{ fontFamily: 'var(--ui)', fontSize: 10.5, color: 'var(--t3)', marginTop: 5, lineHeight: 1.5 }}>
                  {acc.rows.map(r => r.bucket).filter((v, i, a) => a.indexOf(v) === i).join(' · ')}
                  {' — '}{fmtInt(acc.total.skus)} unmapped SKUs.{' '}
                  <b style={{ color: 'var(--t2)' }}>Memo only — not counted in the totals above.</b>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── movers + connector health ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16 }}>

          <div className="so-card">
            <PanelHead title="Movers" qual={`· gross ₹ vs ${ppLabel}`} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 22 }}>
              {[['Gaining', movers.up, STATUS.good], ['Slipping', movers.down, STATUS.bad]].map(([title, list, color]) => (
                <div key={title} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{title}</div>
                  {list.length === 0 && <Nil />}
                  {list.map(m => (
                    <div key={m.code} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={NAME}>{m.label}</span>
                      <span style={{ ...NUM, color, width: 84 }}>{m.delta >= 0 ? '+' : '−'}{inr(Math.abs(m.delta))}</span>
                      <span style={{ ...NUM, color: 'var(--t5)', width: 52 }}>{m.pct == null ? 'new' : `${m.pct >= 0 ? '+' : ''}${m.pct.toFixed(0)}%`}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>

          <div className="so-card">
            <PanelHead title="Connector health" right={
              <a href="/mapping" style={{ fontFamily: 'var(--mono)', fontSize: 10, color: unmappedCount ? 'var(--amber)' : 'var(--t3)', border: `1px solid ${unmappedCount ? 'rgba(245,158,11,.4)' : 'var(--border-ctl)'}`, borderRadius: 'var(--r-pill)', padding: '3px 10px', whiteSpace: 'nowrap' }}>
                {unmappedCount} unmapped SKU{unmappedCount === 1 ? '' : 's'}{unmappedCount ? ' →' : ''}
              </a>
            } />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {health.length === 0 && <div style={EMPTY}>No connectors enabled.</div>}
              {health.map(c => {
                const gk = channelGroup(c.name || '');
                const sc = HEALTH_COLOR[c.statusKey];
                return (
                  <div key={c.channel_id} title={c.last_error || ''}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--control)', border: '1px solid var(--border-ctl)', borderRadius: 'var(--r-md)', padding: '6px 10px' }}>
                    <Swatch color={GROUP_META[gk].color} />
                    <span style={{ fontFamily: 'var(--ui)', fontSize: 12, color: 'var(--t1)' }}>{c.name}</span>
                    <span className="so-dot" style={{ width: 6, height: 6, background: sc, boxShadow: `0 0 7px 0 ${sc}` }} />
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t5)' }}>{ago(c.last_ok_at)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* ── drill table ── */}
        <div className="so-card flush">
          <PanelHead title="Detail" style={{ marginBottom: 0 }}
            qual={filterLabel ? `· ${filterLabel}` : undefined}
            right={
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                {/* `portal` is REQUIRED here — the dropdown lives inside .so-card, which clips
                    and establishes its own stacking/transform context (PATTERN-160). */}
                <div style={{ minWidth: 250 }}>
                  <Combobox options={productOptions} value={productFilter} onChange={setProductFilter}
                    placeholder="Search product, variant or colour…" portal />
                </div>
                <SegmentedToggle options={GROUPS.map(g => [g.key, g.label])} value={group} onChange={setGroup} size="sm" />
              </div>
            } />
          {filterLabel && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
              padding: '8px 14px', borderBottom: '1px solid var(--border)',
              fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>
              <span><b style={{ color: 'var(--t1)' }}>{fmtInt(tableTotals.units)}</b> units</span>
              <span><b style={{ color: 'var(--t1)' }}>{inr(tableTotals.gross)}</b> gross</span>
              {tableTotals.retU > 0 && <span>{fmtInt(tableTotals.retU)} returned</span>}
              <span style={{ color: 'var(--t4)' }}>· {rangeLabel} · this panel only, the figures above are all products</span>
              <button className="so-btn ghost" style={{ marginLeft: 'auto' }} onClick={() => setProductFilter('')}>Clear</button>
            </div>
          )}
          {table.length === 0 ? (
            <div style={{ ...EMPTY, padding: 36, textAlign: 'center' }}>
              {filterLabel
                ? <>No sales of <b style={{ color: 'var(--t2)' }}>{filterLabel}</b> in this range. Widen the range, clear the channel filter, or check it is mapped under <b style={{ color: 'var(--t2)' }}>Mapping</b>.</>
                : <>No sales for this range yet. Pull a channel from <b style={{ color: 'var(--t2)' }}>Connectors</b> or upload a report from <b style={{ color: 'var(--t2)' }}>Uploads</b>.</>}
            </div>
          ) : (
            <table className="so-table">
              <thead><tr>
                <SortHeader k="label" label={group === 'date' ? 'Day' : group === 'channel' ? 'Channel' : group === 'product' ? 'Product' : 'Variant'} sort={tblSort} />
                <SortHeader k="units" label="Units" sort={tblSort} numeric />
                <SortHeader k="gross" label="Gross ₹" sort={tblSort} numeric />
                <SortHeader k="disc" label="Disc ₹" sort={tblSort} numeric />
                <SortHeader k="retU" label="Ret u" sort={tblSort} numeric />
                <SortHeader k="retV" label="Ret ₹" sort={tblSort} numeric />
              </tr></thead>
              <tbody>
                {tblSort.sorted.map(r => (
                  <tr key={r.key} onClick={() => openDrill(r)} style={{ cursor: 'pointer' }}
                      title="View underlying orders">
                    <td>
                      {group === 'channel' ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                          <Swatch color={GROUP_META[channelGroup(r.label)].color} />{r.label}
                        </span>
                      ) : group === 'date' ? (
                        <span style={{ fontFamily: 'var(--mono)', fontVariantNumeric: 'tabular-nums' }}>{r.label}</span>
                      ) : r.label}
                    </td>
                    <td className="so-num">{fmtInt(r.units)}</td>
                    <td className="so-num bright">{inr(r.gross)}</td>
                    <td className="so-num">{r.disc ? inr(r.disc) : <Nil />}</td>
                    <td className="so-num">{r.retU ? fmtInt(r.retU) : <Nil />}</td>
                    <td className="so-num">{r.retV ? inr(r.retV) : <Nil />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {drill && (
          <DrillModal title={drill.title} params={drill.params} session={session}
            chName={chName} codeToProduct={codeToProduct} onClose={() => setDrill(null)} />
        )}
      </>
      )}
    </div>
  );
}

// S294 — underlying orders for one Detail slice. Line grain straight off staging (the same rows
// recompute_facts aggregates), so the modal's sale total always matches the cell it was opened from.
const DRILL_LIMIT = 1000;
function DrillModal({ title, params, session, chName, codeToProduct, onClose }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let dead = false;
    salesGet('getCellOrders', { ...params, limit: DRILL_LIMIT }, session)
      .then(r => { if (!dead) setRows(r?.rows || []); })
      .catch(e => { if (!dead) { setErr(String(e?.message || e)); setRows([]); } });
    return () => { dead = true; };
  }, [params, session]);

  const sale = (rows || []).filter(r => r.row_type === 'sale' && !r.is_cancelled);
  const units = sale.reduce((a, r) => a + (Number(r.qty) || 0), 0);
  const gross = sale.reduce((a, r) => a + (Number(r.gross_value) || 0), 0);

  return (
    <Modal open title={`Orders — ${title}`} onClose={onClose} size="lg">
      {rows === null ? <div style={{ padding: 40, textAlign: 'center' }}><Spinner /></div> : (
        <>
          <div style={{ display: 'flex', gap: 16, marginBottom: 10, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>
            {/* On a truncated slice the sums cover only the fetched lines — say so, or the number
                reads as a mismatch against the Detail row it was opened from. */}
            {rows.length >= DRILL_LIMIT
              ? <span style={{ color: 'var(--amber, #d97706)' }}>showing first {DRILL_LIMIT} lines ({fmtInt(units)} units · {inr(gross)} of the row's total) — narrow the range for the rest</span>
              : <span>{fmtInt(units)} units · {inr(gross)} live sale value</span>}
            {err && <span style={{ color: 'var(--red)' }}>{err}</span>}
          </div>
          {rows.length === 0 ? (
            <div style={{ ...EMPTY, padding: 24, textAlign: 'center' }}>No staged order lines for this slice.</div>
          ) : (
            <div style={{ maxHeight: '60vh', overflow: 'auto' }}>
              <table className="so-table">
                <thead><tr>
                  <th>Date</th><th>Order</th><th>Channel</th><th>Variant</th>
                  <th className="so-num">Qty</th><th className="so-num">Gross ₹</th><th>Status</th>
                </tr></thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} style={r.is_cancelled || r.row_type === 'return' ? { opacity: 0.55 } : undefined}>
                      <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{r.sale_date}</td>
                      <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>
                        {r.order_ref || r.source_order_id || <span style={{ color: 'var(--t5)' }}>report row</span>}
                      </td>
                      <td style={{ fontSize: 11 }}>{chName[r.channel_id] || '—'}</td>
                      <td style={{ fontSize: 11 }} title={r.channel_sku}>
                        {r.product_code}{codeToProduct[r.product_code] ? ` · ${codeToProduct[r.product_code]}` : ''}
                      </td>
                      <td className="so-num">{fmtInt(r.qty)}</td>
                      <td className="so-num bright">{inr(Number(r.gross_value) || 0)}</td>
                      <td style={{ fontFamily: 'var(--mono)', fontSize: 10 }}>
                        {r.row_type === 'return' ? <span style={{ color: 'var(--red)' }}>RETURN</span>
                          : r.is_cancelled ? <span style={{ color: 'var(--t5)' }}>CANCELLED</span>
                          : <span style={{ color: 'var(--t4)' }}>SALE</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
