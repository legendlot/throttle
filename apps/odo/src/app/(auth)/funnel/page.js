'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { salesGet, fmtInt, inr, rangePresets } from '../../../lib/api.js';
import { RangePicker, SegmentedToggle, useTableSort, SortHeader } from '../../../components/kit.js';
import { PageHead, PanelHead, Pill, Bar, Nil } from '../../../components/prism.js';
import { HUE, hueStyle, rgb, STATUS } from '../../../lib/hues.js';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine } from 'recharts';

const numfmt = n => Number(n || 0).toLocaleString('en-IN');
const pctOf = (n, d) => (d > 0 ? (n / d * 100) : 0);
const fmtPct = n => `${+Number(n || 0).toFixed(2)}%`;   // up to 2 decimals, no trailing zeros

// Per-cell day-over-day ticker: ▲/▼ (+ % change) of this column vs the PREVIOUS DAY's value.
// Green = above yesterday, red = below, grey dash = unchanged. `prev` is the prior day's cell
// value (null on the first day / when the prior day isn't in range → renders nothing).
function Tick({ now, prev }) {
  if (prev == null || prev === '') return null;
  const n = Number(now) || 0, p = Number(prev) || 0;
  if (n === p) return <span style={{ marginLeft: 6, fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--t5)' }}>–</span>;
  const up = n > p;
  const pct = p !== 0 ? Math.abs((n - p) / p * 100) : 100;
  return (
    <span style={{ marginLeft: 6, fontFamily: 'var(--mono)', fontSize: 9.5, color: up ? STATUS.good : STATUS.bad, whiteSpace: 'nowrap' }}>
      {up ? '▲' : '▼'}{pct >= 0.5 ? ` ${pct.toFixed(pct < 10 ? 1 : 0)}%` : ''}
    </span>
  );
}

// Stepped conversion funnel: each stage's bar is sized to its share of Sessions, with the
// step-to-step conversion rate called out between stages. The drop-off is the story.
// 38px rows, gradient hue → hue@55%, count left / share right (handoff §6.8).
function Funnel({ steps }) {
  const top = steps[0]?.value || 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {steps.map((s, i) => {
        const share = top > 0 ? (s.value / top) * 100 : 0;
        const stepConv = i > 0 ? pctOf(s.value, steps[i - 1].value) : null;
        return (
          <div key={s.key}>
            {i > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', marginLeft: 110 }}>
                <span style={{ color: 'var(--t5)', fontSize: 13 }}>↳</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: stepConv >= 50 ? STATUS.good : stepConv >= 20 ? STATUS.warn : 'var(--t2)' }}>
                  {fmtPct(stepConv)}
                </span>
                <span className="so-sub" style={{ fontSize: 11.5, color: 'var(--t3)' }}>continue to {s.label.toLowerCase()}</span>
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <div style={{ width: 96, flex: 'none', fontFamily: 'var(--ui)', fontSize: 12.5, color: 'var(--t2)', textAlign: 'right' }}>{s.label}</div>
              <div style={{ flex: 1, position: 'relative', height: 38, background: 'rgba(255,255,255,.045)', borderRadius: 9, overflow: 'hidden' }}>
                <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${Math.max(share, 0)}%`, background: `linear-gradient(90deg, ${s.color}, rgba(${rgb(s.color)},.55))`, borderRadius: 9 }} />
                {/* Ink has to follow the FILL, not the row: the step colours (#F2CD1A → #F59E0B →
                    #FF7A1A → #34D27B) are all light, so near-white text over the filled part is
                    ~1.2:1. The count sits at the left edge and is therefore always over the fill →
                    dark ink. The share sits at the right edge and is only over the fill when the bar
                    is nearly full (the first step is always 100%). */}
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 13px' }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 700, color: share > 6 ? 'var(--accent-fg)' : 'var(--t1)' }}>{numfmt(s.value)}</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600, color: share > 92 ? 'var(--accent-fg)' : 'var(--t2-cell)' }}>{fmtPct(share)}</span>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Daily conversion-rate trend (Recharts — axes + hover tooltip, consistent with the app's other
// charts). Website-change events overlay as reference lines; the tooltip shows the exact CR%, the
// day's funnel counts, and any change that shipped that day.
// ⚠ Handoff §7: this chart keeps its own literal palette (same hexes the untouched
// StackedTrendChart uses) — only the panel AROUND it was reskinned. Do not harmonise it
// with the new token ramp, and do not put backdrop-filter on its direct parent.
const C_GRID = '#33343D', C_T2 = '#A4A6AE', C_T3 = '#6E6F79', C_SURFACE2 = '#26272E', C_GREEN = '#34D27B', C_ACCENT = '#F2CD1A', C_STOCK = '#2DA8F0', C_RED = '#EC6A5E';
const mmdd = d => (d ? String(d).slice(5) : '');
function DailyTrend({ rows, changes = [] }) {
  if (!rows || rows.length < 2) return <div className="so-sub" style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)', padding: '20px 0' }}>Not enough days in this range yet — widen it.</div>;
  const data = rows.map(r => ({ date: r.the_date, cr: Number(r.purchase_cr) || 0, sessions: Number(r.sessions) || 0, atc: Number(r.add_to_carts) || 0, checkout: Number(r.checkouts) || 0, purchases: Number(r.purchases) || 0 }));
  const avg = data.reduce((a, b) => a + b.cr, 0) / data.length;
  const byDate = {}; (changes || []).forEach(c => { (byDate[c.the_date] = byDate[c.the_date] || []).push(c); });
  const TT = ({ active, payload, label }) => {
    if (!active || !payload || !payload.length) return null;
    const d = payload[0].payload, chg = byDate[label] || [];
    const row = (k, v, color) => (
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, marginBottom: 2 }}>
        <span style={{ color: C_T2 }}>{k}</span><span style={{ color: color || '#F2F3F0' }}>{v}</span>
      </div>
    );
    return (
      <div style={{ background: C_SURFACE2, border: `1px solid ${C_GRID}`, borderRadius: 8, padding: '9px 11px', fontFamily: 'var(--mono)', fontSize: 11.5, minWidth: 168, boxShadow: '0 8px 24px rgba(0,0,0,0.45)' }}>
        <div style={{ color: C_T2, marginBottom: 5, fontSize: 10.5 }}>{label}</div>
        {row('Conv. rate', `${d.cr.toFixed(2)}%`, C_GREEN)}
        {row('Sessions', d.sessions.toLocaleString('en-IN'))}
        {row('Add to cart', d.atc.toLocaleString('en-IN'))}
        {row('Checkout', d.checkout.toLocaleString('en-IN'))}
        {row('Purchases', d.purchases.toLocaleString('en-IN'))}
        {chg.map(c => { const k = catKey(c.stream, c.status); return (
          <div key={c.id} style={{ display: 'flex', gap: 6, marginTop: 5, paddingTop: 5, borderTop: `1px solid ${C_GRID}`, color: CAT[k].color, maxWidth: 230 }}>
            <span>{CAT[k].arrow}</span><span style={{ color: '#F2F3F0', whiteSpace: 'normal' }}>{c.title}{c.result && c.result !== 'pending' ? ` · ${c.result}` : ''}</span>
          </div>
        ); })}
      </div>
    );
  };
  const markedDates = Object.keys(byDate);
  return (
    <ResponsiveContainer width="100%" height={240}>
      <AreaChart data={data} margin={{ top: 8, right: 14, left: 0, bottom: 0 }}>
        <defs><linearGradient id="cr-grad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C_GREEN} stopOpacity={0.32} /><stop offset="100%" stopColor={C_GREEN} stopOpacity={0.04} /></linearGradient></defs>
        <CartesianGrid strokeDasharray="4 4" stroke={C_GRID} strokeOpacity={0.85} vertical={false} />
        <XAxis dataKey="date" tickFormatter={mmdd} tick={{ fill: C_T2, fontSize: 11, fontFamily: 'var(--mono)' }} axisLine={{ stroke: C_GRID }} tickLine={{ stroke: C_GRID }} minTickGap={28} />
        <YAxis tickFormatter={v => `${v}%`} tick={{ fill: C_T2, fontSize: 11, fontFamily: 'var(--mono)' }} axisLine={false} tickLine={false} width={44} />
        <Tooltip content={<TT />} cursor={{ stroke: '#FFFFFF', strokeOpacity: 0.3, strokeWidth: 1 }} />
        <ReferenceLine y={avg} stroke={C_T3} strokeDasharray="5 5" label={{ value: `avg ${avg.toFixed(2)}%`, position: 'right', fill: C_T3, fontSize: 10, fontFamily: 'var(--mono)' }} />
        {markedDates.map(dt => {
          // A date can carry mixed changes; a single marker line takes one colour by priority
          // (out-of-stock dominates — the likeliest CR mover — then website, then restock).
          // The tooltip lists every change in its own category colour.
          const cats = new Set((byDate[dt] || []).map(c => catKey(c.stream, c.status)));
          const k = cats.has('oos') ? 'oos' : cats.has('web') ? 'web' : 'restock';
          return <ReferenceLine key={dt} x={dt} stroke={CAT[k].color} strokeDasharray="3 3" strokeOpacity={0.55} />;
        })}
        <Area type="monotone" dataKey="cr" stroke={C_GREEN} strokeWidth={2} fill="url(#cr-grad)" dot={false} activeDot={{ r: 4, fill: C_GREEN }} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// Attribution / driver panel (layer d): notable CR days with their nearby driver events, plus a
// "driver library" grouping every event by date. Events are CATEGORISED — ▼ out of stock / ▲ restocked
// / ◆ website change (stream+status). The measured before/after CR swing is a property of the DATE,
// not any single event (every co-dated event shares it), so it's shown ONCE on the date header, never
// per-event — a restock no longer inherits a co-dated dip's negative number. Correlation, not proof.
const CAT = {
  oos:     { key: 'oos',     label: 'Out of stock', arrow: '▼', color: '#EC6A5E' },
  restock: { key: 'restock', label: 'Restocked',    arrow: '▲', color: 'var(--green)' },
  web:     { key: 'web',     label: 'Website',       arrow: '◆', color: 'var(--accent)' },
};
const CAT_ORDER = ['oos', 'restock', 'web'];
// Legacy stream dot — still used by the raw change-events marker list further down the page.
const STREAM_C = { website: 'var(--accent)', stock: '#2DA8F0' };
const streamDot = s => <span className="so-dot" style={{ background: STREAM_C[s] || 'var(--t3)', marginRight: 6, flexShrink: 0 }} />;
const catKey = (stream, status) => (stream === 'stock' ? (status === 'restock' ? 'restock' : 'oos') : 'web');
const stockName = t => String(t || '').split(' — ')[0].replace(/^L\.O\.T\s+(Cars|Aviation)\s+/i, '');
const fmtPP = v => (v == null ? '—' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}pp`);
const gapLabel = g => (g === 0 ? 'same day' : g > 0 ? `+${g}d` : `${g}d`);
const impC = v => (v == null ? 'var(--t3)' : v > 0 ? 'var(--green)' : v < 0 ? '#EC6A5E' : 'var(--t3)');
// Marker legend — the same three categories the chart's reference lines use.
const MarkerLegend = () => (
  <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
    {CAT_ORDER.map(k => (
      <span key={k} style={{ fontFamily: 'var(--mono)', fontSize: 10, color: CAT[k].color, whiteSpace: 'nowrap' }}>
        {CAT[k].arrow} {CAT[k].label.toLowerCase()}
      </span>
    ))}
  </div>
);
// One categorised row: "▼ Out of stock ·N   name · name · name" (stock inline, website stacked).
function CatRow({ catk, items }) {
  const c = CAT[catk], isWeb = catk === 'web';
  return (
    <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: c.color, width: 100, flexShrink: 0, fontWeight: 600 }}>{c.arrow} {c.label}<span style={{ color: 'var(--t5)', fontWeight: 400 }}> ·{items.length}</span></span>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: isWeb ? 'column' : 'row', flexWrap: 'wrap', gap: isWeb ? 3 : '2px 0' }}>
        {items.map((e, i) => (
          <span key={e.id || i} title={e.title} style={{ fontFamily: 'var(--ui)', fontSize: 12, color: 'var(--t1-cell)', minWidth: 0, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {isWeb ? e.title : stockName(e.title)}
            {e.gap != null && e.gap !== 0 ? <span style={{ marginLeft: 4, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t5)' }}>{gapLabel(e.gap)}</span> : null}
            {!isWeb && i < items.length - 1 ? <span style={{ color: 'var(--t5)' }}>&nbsp;·&nbsp;</span> : null}
          </span>
        ))}
      </div>
    </div>
  );
}
// Render an event list (already normalised to {id,cat,title,gap}) as up-to-3 categorised rows.
function CatGroups({ events }) {
  const m = { oos: [], restock: [], web: [] };
  for (const e of events) m[e.cat].push(e);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {CAT_ORDER.filter(k => m[k].length).map(k => <CatRow key={k} catk={k} items={m[k]} />)}
    </div>
  );
}
function DriversPanel({ drivers }) {
  const [tab, setTab] = useState('byday');   // byday | library
  if (!drivers) return null;
  const days = drivers.days || [], library = drivers.library || [], st = drivers.settings || {};
  // By day: group the flat (day × event) rows by the notable CR day; normalise events + categorise.
  const byDay = [], seen = {};
  for (const r of days) {
    let g = seen[r.the_date];
    if (!g) { g = seen[r.the_date] = { date: r.the_date, cr: r.cr, dev: r.deviation_pct, events: [] }; byDay.push(g); }
    if (r.event_id) g.events.push({ id: r.event_id, cat: catKey(r.event_stream, r.event_status), title: r.event_title, gap: r.day_gap });
  }
  // Driver library: group every event by its OWN date — the before/after swing is per-date, so it
  // heads the group once; events beneath are categorised. Biggest-swing dates first.
  const libByDate = [], seenL = {};
  for (const e of library) {
    let g = seenL[e.the_date];
    if (!g) { g = seenL[e.the_date] = { date: e.the_date, swing: e.impact_pp, events: [] }; libByDate.push(g); }
    g.events.push({ id: e.event_id, cat: catKey(e.stream, e.status), title: e.title, gap: null });
  }
  libByDate.sort((a, b) => Math.abs(b.swing ?? 0) - Math.abs(a.swing ?? 0));
  return (
    <div className="so-card">
      <PanelHead
        title="Likely drivers"
        qual={`· why conversion moved (±${st.window_days ?? 2}d · correlation, not proof)`}
        right={<SegmentedToggle options={[['byday', 'By day'], ['library', 'Driver library']]} value={tab} onChange={setTab} size="sm" />}
      />
      {tab === 'byday' ? (
        byDay.length === 0 ? <div className="so-sub" style={{ fontSize: 12.5, color: 'var(--t3)' }}>No notable conversion moves in this range (CR stayed within ±{st.notable_pct ?? 15}% of its 7-day average).</div> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {byDay.map(d => (
              <div key={d.date} style={{ borderBottom: '1px solid var(--row-border)', padding: '9px 0' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t1)', width: 88, flexShrink: 0 }}>{d.date}</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 12.5, color: STATUS.good }}>{fmtPct(d.cr)}</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, fontWeight: 600, color: d.dev >= 0 ? STATUS.good : STATUS.bad }}>{d.dev >= 0 ? '▲' : '▼'} {Math.abs(d.dev).toFixed(0)}% vs 7-day avg</span>
                </div>
                {d.events.length === 0
                  ? <div className="so-sub" style={{ fontSize: 11.5, color: 'var(--t3)', marginTop: 4, marginLeft: 100 }}>no known driver near this day</div>
                  : <div style={{ marginTop: 8, marginLeft: 100 }}><CatGroups events={d.events} /></div>}
              </div>
            ))}
          </div>
        )
      ) : (
        libByDate.length === 0 ? <div className="so-sub" style={{ fontSize: 12.5, color: 'var(--t3)' }}>No events in this range yet.</div> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div className="so-sub" style={{ fontSize: 12, color: 'var(--t3)', marginBottom: 6, lineHeight: 1.5 }}>Each date's changes, grouped. The <span style={{ fontFamily: 'var(--mono)' }}>pp</span> is that date's CR swing (avg {st.impact_days ?? 3}d after − {st.impact_days ?? 3}d before) — a date-level signal shared by every change that day, not any single event's effect.</div>
            {libByDate.map(g => (
              <div key={g.date} style={{ borderBottom: '1px solid var(--row-border)', padding: '9px 0' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6, flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t1)', width: 88, flexShrink: 0 }}>{g.date}</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600, color: impC(g.swing) }}>{fmtPP(g.swing)}</span>
                  <span className="so-qual">CR swing ±{st.impact_days ?? 3}d</span>
                </div>
                <div style={{ marginLeft: 4 }}><CatGroups events={g.events} /></div>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}

// Hybrid net conversion — the reliable CRO metric: Shopify net orders (exact) ÷ GA4 website sessions.
function BigKpi({ label, val, tone = 'var(--t1)' }) {
  return (
    <div style={{ textAlign: 'right' }}>
      <div style={{ fontFamily: 'var(--cond)', fontSize: 24, fontWeight: 800, letterSpacing: '-0.01em', color: tone, lineHeight: 1 }}>{val}</div>
      <div className="so-eyebrow" style={{ fontSize: 9.5, marginTop: 6 }}>{label}</div>
    </div>
  );
}
function NetCr({ data }) {
  if (!data) return <div className="so-card"><Spinner /></div>;
  const rows = data.rows || [];
  const s = data.summary || {};
  const fmtCr = (v) => (v == null ? '—' : Number(v).toFixed(2) + '%');
  const crCell = (v) => (v == null ? <Nil /> : Number(v).toFixed(2) + '%');
  // chronological prev-day lookup for the CR ▲/▼ (independent of row order)
  const prev = {};
  { const chron = [...rows].sort((a, b) => (a.the_date < b.the_date ? -1 : 1)); chron.forEach((r, i) => { if (i > 0) prev[r.the_date] = chron[i - 1]; }); }
  const hasShop = s.cr_shopify != null;   // Shopify-sessions feed populated → gold-standard CR available
  const primCr = hasShop ? 'cr_shopify' : 'cr';
  const primSess = hasShop ? 'shopify_sessions' : 'sessions';
  const th = { position: 'sticky', top: 0, background: 'var(--surface-solid)', cursor: 'default', zIndex: 1 };
  return (
    // Accent-tinted hero — the one panel that sits above BOTH sub-views (handoff §9.5).
    <div className="so-card" style={{
      background: 'linear-gradient(150deg, rgba(242,205,26,.09), var(--surface) 62%)',
      borderColor: 'rgba(242,205,26,.3)', boxShadow: '0 18px 44px -26px rgba(242,205,26,.5)', padding: '18px 20px',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 20, flexWrap: 'wrap' }}>
        <div style={{ maxWidth: 660 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <span className="so-h2" style={{ fontSize: 15, fontWeight: 700 }}>Net Conversion</span>
            <span className="so-qual">· Shopify net orders ÷ {hasShop ? 'Shopify sessions' : 'GA4 sessions'}</span>
          </div>
          <p className="so-sub" style={{ fontSize: 12, marginTop: 7, lineHeight: 1.55 }}>
            Net orders = paid Website orders, excluding cancelled, ₹0, and MO_Repair / MO_Replacement. Recent 3 days provisional (late orders + session revisions still settle).
            {hasShop
              ? <> Denominator = <b style={{ color: 'var(--t1)' }}>Shopify sessions</b> — same source as the orders, so this matches your hand-calc{s.calibration != null && <> · Shopify ≈ <span style={{ fontFamily: 'var(--mono)' }}>{s.calibration}×</span> GA4</>}.</>
              : <> Denominator = <b style={{ color: 'var(--t1)' }}>GA4 sessions</b>. <span style={{ color: STATUS.warn }}>Shopify-sessions feed pending — add the <code style={{ fontFamily: 'var(--mono)', fontSize: 11.5 }}>read_reports</code> scope to the Shopify app to switch to the exact same-source CR.</span></>}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 26, flexWrap: 'wrap' }}>
          <BigKpi label={hasShop ? 'CR · Shopify' : 'CR · GA4'} val={fmtCr(hasShop ? s.cr_shopify : s.cr)} tone="var(--accent)" />
          {hasShop && <BigKpi label="CR · GA4" val={fmtCr(s.cr)} />}
          <BigKpi label="Net orders" val={fmtInt(s.net_orders)} />
          <BigKpi label={hasShop ? 'Sessions · Shop' : 'Sessions · GA4'} val={fmtInt(hasShop ? s.shopify_sessions : s.sessions)} />
        </div>
      </div>
      <div style={{ overflowX: 'auto', maxHeight: 340, overflowY: 'auto', marginTop: 14 }}>
        <table className="so-table">
          <thead><tr>
            {['Date', hasShop ? 'Sessions·Shop' : 'Sessions', 'Net orders', 'Excl.', hasShop ? 'CR·Shop' : 'CR', ...(hasShop ? ['CR·GA4'] : [])].map((h, i) => (
              <th key={h} className={i === 0 ? undefined : 'so-num'} style={th}>{h}</th>
            ))}
          </tr></thead>
          <tbody>
            {rows.map(r => {
              const p = prev[r.the_date];
              const dod = p && r[primCr] != null && p[primCr] != null ? Number(r[primCr]) - Number(p[primCr]) : null;
              return (
                <tr key={r.the_date}>
                  <td style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--t2-cell)', whiteSpace: 'nowrap' }}>{r.the_date}
                    {r.provisional && <Pill color="#F59E0B" style={{ marginLeft: 7, fontSize: 9, textTransform: 'none', letterSpacing: 0 }}>provisional</Pill>}</td>
                  <td className="so-num">{fmtInt(r[primSess])}</td>
                  <td className="so-num">{fmtInt(r.net_orders)}</td>
                  <td className="so-num" style={{ color: 'var(--t4)' }}>{fmtInt(r.excluded_orders)}</td>
                  <td className="so-num bright" style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                    {crCell(r[primCr])}
                    {dod != null && Math.abs(dod) >= 0.005 && <span style={{ marginLeft: 5, fontSize: 10, fontWeight: 400, color: dod > 0 ? STATUS.good : STATUS.bad }}>{dod > 0 ? '▲' : '▼'}{Math.abs(dod).toFixed(2)}</span>}
                  </td>
                  {hasShop && <td className="so-num" style={{ color: 'var(--t4)' }}>{crCell(r.cr)}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Shopify-sourced daily funnel — Sessions → Net orders → CR. Shopify's API doesn't expose the
// ATC/Checkout middle steps (only `sessions` + `conversion_rate`), so those live on the GA4 tab.
function ShopifyDailyFunnel({ rows }) {
  const list = rows || [];
  const hasShop = list.some(r => r.shopify_sessions != null);
  const crCell = (v) => (v == null ? <Nil /> : Number(v).toFixed(2) + '%');
  const prev = {};
  { const chron = [...list].sort((a, b) => (a.the_date < b.the_date ? -1 : 1)); chron.forEach((r, i) => { if (i > 0) prev[r.the_date] = chron[i - 1]; }); }
  return (
    <>
      <div className="so-sub" style={{ fontSize: 12, padding: '0 18px 4px', color: 'var(--t3)', maxWidth: 780, lineHeight: 1.55 }}>
        Shopify-sourced · same source as your orders. Sessions = Shopify online-store sessions; Net orders excl. cancelled / ₹0 / MO_Repair / MO_Replacement; CR = Net orders ÷ Shopify sessions (your hand-calc). <b style={{ color: 'var(--t2)' }}>Add-to-cart &amp; Checkout aren't exposed by Shopify's API — use the GA4 tab for those.</b>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="so-table" style={{ marginTop: 8 }}>
          <thead><tr>
            <th style={{ cursor: 'default' }}>Date</th>
            <th className="so-num" style={{ cursor: 'default' }}>Sessions</th>
            <th className="so-num" style={{ cursor: 'default' }}>Net orders</th>
            <th className="so-num" style={{ cursor: 'default' }}>CR · Shopify</th>
            <th className="so-num" style={{ cursor: 'default' }}>CR · GA4</th>
          </tr></thead>
          <tbody>
            {!hasShop && <tr><td colSpan={5} className="so-sub" style={{ color: 'var(--t3)', padding: 14 }}>Shopify sessions not synced for this range yet.</td></tr>}
            {hasShop && list.map(r => {
              const p = prev[r.the_date];
              const dod = p && r.cr_shopify != null && p.cr_shopify != null ? Number(r.cr_shopify) - Number(p.cr_shopify) : null;
              return (
                <tr key={r.the_date}>
                  <td style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--t2-cell)', whiteSpace: 'nowrap' }}>{r.the_date}{r.provisional && <Pill color="#F59E0B" style={{ marginLeft: 7, fontSize: 9, textTransform: 'none', letterSpacing: 0 }}>prov</Pill>}</td>
                  <td className="so-num">{numfmt(r.shopify_sessions)}</td>
                  <td className="so-num">{numfmt(r.net_orders)}</td>
                  <td className="so-num" style={{ color: STATUS.good, fontWeight: 600, whiteSpace: 'nowrap' }}>{crCell(r.cr_shopify)}{dod != null && Math.abs(dod) >= 0.005 && <span style={{ marginLeft: 5, fontSize: 10, fontWeight: 400, color: dod > 0 ? STATUS.good : STATUS.bad }}>{dod > 0 ? '▲' : '▼'}{Math.abs(dod).toFixed(2)}</span>}</td>
                  <td className="so-num" style={{ color: 'var(--t4)' }}>{crCell(r.cr)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// Side card for the funnel / daily-history splits — the §3.4 tile recipe at a larger value size.
function SideStat({ hue, lbl, val, valSize = 30, valColor, sub, children }) {
  return (
    <div className="so-stat" style={{ ...hueStyle(hue), flex: 1, justifyContent: 'center' }}>
      <div className="so-stat-top">
        <span className="so-stat-swatch" />
        <span className="so-stat-lbl">{lbl}</span>
      </div>
      {val != null && <span className="so-stat-val" style={{ fontSize: valSize, color: valColor || 'var(--t1)' }}>{val}</span>}
      {sub && <div className="so-sub" style={{ fontSize: 11.5, color: 'var(--t3)', marginTop: 6 }}>{sub}</div>}
      {children}
    </div>
  );
}

export default function FunnelPage() {
  const { session } = useAuth();
  const mtd = rangePresets().find(p => p.key === 'mtd');
  const [from, setFrom] = useState(mtd.from);
  const [to, setTo] = useState(mtd.to);
  const [rows, setRows] = useState(null);
  const [pay, setPay] = useState(null);   // { funnel, recon } — checkout payment funnel (Razorpay)
  const [hist, setHist] = useState(null);  // daily conversion-history snapshot rows
  const [changes, setChanges] = useState([]);  // change events (website + stock) — timeline annotations
  const [drivers, setDrivers] = useState(null);  // { days, library, settings } — attribution (layer d)
  const [view, setView] = useState('overview');  // overview | history
  const [histSrc, setHistSrc] = useState('ga4');  // daily-funnel source: ga4 (full funnel) | shopify (sessions→net orders→CR)
  const [netcr, setNetcr] = useState(null);   // hybrid net CR (Shopify net orders / GA4 website sessions)
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!session) return;
    setRows(null); setPay(null); setHist(null); setChanges([]); setDrivers(null); setNetcr(null); setErr('');
    salesGet('getWebsiteCr', { from, to }, session)
      .then(c => setNetcr(c || { rows: [], summary: {} }))
      .catch(() => setNetcr({ rows: [], summary: {} }));
    salesGet('getTraffic', { from, to }, session)
      .then(t => setRows(t?.rows || []))
      .catch(e => setErr(e.message || String(e)));
    salesGet('getPaymentFunnel', { from, to }, session)
      .then(p => setPay(p || {}))
      .catch(() => setPay({}));   // soft — payment section just shows empty if it fails
    salesGet('getConversionHistory', { from, to }, session)
      .then(h => setHist(h?.rows || []))
      .catch(() => setHist([]));
    salesGet('getChangeEvents', { from, to }, session)
      .then(c => setChanges(c?.rows || []))
      .catch(() => setChanges([]));
    salesGet('getConversionDrivers', { from, to }, session)
      .then(d => setDrivers(d || { days: [], library: [], settings: {} }))
      .catch(() => setDrivers({ days: [], library: [], settings: {} }));
  }, [session, from, to]);

  const sum = k => (rows || []).reduce((a, r) => a + Number(r[k] || 0), 0);
  const sessions = sum('sessions'), atc = sum('add_to_carts'), checkouts = sum('checkouts'), purchases = sum('purchases'), revenue = sum('conv_value');
  const cr = pctOf(purchases, sessions);

  const steps = [
    { key: 'sessions',  label: 'Sessions',  value: sessions,  color: '#F2CD1A' },
    { key: 'atc',       label: 'Add to cart', value: atc,      color: '#F59E0B' },
    { key: 'checkouts', label: 'Checkout',  value: checkouts, color: '#FF7A1A' },
    { key: 'purchases', label: 'Purchase',  value: purchases, color: '#34D27B' },
  ];

  const srcSort = useTableSort(rows, { initialKey: 'sessions', valueOf: (r, k) => k === 'conv' ? (Number(r.sessions) > 0 ? Number(r.purchases) / Number(r.sessions) : 0) : k === 'src_group' ? (r.src_group || '') : r[k] });
  const histSort = useTableSort(hist, { initialKey: 'the_date', initialDir: 'desc' });
  // Previous-DAY lookup for the daily-funnel tickers — keyed by date (chronological), so the
  // ▲/▼ always compares to the day before regardless of how the table is currently sorted.
  const prevByDate = {};
  { const chron = [...(hist || [])].sort((a, b) => (a.the_date < b.the_date ? -1 : 1)); chron.forEach((r, i) => { if (i > 0) prevByDate[r.the_date] = chron[i - 1]; }); }

  return (
    <div className="so-page">
      <PageHead
        title="Funnel"
        sub="Website conversion · GA4 + Shopify + Razorpay"
        right={<SegmentedToggle options={[['overview', 'Overview'], ['history', 'Daily history']]} value={view} onChange={setView} />}
      />

      {/* sticky page-level range header — never nested in a .so-card */}
      <RangePicker from={from} to={to} onChange={({ from, to }) => { setFrom(from); setTo(to); }}
        right={<span className="so-qual">GA4 · Website</span>} />

      {err && <div className="so-card" style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 12 }}>{err}</div>}

      <NetCr data={netcr} />

      {view === 'history' ? (
        !hist ? <div style={{ padding: 60, textAlign: 'center' }}><Spinner /></div> : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2.2fr) minmax(230px,1fr)', gap: 16 }}>
              <div className="so-card">
                <PanelHead
                  title="Daily conversion rate"
                  qual="· sessions → purchase"
                  right={changes.length > 0 ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                      <MarkerLegend />
                      <span className="so-qual" style={{ display: 'inline-flex', alignItems: 'center' }}>
                        <span className="so-dot" style={{ background: 'var(--accent)', marginRight: 5 }} />{changes.length} website change{changes.length > 1 ? 's' : ''}
                      </span>
                    </div>
                  ) : null}
                />
                {/* plain wrapper: the chart's direct parent must not carry backdrop-filter (§7) */}
                <div><DailyTrend rows={hist} changes={changes} /></div>
              </div>
              {(() => {
                const wd = (hist || []).filter(r => Number(r.sessions) > 0);
                const v = wd.map(r => Number(r.purchase_cr) || 0);
                const avg = v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
                const best = wd.length ? wd.reduce((m, r) => Number(r.purchase_cr) > Number(m.purchase_cr) ? r : m) : null;
                const worst = wd.length ? wd.reduce((m, r) => Number(r.purchase_cr) < Number(m.purchase_cr) ? r : m) : null;
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    <SideStat hue={HUE.units} lbl="Avg daily conversion" val={`${avg.toFixed(2)}%`} valSize={30} valColor={STATUS.good} sub={`${wd.length} days in range`} />
                    <SideStat hue={HUE.neutral} lbl="Best / worst day">
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 12, marginTop: 10, lineHeight: 1.8 }}>
                        <div style={{ color: STATUS.good }}>▲ {best?.the_date || <Nil />} · {Number(best?.purchase_cr || 0).toFixed(2)}%</div>
                        <div style={{ color: STATUS.bad }}>▼ {worst?.the_date || <Nil />} · {Number(worst?.purchase_cr || 0).toFixed(2)}%</div>
                      </div>
                    </SideStat>
                  </div>
                );
              })()}
            </div>

            <div className="so-card flush">
              <PanelHead
                title="Daily funnel"
                qual={<>· <span style={{ color: STATUS.good }}>▲</span>/<span style={{ color: STATUS.bad }}>▼</span> vs previous day</>}
                right={<SegmentedToggle options={[['ga4', 'GA4'], ['shopify', 'Shopify']]} value={histSrc} onChange={setHistSrc} size="sm" />}
              />
              {histSrc === 'ga4' ? (
              <div style={{ overflowX: 'auto' }}>
                <table className="so-table">
                  <thead><tr>
                    <SortHeader k="the_date" label="Date" sort={histSort} />
                    <SortHeader k="sessions" label="Sessions" sort={histSort} numeric />
                    <SortHeader k="add_to_carts" label="ATC" sort={histSort} numeric />
                    <SortHeader k="checkouts" label="Checkout" sort={histSort} numeric />
                    <SortHeader k="purchases" label="Purchases" sort={histSort} numeric />
                    <SortHeader k="atc_rate" label="ATC %" sort={histSort} numeric />
                    <SortHeader k="purchase_cr" label="Conv. rate" sort={histSort} numeric />
                  </tr></thead>
                  <tbody>
                    {histSort.sorted.length === 0 && <tr><td colSpan={7} className="so-sub" style={{ color: 'var(--t3)', padding: 14 }}>No snapshot days in this range yet.</td></tr>}
                    {histSort.sorted.map(r => {
                      const prev = prevByDate[r.the_date];
                      return (
                      <tr key={r.the_date}>
                        <td style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--t2-cell)', whiteSpace: 'nowrap' }}>{r.the_date}</td>
                        <td className="so-num">{numfmt(r.sessions)}<Tick now={r.sessions} prev={prev?.sessions} /></td>
                        <td className="so-num">{numfmt(r.add_to_carts)}<Tick now={r.add_to_carts} prev={prev?.add_to_carts} /></td>
                        <td className="so-num">{numfmt(r.checkouts)}<Tick now={r.checkouts} prev={prev?.checkouts} /></td>
                        <td className="so-num">{numfmt(r.purchases)}<Tick now={r.purchases} prev={prev?.purchases} /></td>
                        <td className="so-num">{fmtPct(r.atc_rate)}<Tick now={r.atc_rate} prev={prev?.atc_rate} /></td>
                        <td className="so-num" style={{ color: STATUS.good, fontWeight: 600 }}>{fmtPct(r.purchase_cr)}<Tick now={r.purchase_cr} prev={prev?.purchase_cr} /></td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              ) : <ShopifyDailyFunnel rows={netcr?.rows} />}
            </div>

            <DriversPanel drivers={drivers} />

            {changes.length > 0 && (
              <div className="so-card">
                <PanelHead title="Changes & events in range" qual="· what shipped / stock moves" />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {changes.slice().sort((a, b) => (a.the_date < b.the_date ? 1 : -1)).map(c => (
                    <div key={c.id} style={{ display: 'flex', gap: 12, alignItems: 'baseline', borderBottom: '1px solid var(--row-border)', padding: '8px 0' }}>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--t2-cell)', width: 88, flexShrink: 0 }}>{c.the_date}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontFamily: 'var(--ui)', fontSize: 13, color: 'var(--t1)', display: 'flex', alignItems: 'center' }}>{streamDot(c.stream)}<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</span>
                          {c.workstream && c.workstream !== 'stock' && <span className="so-eyebrow" style={{ marginLeft: 8, fontSize: 9.5, flexShrink: 0 }}>{c.workstream}{c.surface ? ` · ${c.surface}` : ''}</span>}
                        </div>
                        {c.hypothesis && <div className="so-sub" style={{ fontSize: 12, color: 'var(--t3)', marginTop: 3 }}>{c.hypothesis}</div>}
                      </div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                        {c.status && <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: c.status === 'reverted' ? STATUS.bad : 'var(--t4)' }}>{c.status}</span>}
                        <span style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600, color: c.result && c.result !== 'pending' ? STATUS.good : 'var(--t4)' }}>{c.result || <Nil />}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="so-sub" style={{ fontSize: 11.5, color: 'var(--t3)', lineHeight: 1.6 }}>Frozen daily snapshot of the GA4 website funnel — recent days refresh as GA4 finalises, older days lock. Markers: <span style={{ color: '#EC6A5E' }}>▼ out of stock</span> · <span style={{ color: 'var(--green)' }}>▲ restocked</span> (native Shopify inventory, forward-only) · <span style={{ color: 'var(--accent)' }}>◆ website changes</span> (Website repo change-log). A marker line takes the priority colour (out-of-stock first); hover for the full per-change list. Likely drivers are heuristic time-proximity — correlation, not proof.</div>
          </>
        )
      ) : (
      !rows ? <div style={{ padding: 60, textAlign: 'center' }}><Spinner /></div> : (
        <>
          {/* funnel viz + headline conversion */}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2.2fr) minmax(230px,1fr)', gap: 16 }}>
            <div className="so-card">
              <PanelHead title="Conversion funnel" style={{ marginBottom: 16 }} />
              {sessions === 0
                ? <div className="so-sub" style={{ color: 'var(--t3)', fontSize: 12.5, padding: '28px 0', textAlign: 'center' }}>No traffic in this range yet.</div>
                : <Funnel steps={steps} />}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <SideStat hue={HUE.units} lbl="Overall conversion" val={`${cr.toFixed(2)}%`} valSize={34} valColor={STATUS.good} sub="sessions → purchase" />
              <SideStat hue={HUE.primary} lbl="Revenue" val={inr(revenue)} valSize={26} sub="GA4 purchase value" />
            </div>
          </div>

          {/* by source */}
          <div className="so-card flush">
            <PanelHead title="By traffic source" />
            <div style={{ overflowX: 'auto' }}>
              <table className="so-table">
                <thead><tr>
                  <SortHeader k="src_group" label="Source" sort={srcSort} /><SortHeader k="sessions" label="Sessions" sort={srcSort} numeric /><SortHeader k="add_to_carts" label="Add to cart" sort={srcSort} numeric />
                  <SortHeader k="checkouts" label="Checkouts" sort={srcSort} numeric /><SortHeader k="purchases" label="Purchases" sort={srcSort} numeric /><SortHeader k="conv" label="Conv. rate" sort={srcSort} numeric />
                </tr></thead>
                <tbody>
                  {srcSort.sorted.length === 0 && <tr><td colSpan={6} className="so-sub" style={{ color: 'var(--t3)', padding: 14 }}>No traffic in this range yet — connector may still be backfilling.</td></tr>}
                  {srcSort.sorted.map((r, i) => {
                    const s = Number(r.sessions || 0), pu = Number(r.purchases || 0);
                    return (<tr key={i}>
                      <td>{r.src_group || <Nil />}</td>
                      <td className="so-num">{numfmt(r.sessions)}</td>
                      <td className="so-num">{numfmt(r.add_to_carts)}</td>
                      <td className="so-num">{numfmt(r.checkouts)}</td>
                      <td className="so-num">{numfmt(r.purchases)}</td>
                      <td className="so-num bright" style={{ fontWeight: 600 }}>{s > 0 ? (pu / s * 100).toFixed(2) + '%' : <Nil />}</td>
                    </tr>);
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── Checkout & payment funnel (Razorpay) ── */}
          {(() => {
            const f = (pay && pay.funnel) || {}, rc = (pay && pay.recon) || {};
            const attempts = Number(f.attempts || 0), captured = Number(f.captured || 0), failed = Number(f.failed || 0);
            const sr = Number(f.success_rate || 0), capAmt = Number(f.captured_amount || 0), cod = Number(f.cod_orders || 0);
            const abandoned = Number(f.abandoned || 0), psr = Number(f.payment_success_rate || 0);
            const byProvider = f.by_provider || {};
            const provNames = Object.keys(byProvider).sort();
            const byMethod = f.by_method || {}, byReason = f.by_failure_reason || {};
            const methods = Object.entries(byMethod).sort((a, b) => (Number(b[1].attempts) || 0) - (Number(a[1].attempts) || 0));
            const reasons = Object.entries(byReason).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 8);
            const maxM = Math.max(...methods.map(m => Number(m[1].attempts) || 0), 1);
            const maxR = Math.max(...reasons.map(r => Number(r[1]) || 0), 1);
            const stat = (lbl, val, sub, color) => (
              <div key={lbl} style={{ background: 'var(--control)', border: '1px solid var(--border-ctl)', borderRadius: 12, padding: '12px 14px', minWidth: 0 }}>
                <div className="so-stat-lbl" style={{ color: 'var(--t2)' }}>{lbl}</div>
                <div style={{ fontFamily: 'var(--cond)', fontSize: 20, fontWeight: 700, letterSpacing: '-0.01em', color: color || 'var(--t1)', marginTop: 7, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{val}</div>
                {sub ? <div className="so-stat-sub" style={{ marginTop: 3 }}>{sub}</div> : null}
              </div>
            );
            return (
              <div className="so-card">
                <PanelHead title="Checkout & payment" qual={provNames.length ? `· ${provNames.join(' + ')}` : ''} />
                {!pay ? <div style={{ padding: 20, textAlign: 'center' }}><Spinner /></div>
                  : (attempts === 0 && cod === 0) ? <div className="so-sub" style={{ color: 'var(--t3)', fontSize: 12.5, padding: '8px 0' }}>No payment data in this range yet — connector backfilling / webhook warming up.</div>
                    : (
                      <>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 12, marginBottom: 18 }}>
                          {stat('Prepaid attempts', numfmt(attempts))}
                          {stat('Captured', numfmt(captured), `${sr.toFixed(1)}% success`, STATUS.good)}
                          {stat('Failed', numfmt(failed), failed ? `${(100 * failed / Math.max(attempts, 1)).toFixed(1)}% of attempts` : null, STATUS.bad)}
                          {stat('COD orders', numfmt(cod), 'captured on delivery', 'var(--t2)')}
                          {stat('Captured value', inr(capAmt))}
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 24 }}>
                          <div>
                            <div className="so-eyebrow" style={{ marginBottom: 10 }}>Why payments fail</div>
                            {reasons.length === 0 ? <div className="so-sub" style={{ color: 'var(--t3)', fontSize: 12 }}>No failures in range.</div>
                              : reasons.map(([reason, c]) => (
                                <div key={reason} style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 6 }}>
                                  <div style={{ width: 150, flex: 'none', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={reason}>{reason}</div>
                                  <Bar pct={(Number(c) / maxR) * 100} color="rgba(236,106,94,.82)" height={13} style={{ flex: 1, borderRadius: 3 }} />
                                  <div style={{ width: 44, textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t2-cell)' }}>{numfmt(c)}</div>
                                </div>
                              ))}
                          </div>
                          <div>
                            <div className="so-eyebrow" style={{ marginBottom: 10 }}>By payment method <span style={{ textTransform: 'none', letterSpacing: 0, color: 'var(--t5)' }}>(captured / attempts)</span></div>
                            {methods.map(([m, o]) => {
                              const a = Number(o.attempts) || 0, cap = Number(o.captured) || 0;
                              return (
                                <div key={m} style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 6 }}>
                                  <div style={{ width: 92, flex: 'none', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t2)' }}>{m}</div>
                                  <Bar pct={(a / maxM) * 100} color="rgba(242,205,26,.85)" height={13} style={{ flex: 1, borderRadius: 3 }} />
                                  <div style={{ width: 88, textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t2-cell)' }}>{numfmt(cap)}/{numfmt(a)}</div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                        <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border-table)' }}>
                          <div className="so-eyebrow" style={{ marginBottom: 9 }}>Reconciliation · {from} → {to}</div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t2)' }}>
                            <span>GA4 purchases <b style={{ color: 'var(--t1)' }}>{numfmt(rc.ga4_purchases)}</b></span>
                            <span style={{ color: 'var(--t5)' }}>·</span>
                            <span>Shopify orders <b style={{ color: 'var(--t1)' }}>{numfmt(rc.shopify_orders)}</b></span>
                            <span style={{ color: 'var(--t5)' }}>·</span>
                            <span>Razorpay captured <b style={{ color: 'var(--t1)' }}>{numfmt(rc.razorpay_captured)}</b> <span style={{ color: 'var(--t5)' }}>({inr(rc.razorpay_captured_amount)})</span></span>
                          </div>
                          <p className="so-sub" style={{ fontSize: 11.5, color: 'var(--t3)', marginTop: 8, lineHeight: 1.55 }}>Prepaid captures come from Razorpay; COD orders have no online capture (they appear in Shopify orders, not here). GA4 typically over-counts slightly.</p>
                        </div>
                      </>
                    )}
              </div>
            );
          })()}
        </>
      ))}
    </div>
  );
}
