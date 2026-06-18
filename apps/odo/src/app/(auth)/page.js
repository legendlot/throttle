'use client';
import { useEffect, useMemo, useState, useRef } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { salesGet, inr, fmtInt, istToday, istDaysAgo, downloadCsv, rangePresets, priorPeriod } from '../../lib/api.js';

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
const HEALTH_COLOR = { ok: 'var(--green)', partial: 'var(--amber)', error: 'var(--red)', never: 'var(--t3)' };

// Channel families — drive both the chart colours and the chip ordering.
const GROUP_META = {
  marketplace: { label: 'Marketplaces', color: '#4C63F0' },
  quickcom:    { label: 'Quick-com',    color: '#34D27B' },
  website:     { label: 'Website',      color: '#F2CD1A' },
  gtmt:        { label: 'GT / MT',      color: '#F59E0B' },
  other:       { label: 'Other',        color: '#8A8C95' },
};
const GROUP_ORDER = ['marketplace', 'quickcom', 'website', 'gtmt', 'other'];
function channelGroup(name) {
  const n = (name || '').toLowerCase();
  if (/amazon|flipkart/.test(n)) return 'marketplace';
  if (/blinkit|zepto|instamart|swiggy|quick/.test(n)) return 'quickcom';
  if (/website|shopify|web/.test(n)) return 'website';
  if (n === 'gt' || n === 'mt' || /general trade|modern trade/.test(n)) return 'gtmt';
  return 'other';
}

const PRESETS = rangePresets();

// ── tiny inline charts (dependency-free, theme-coloured) ──
function Spark({ data, color }) {
  if (!data || data.length < 2) return <div style={{ height: 30 }} />;
  const W = 130, H = 30, max = Math.max(...data), min = Math.min(...data, 0), span = (max - min) || 1;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * W},${H - ((v - min) / span) * (H - 2) - 1}`);
  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: 'block' }}>
      <polyline points={`0,${H} ${pts.join(' ')} ${W},${H}`} fill={color} fillOpacity="0.10" stroke="none" />
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Delta({ pct }) {
  if (pct == null || !isFinite(pct)) return null;
  const up = pct >= 0;
  return (
    <span style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600, color: up ? 'var(--green)' : 'var(--red)' }}>
      {up ? '▲' : '▼'} {Math.abs(pct).toFixed(0)}%
    </span>
  );
}

function TrendChart({ days, dayVals, metric }) {
  const [hi, setHi] = useState(null);
  const ref = useRef(null);
  if (!days || days.length < 2) {
    return <div style={{ padding: 32, textAlign: 'center', color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 12 }}>Pick a range of 2+ days to see the trend.</div>;
  }
  const W = 1000, H = 230, padT = 10, padB = 2;
  const n = days.length;
  const totals = days.map(d => GROUP_ORDER.reduce((s, g) => s + (dayVals[d]?.[g] || 0), 0));
  const maxTotal = Math.max(...totals, 1);
  const x = i => (i / (n - 1)) * W;
  const y = v => padT + (1 - v / maxTotal) * (H - padT - padB);
  const activeGroups = GROUP_ORDER.filter(g => days.some(d => (dayVals[d]?.[g] || 0) > 0));

  const areas = []; const cum = days.map(() => 0);
  for (const g of activeGroups) {
    const top = days.map((d, i) => cum[i] + (dayVals[d]?.[g] || 0));
    const topPts = top.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    const botPts = cum.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).reverse();
    areas.push({ g, d: `M ${topPts.join(' L ')} L ${botPts.join(' L ')} Z` });
    for (let i = 0; i < n; i++) cum[i] = top[i];
  }
  const fmt = v => metric === 'units' ? fmtInt(v) : inr(v);
  const onMove = e => {
    const r = ref.current?.getBoundingClientRect(); if (!r) return;
    setHi(Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * (n - 1)))));
  };
  const labelIdx = [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i);

  return (
    <div ref={ref} style={{ position: 'relative' }} onMouseMove={onMove} onMouseLeave={() => setHi(null)}>
      <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: 'block' }}>
        {areas.map(a => <path key={a.g} d={a.d} fill={GROUP_META[a.g].color} fillOpacity="0.82" />)}
        {hi != null && <line x1={x(hi)} x2={x(hi)} y1={padT} y2={H - padB} stroke="var(--t1)" strokeWidth="1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" opacity="0.5" />}
      </svg>
      {/* x labels */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--t3)' }}>
        {labelIdx.map(i => <span key={i}>{days[i]}</span>)}
      </div>
      {/* hover tooltip */}
      {hi != null && (() => {
        const left = (x(hi) / W) * 100;
        const flip = left > 60;
        return (
          <div style={{ position: 'absolute', top: 6, left: `${left}%`, transform: `translateX(${flip ? '-104%' : '4%'})`, background: 'var(--surface2)', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '8px 10px', pointerEvents: 'none', minWidth: 150, boxShadow: 'var(--shadow)', zIndex: 5 }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--t2)', marginBottom: 5 }}>{days[hi]}</div>
            {activeGroups.slice().reverse().map(g => {
              const v = dayVals[days[hi]]?.[g] || 0; if (!v) return null;
              return (
                <div key={g} style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--mono)', fontSize: 11, marginBottom: 2 }}>
                  <span className="so-dot" style={{ background: GROUP_META[g].color }} />
                  <span style={{ color: 'var(--t2)', flex: 1 }}>{GROUP_META[g].label}</span>
                  <span style={{ color: 'var(--t1)' }}>{fmt(v)}</span>
                </div>
              );
            })}
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, borderTop: '1px solid var(--border)', marginTop: 5, paddingTop: 4, fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600 }}>
              <span style={{ color: 'var(--t2)' }}>Total</span><span style={{ color: 'var(--t1)' }}>{fmt(totals[hi])}</span>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

export default function Dashboard() {
  const { session } = useAuth();
  const [channels, setChannels] = useState([]);
  const [sel, setSel] = useState([]);            // selected channel ids ([] = all)
  const [preset, setPreset] = useState('30d');
  const [from, setFrom] = useState(istDaysAgo(29));
  const [to, setTo] = useState(istToday());
  const [group, setGroup] = useState('variant'); // drill table axis
  const [trendMetric, setTrendMetric] = useState('gross');
  const [variantMetric, setVariantMetric] = useState('gross');
  const [sellerRollup, setSellerRollup] = useState('variant'); // variant | product
  const [connectors, setConnectors] = useState([]);
  const [unmappedCount, setUnmappedCount] = useState(0);
  const [codeToProduct, setCodeToProduct] = useState({});
  const [rows, setRows] = useState([]);
  const [prevRows, setPrevRows] = useState([]);
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
      .then(r => { const m = {}; (r?.rows || []).forEach(v => { m[v.product_code] = v.product; }); setCodeToProduct(m); })
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
    ]).then(([cur, prev]) => { setRows(cur?.rows || []); setPrevRows(prev?.rows || []); })
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

  // drill table (re-aggregate rows on the chosen axis)
  const table = useMemo(() => {
    const agg = {};
    for (const r of rows) {
      const prod = codeToProduct[r.product_code] || r.product_code;
      const key = group === 'date' ? r.sale_date : group === 'channel' ? r.channel_id : group === 'product' ? prod : r.product_code;
      const label = group === 'date' ? r.sale_date : group === 'channel' ? (chName[r.channel_id] || r.channel_id) : group === 'product' ? prod : (r.grp_label || r.product_code);
      const a = agg[key] || (agg[key] = { key, label, units: 0, gross: 0 });
      a.units += Number(r.units) || 0; a.gross += Number(r.gross_value) || 0;
    }
    return Object.values(agg).sort((a, b) => b.gross - a.gross);
  }, [rows, group, chName, codeToProduct]);

  const orderedChannels = useMemo(() => [...channels].sort((a, b) =>
    (GROUP_ORDER.indexOf(channelGroup(a.name)) - GROUP_ORDER.indexOf(channelGroup(b.name))) || a.name.localeCompare(b.name)
  ), [channels]);

  const applyPreset = (p) => { setPreset(p.key); setFrom(p.from); setTo(p.to); };
  const setCustomFrom = v => { setFrom(v); setPreset(''); };
  const setCustomTo = v => { setTo(v); setPreset(''); };
  const exportCsv = () => salesGet('getSalesExport', { from, to, group, channel_id: sel.join(',') }, session)
    .then(r => downloadCsv(r?.rows || [], `odo_${group}_${from}_${to}.csv`)).catch(() => {});
  const toggleCh = (id) => setSel(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);

  const ppLabel = preset ? `prior ${PRESETS.find(p => p.key === preset)?.label || ''}` : 'prior period';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 1320 }}>
      {/* controls */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 4, background: 'var(--surface2)', borderRadius: 8, padding: 3 }}>
          {PRESETS.map(p => (
            <button key={p.key} onClick={() => applyPreset(p)}
              style={{ background: preset === p.key ? 'var(--accent)' : 'transparent', color: preset === p.key ? 'var(--accent-fg)' : 'var(--t2)', border: 'none', borderRadius: 6, padding: '7px 11px', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer' }}>
              {p.label}
            </button>
          ))}
        </div>
        <input className="so-input" type="date" value={from} max={to} onChange={e => setCustomFrom(e.target.value)} />
        <span style={{ color: 'var(--t3)' }}>→</span>
        <input className="so-input" type="date" value={to} min={from} max={istToday()} onChange={e => setCustomTo(e.target.value)} />
        <div style={{ flex: 1 }} />
        <button className="so-btn ghost" onClick={exportCsv} disabled={!rows.length}>Export CSV</button>
      </div>

      {/* channel chips (ordered + colour-dotted by family) */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
        <span className={`so-chip${sel.length === 0 ? ' on' : ''}`} onClick={() => setSel([])}>All channels</span>
        {orderedChannels.map(c => (
          <span key={c.channel_id} className={`so-chip${sel.includes(c.channel_id) ? ' on' : ''}`} onClick={() => toggleCh(c.channel_id)}>
            <span className="so-dot" style={{ background: GROUP_META[channelGroup(c.name)].color }} />{c.name}
          </span>
        ))}
      </div>

      {err && <div className="so-card" style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 12 }}>{err}</div>}

      {loading && !rows.length ? <div style={{ padding: 60, textAlign: 'center' }}><Spinner /></div> : (
      <>
        {/* KPI hero row */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 14 }}>
          {[
            { lbl: 'Gross sales', val: inr(cur.gross), d: pct(cur.gross, prev.gross), spark: daySeries.gross, color: 'var(--accent)' },
            { lbl: 'Units sold', val: fmtInt(cur.units), d: pct(cur.units, prev.units), spark: daySeries.units, color: 'var(--blue)' },
            { lbl: 'Avg selling price', val: inr(curAsp), d: pct(curAsp, prevAsp), spark: daySeries.asp, color: 'var(--green)' },
            { lbl: 'Active channels', val: fmtInt(activeChannels), d: pct(activeChannels, prevActive), spark: null, color: 'var(--t2)' },
          ].map((k, i) => (
            <div key={i} className="so-card" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div className="so-kpi-lbl">{k.lbl}</div>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                <span className="so-kpi-val">{k.val}</span><Delta pct={k.d} />
              </div>
              <Spark data={k.spark} color={k.color} />
              <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--t3)' }}>vs {ppLabel}</div>
            </div>
          ))}
        </div>

        {/* trend */}
        <div className="so-card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 10 }}>
            <div className="so-kpi-lbl" style={{ margin: 0 }}>Daily {trendMetric === 'units' ? 'units' : 'gross'} by channel family</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', gap: 12 }}>
                {GROUP_ORDER.filter(g => trend.days.some(d => (trend.dv[d]?.[g] || 0) > 0)).map(g => (
                  <span key={g} style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--t2)' }}>
                    <span className="so-dot" style={{ background: GROUP_META[g].color }} />{GROUP_META[g].label}
                  </span>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 4, background: 'var(--surface2)', borderRadius: 7, padding: 3 }}>
                {['gross', 'units'].map(m => (
                  <button key={m} onClick={() => setTrendMetric(m)}
                    style={{ background: trendMetric === m ? 'var(--accent)' : 'transparent', color: trendMetric === m ? 'var(--accent-fg)' : 'var(--t2)', border: 'none', borderRadius: 5, padding: '5px 10px', fontFamily: 'var(--mono)', fontSize: 10.5, cursor: 'pointer', textTransform: 'capitalize' }}>{m}</button>
                ))}
              </div>
            </div>
          </div>
          <TrendChart days={trend.days} dayVals={trend.dv} metric={trendMetric} />
        </div>

        {/* channel mix + top variants */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(380px,1fr))', gap: 14 }}>
          {/* channel leaderboard */}
          <div className="so-card">
            <div className="so-kpi-lbl">Channel mix</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
              {channelBoard.arr.length === 0 && <div style={{ color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 12 }}>No sales in range.</div>}
              {channelBoard.arr.map(c => {
                const share = cur.gross ? (c.gross / cur.gross) * 100 : 0;
                return (
                  <div key={c.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--mono)', fontSize: 11.5 }}>
                      <span className="so-dot" style={{ background: GROUP_META[c.gk].color }} />
                      <span style={{ color: 'var(--t1)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                      <Delta pct={pct(c.gross, c.prevGross)} />
                      <span style={{ color: 'var(--t3)', width: 38, textAlign: 'right' }}>{share.toFixed(0)}%</span>
                      <span style={{ color: 'var(--t1)', width: 80, textAlign: 'right' }}>{inr(c.gross)}</span>
                    </div>
                    <div style={{ height: 6, background: 'var(--surface2)', borderRadius: 4, overflow: 'hidden' }}>
                      <div style={{ width: `${(c.gross / channelBoard.max) * 100}%`, height: '100%', background: GROUP_META[c.gk].color }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* top sellers */}
          <div className="so-card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <div className="so-kpi-lbl" style={{ margin: 0 }}>Top {sellerRollup === 'product' ? 'products' : 'variants'}</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ display: 'flex', gap: 4, background: 'var(--surface2)', borderRadius: 7, padding: 3 }}>
                  {[['variant', 'Variant'], ['product', 'Product']].map(([k, l]) => (
                    <button key={k} onClick={() => setSellerRollup(k)}
                      style={{ background: sellerRollup === k ? 'var(--accent)' : 'transparent', color: sellerRollup === k ? 'var(--accent-fg)' : 'var(--t2)', border: 'none', borderRadius: 5, padding: '5px 10px', fontFamily: 'var(--mono)', fontSize: 10.5, cursor: 'pointer' }}>{l}</button>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 4, background: 'var(--surface2)', borderRadius: 7, padding: 3 }}>
                  {['gross', 'units'].map(m => (
                    <button key={m} onClick={() => setVariantMetric(m)}
                      style={{ background: variantMetric === m ? 'var(--accent)' : 'transparent', color: variantMetric === m ? 'var(--accent-fg)' : 'var(--t2)', border: 'none', borderRadius: 5, padding: '5px 10px', fontFamily: 'var(--mono)', fontSize: 10.5, cursor: 'pointer', textTransform: 'capitalize' }}>{m}</button>
                  ))}
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9, marginTop: 12 }}>
              {variantBoard.arr.length === 0 && <div style={{ color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 12 }}>No sales in range.</div>}
              {variantBoard.arr.map(v => {
                const m = variantMetric === 'units' ? v.units : v.gross;
                return (
                  <div key={v.code} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--mono)', fontSize: 11.5 }}>
                      <span style={{ color: 'var(--t1)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.label}</span>
                      <span style={{ color: 'var(--t1)', width: 90, textAlign: 'right' }}>{variantMetric === 'units' ? fmtInt(v.units) : inr(v.gross)}</span>
                    </div>
                    <div style={{ height: 6, background: 'var(--surface2)', borderRadius: 4, overflow: 'hidden' }}>
                      <div style={{ width: `${(m / variantBoard.max) * 100}%`, height: '100%', background: 'var(--accent)' }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* movers */}
        <div className="so-card">
          <div className="so-kpi-lbl">Movers <span style={{ textTransform: 'none', letterSpacing: 0, color: 'var(--t3)' }}>· gross ₹ vs {ppLabel}</span></div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 22, marginTop: 12 }}>
            {[['Gaining', movers.up, 'var(--green)'], ['Slipping', movers.down, 'var(--red)']].map(([title, list, color]) => (
              <div key={title} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{title}</div>
                {list.length === 0 && <div style={{ color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 11.5 }}>—</div>}
                {list.map(m => (
                  <div key={m.code} style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--mono)', fontSize: 11.5 }}>
                    <span style={{ color: 'var(--t1)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.label}</span>
                    <span style={{ color, width: 86, textAlign: 'right' }}>{m.delta >= 0 ? '+' : '−'}{inr(Math.abs(m.delta))}</span>
                    <span style={{ color: 'var(--t3)', width: 56, textAlign: 'right' }}>{m.pct == null ? 'new' : `${m.pct >= 0 ? '+' : ''}${m.pct.toFixed(0)}%`}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* connector health */}
        <div className="so-card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            <div className="so-kpi-lbl" style={{ margin: 0 }}>Connector health</div>
            <a href="/mapping" style={{ fontFamily: 'var(--mono)', fontSize: 11, color: unmappedCount ? 'var(--amber)' : 'var(--t3)', border: `1px solid ${unmappedCount ? 'var(--amber)' : 'var(--border-strong)'}`, borderRadius: 999, padding: '3px 10px' }}>
              {unmappedCount} unmapped SKU{unmappedCount === 1 ? '' : 's'}{unmappedCount ? ' →' : ''}
            </a>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {health.length === 0 && <div style={{ color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 11.5 }}>No connectors enabled.</div>}
            {health.map(c => (
              <div key={c.channel_id} title={c.last_error || ''} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: '7px 11px' }}>
                <span className="so-dot" style={{ background: HEALTH_COLOR[c.statusKey] }} />
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--t1)' }}>{c.name}</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--t3)' }}>{ago(c.last_ok_at)}</span>
              </div>
            ))}
          </div>
        </div>

        {/* drill table */}
        <div className="so-card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
            <div className="so-kpi-lbl" style={{ margin: 0 }}>Detail</div>
            <div style={{ display: 'flex', gap: 4, background: 'var(--surface2)', borderRadius: 7, padding: 3 }}>
              {GROUPS.map(g => (
                <button key={g.key} onClick={() => setGroup(g.key)}
                  style={{ background: group === g.key ? 'var(--accent)' : 'transparent', color: group === g.key ? 'var(--accent-fg)' : 'var(--t2)', border: 'none', borderRadius: 5, padding: '5px 11px', fontFamily: 'var(--mono)', fontSize: 10.5, cursor: 'pointer' }}>{g.label}</button>
              ))}
            </div>
          </div>
          {table.length === 0 ? (
            <div style={{ padding: 36, textAlign: 'center', color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 12 }}>
              No sales for this range yet. Pull a channel from <b style={{ color: 'var(--t2)' }}>Connectors</b> or upload a report from <b style={{ color: 'var(--t2)' }}>Uploads</b>.
            </div>
          ) : (
            <table className="so-table">
              <thead><tr>
                <th>{group === 'date' ? 'Day' : group === 'channel' ? 'Channel' : group === 'product' ? 'Product' : 'Variant'}</th>
                <th className="so-num">Units</th>
                <th className="so-num">Gross ₹</th>
              </tr></thead>
              <tbody>
                {table.map(r => (
                  <tr key={r.key}>
                    <td style={{ color: 'var(--t1)' }}>{r.label}</td>
                    <td className="so-num">{fmtInt(r.units)}</td>
                    <td className="so-num">{inr(r.gross)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </>
      )}
    </div>
  );
}
