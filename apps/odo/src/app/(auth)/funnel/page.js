'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { salesGet, fmtInt, inr, rangePresets } from '../../../lib/api.js';
import { RangePicker, SegmentedToggle, useTableSort, SortHeader } from '../../../components/kit.js';
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
  if (n === p) return <span style={{ marginLeft: 6, fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--t3)' }}>–</span>;
  const up = n > p;
  const pct = p !== 0 ? Math.abs((n - p) / p * 100) : 100;
  return (
    <span style={{ marginLeft: 6, fontFamily: 'var(--mono)', fontSize: 9.5, color: up ? 'var(--green)' : '#EC6A5E', whiteSpace: 'nowrap' }}>
      {up ? '▲' : '▼'}{pct >= 0.5 ? ` ${pct.toFixed(pct < 10 ? 1 : 0)}%` : ''}
    </span>
  );
}

// Stepped conversion funnel: each stage's bar is sized to its share of Sessions, with the
// step-to-step conversion rate called out between stages. The drop-off is the story.
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
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0 2px 4px' }}>
                <span style={{ color: 'var(--t3)', fontSize: 13 }}>↳</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: stepConv >= 50 ? 'var(--green)' : stepConv >= 20 ? 'var(--amber)' : 'var(--t2)' }}>
                  {fmtPct(stepConv)}
                </span>
                <span className="so-sub" style={{ fontSize: 11 }}>continue to {s.label.toLowerCase()}</span>
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <div style={{ width: 96, fontFamily: 'var(--ui)', fontSize: 12.5, color: 'var(--t2)', textAlign: 'right' }}>{s.label}</div>
              <div style={{ flex: 1, position: 'relative', height: 38, background: 'var(--surface2)', borderRadius: 8, overflow: 'hidden' }}>
                <div style={{ position: 'absolute', inset: 0, transformOrigin: 'left', transform: `scaleX(${Math.max(share, 0) / 100})`, background: `linear-gradient(90deg, ${s.color}, color-mix(in srgb, ${s.color} 65%, transparent))`, borderRadius: 8, transition: 'transform .45s cubic-bezier(.22,1,.36,1)' }} />
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 13px' }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 700, color: 'var(--t1)' }}>{numfmt(s.value)}</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t2)' }}>{fmtPct(share)}</span>
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
const C_GRID = '#33343D', C_T2 = '#A4A6AE', C_T3 = '#6E6F79', C_SURFACE2 = '#26272E', C_GREEN = '#34D27B', C_ACCENT = '#F2CD1A', C_STOCK = '#2DA8F0', C_RED = '#EC6A5E';
const streamColor = s => (s === 'stock' ? C_STOCK : C_ACCENT);
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
        {chg.map(c => (
          <div key={c.id} style={{ display: 'flex', gap: 6, marginTop: 5, paddingTop: 5, borderTop: `1px solid ${C_GRID}`, color: streamColor(c.stream), maxWidth: 230 }}>
            <span>{c.stream === 'stock' ? '■' : '▸'}</span><span style={{ color: '#F2F3F0', whiteSpace: 'normal' }}>{c.title}{c.result && c.result !== 'pending' ? ` · ${c.result}` : ''}</span>
          </div>
        ))}
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
          const hasWeb = (byDate[dt] || []).some(c => (c.stream || 'website') !== 'stock');
          return <ReferenceLine key={dt} x={dt} stroke={hasWeb ? C_ACCENT : C_STOCK} strokeDasharray="3 3" strokeOpacity={0.5} />;
        })}
        <Area type="monotone" dataKey="cr" stroke={C_GREEN} strokeWidth={2} fill="url(#cr-grad)" dot={false} activeDot={{ r: 4, fill: C_GREEN }} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// Attribution / driver panel (layer d): notable CR days with their nearby driver events (each
// carrying a measured before/after CR effect), plus a "driver library" of every event by impact.
// Heuristic time-proximity — correlation, not proof (labeled). streamDot colours website vs stock.
const STREAM_C = { website: 'var(--accent)', stock: '#2DA8F0' };
const streamDot = s => <span className="so-dot" style={{ background: STREAM_C[s] || 'var(--t3)', marginRight: 6, flexShrink: 0 }} />;
const fmtPP = v => (v == null ? '—' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}pp`);
const gapLabel = g => (g === 0 ? 'same day' : g > 0 ? `+${g}d` : `${g}d`);
function DriversPanel({ drivers }) {
  const [tab, setTab] = useState('byday');   // byday | library
  if (!drivers) return null;
  const days = drivers.days || [], library = drivers.library || [], st = drivers.settings || {};
  // group the flat (day × event) rows by date
  const byDay = [];
  const seen = {};
  for (const r of days) {
    let g = seen[r.the_date];
    if (!g) { g = seen[r.the_date] = { date: r.the_date, cr: r.cr, dev: r.deviation_pct, events: [] }; byDay.push(g); }
    if (r.event_id) g.events.push(r);
  }
  const impC = v => (v == null ? 'var(--t3)' : v > 0 ? 'var(--green)' : v < 0 ? '#EC6A5E' : 'var(--t3)');
  return (
    <div className="so-card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
        <div className="so-kpi-lbl" style={{ margin: 0 }}>Likely drivers <span className="so-sub" style={{ fontSize: 10.5, textTransform: 'none', letterSpacing: 0 }}>· why conversion moved (±{st.window_days ?? 2}d · correlation, not proof)</span></div>
        <SegmentedToggle options={[['byday', 'By day'], ['library', 'Driver library']]} value={tab} onChange={setTab} size="sm" />
      </div>
      {tab === 'byday' ? (
        byDay.length === 0 ? <div className="so-sub" style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)' }}>No notable conversion moves in this range (CR stayed within ±{st.notable_pct ?? 15}% of its 7-day average).</div> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {byDay.map(d => (
              <div key={d.date} style={{ borderBottom: '1px solid var(--surface2)', paddingBottom: 9 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t1)', width: 88, flexShrink: 0 }}>{d.date}</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 12.5, color: 'var(--green)' }}>{fmtPct(d.cr)}</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, fontWeight: 600, color: d.dev >= 0 ? 'var(--green)' : '#EC6A5E' }}>{d.dev >= 0 ? '▲' : '▼'} {Math.abs(d.dev).toFixed(0)}% vs 7-day avg</span>
                </div>
                {d.events.length === 0
                  ? <div className="so-sub" style={{ fontSize: 11, marginTop: 3, marginLeft: 98 }}>no known driver near this day</div>
                  : (
                    <div style={{ marginTop: 5, marginLeft: 98, display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {d.events.map(e => (
                        <div key={e.event_id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          {streamDot(e.event_stream)}
                          <span style={{ fontSize: 12.5, color: 'var(--t1)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.event_title}</span>
                          <span className="so-sub" style={{ fontFamily: 'var(--mono)', fontSize: 10.5, flexShrink: 0 }}>{gapLabel(e.day_gap)}</span>
                          <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, fontWeight: 600, width: 66, textAlign: 'right', flexShrink: 0, color: impC(e.impact_pp) }}>{fmtPP(e.impact_pp)}</span>
                        </div>
                      ))}
                    </div>
                  )}
              </div>
            ))}
          </div>
        )
      ) : (
        library.length === 0 ? <div className="so-sub" style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)' }}>No events in this range yet.</div> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div className="so-sub" style={{ fontSize: 10.5, marginBottom: 2 }}>Every event by its measured {st.impact_days ?? 3}-day before/after CR effect.</div>
            {library.map(e => (
              <div key={e.event_id} style={{ display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--surface2)', paddingBottom: 6 }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t2)', width: 80, flexShrink: 0 }}>{e.the_date}</span>
                {streamDot(e.stream)}
                <span style={{ fontSize: 12.5, color: 'var(--t1)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.title}{e.result && e.result !== 'pending' ? <span className="so-sub" style={{ marginLeft: 8, fontSize: 10.5 }}>{e.result}</span> : null}</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, fontWeight: 600, width: 66, textAlign: 'right', flexShrink: 0, color: impC(e.impact_pp) }}>{fmtPP(e.impact_pp)}</span>
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
      <div style={{ fontFamily: 'var(--mono)', fontSize: 22, fontWeight: 700, color: tone, lineHeight: 1 }}>{val}</div>
      <div className="so-sub" style={{ fontSize: 10.5, marginTop: 3 }}>{label}</div>
    </div>
  );
}
function NetCr({ data }) {
  if (!data) return <div className="so-card"><Spinner /></div>;
  const rows = data.rows || [];
  const s = data.summary || {};
  const fmtCr = (v) => (v == null ? '—' : Number(v).toFixed(2) + '%');
  // chronological prev-day lookup for the CR ▲/▼ (independent of row order)
  const prev = {};
  { const chron = [...rows].sort((a, b) => (a.the_date < b.the_date ? -1 : 1)); chron.forEach((r, i) => { if (i > 0) prev[r.the_date] = chron[i - 1]; }); }
  const hasShop = s.cr_shopify != null;   // Shopify-sessions feed populated → gold-standard CR available
  const primCr = hasShop ? 'cr_shopify' : 'cr';
  const primSess = hasShop ? 'shopify_sessions' : 'sessions';
  return (
    <div className="so-card" style={{ boxShadow: '0 0 0 1px var(--accent)33' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 12 }}>
        <div>
          <div style={{ fontFamily: 'var(--cond)', fontWeight: 700, fontSize: 15 }}>Net Conversion <span style={{ color: 'var(--t3)', fontWeight: 400, fontSize: 12 }}>· Shopify net orders ÷ {hasShop ? 'Shopify sessions' : 'GA4 sessions'}</span></div>
          <div className="so-sub" style={{ fontSize: 11.5, marginTop: 3, maxWidth: 680 }}>
            Net orders = paid Website orders, excluding cancelled, ₹0, and MO_Repair / MO_Replacement. Recent 3 days provisional (late orders + session revisions still settle).
            {hasShop
              ? <> Denominator = <b>Shopify sessions</b> — same source as the orders, so this matches your hand-calc{s.calibration != null && <> · Shopify ≈ {s.calibration}× GA4</>}.</>
              : <> Denominator = <b>GA4 sessions</b>. <span style={{ color: '#E8A33D' }}>Shopify-sessions feed pending — add the <code>read_reports</code> scope to the Shopify app to switch to the exact same-source CR.</span></>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 20 }}>
          <BigKpi label={hasShop ? 'CR · Shopify' : 'CR · GA4'} val={fmtCr(hasShop ? s.cr_shopify : s.cr)} tone="var(--accent)" />
          {hasShop && <BigKpi label="CR · GA4" val={fmtCr(s.cr)} />}
          <BigKpi label="Net orders" val={fmtInt(s.net_orders)} />
          <BigKpi label={hasShop ? 'Sessions · Shop' : 'Sessions · GA4'} val={fmtInt(hasShop ? s.shopify_sessions : s.sessions)} />
        </div>
      </div>
      <div style={{ overflowX: 'auto', maxHeight: 340, overflowY: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead><tr style={{ color: 'var(--t2)', fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            {['Date', hasShop ? 'Sessions·Shop' : 'Sessions', 'Net orders', 'Excl.', hasShop ? 'CR·Shop' : 'CR', ...(hasShop ? ['CR·GA4'] : [])].map((h, i) => (
              <th key={h} style={{ textAlign: i === 0 ? 'left' : 'right', padding: '6px 8px', position: 'sticky', top: 0, background: 'var(--surface)' }}>{h}</th>
            ))}
          </tr></thead>
          <tbody>
            {rows.map(r => {
              const p = prev[r.the_date];
              const dod = p && r[primCr] != null && p[primCr] != null ? Number(r[primCr]) - Number(p[primCr]) : null;
              return (
                <tr key={r.the_date} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '6px 8px', fontFamily: 'var(--mono)' }}>{r.the_date}
                    {r.provisional && <span style={{ marginLeft: 6, fontSize: 9.5, color: '#E8A33D', border: '1px solid #E8A33D55', borderRadius: 4, padding: '0 4px' }}>provisional</span>}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'var(--mono)' }}>{fmtInt(r[primSess])}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'var(--mono)' }}>{fmtInt(r.net_orders)}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--t3)' }}>{fmtInt(r.excluded_orders)}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'var(--mono)' }}>
                    <b>{fmtCr(r[primCr])}</b>
                    {dod != null && Math.abs(dod) >= 0.005 && <span style={{ marginLeft: 5, fontSize: 10.5, color: dod > 0 ? 'var(--green)' : 'var(--red)' }}>{dod > 0 ? '▲' : '▼'}{Math.abs(dod).toFixed(2)}</span>}
                  </td>
                  {hasShop && <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--t3)' }}>{fmtCr(r.cr)}</td>}
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
  const fmtCr = (v) => (v == null ? '—' : Number(v).toFixed(2) + '%');
  const prev = {};
  { const chron = [...list].sort((a, b) => (a.the_date < b.the_date ? -1 : 1)); chron.forEach((r, i) => { if (i > 0) prev[r.the_date] = chron[i - 1]; }); }
  return (
    <>
      <div className="so-sub" style={{ fontSize: 11, padding: '4px 18px 0', color: 'var(--t3)', maxWidth: 760 }}>
        Shopify-sourced · same source as your orders. Sessions = Shopify online-store sessions; Net orders excl. cancelled / ₹0 / MO_Repair / MO_Replacement; CR = Net orders ÷ Shopify sessions (your hand-calc). <b style={{ color: 'var(--t2)' }}>Add-to-cart &amp; Checkout aren't exposed by Shopify's API — use the GA4 tab for those.</b>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="so-table" style={{ marginTop: 8 }}>
          <thead><tr>
            <th style={{ textAlign: 'left' }}>Date</th>
            <th style={{ textAlign: 'right' }}>Sessions</th>
            <th style={{ textAlign: 'right' }}>Net orders</th>
            <th style={{ textAlign: 'right' }}>CR · Shopify</th>
            <th style={{ textAlign: 'right' }}>CR · GA4</th>
          </tr></thead>
          <tbody>
            {!hasShop && <tr><td colSpan={5} style={{ color: 'var(--t3)', padding: 14 }}>Shopify sessions not synced for this range yet.</td></tr>}
            {hasShop && list.map(r => {
              const p = prev[r.the_date];
              const dod = p && r.cr_shopify != null && p.cr_shopify != null ? Number(r.cr_shopify) - Number(p.cr_shopify) : null;
              return (
                <tr key={r.the_date}>
                  <td style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{r.the_date}{r.provisional && <span style={{ marginLeft: 6, fontSize: 9.5, color: '#E8A33D', border: '1px solid #E8A33D55', borderRadius: 4, padding: '0 4px' }}>prov</span>}</td>
                  <td className="so-num">{numfmt(r.shopify_sessions)}</td>
                  <td className="so-num">{numfmt(r.net_orders)}</td>
                  <td className="so-num" style={{ color: 'var(--green)' }}>{fmtCr(r.cr_shopify)}{dod != null && Math.abs(dod) >= 0.005 && <span style={{ marginLeft: 5, fontSize: 10.5, color: dod > 0 ? 'var(--green)' : '#EC6A5E' }}>{dod > 0 ? '▲' : '▼'}{Math.abs(dod).toFixed(2)}</span>}</td>
                  <td className="so-num" style={{ color: 'var(--t3)' }}>{fmtCr(r.cr)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
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
      <RangePicker from={from} to={to} onChange={({ from, to }) => { setFrom(from); setTo(to); }}
        right={<><SegmentedToggle options={[['overview', 'Overview'], ['history', 'Daily history']]} value={view} onChange={setView} size="sm" /><span className="so-sub" style={{ marginLeft: 10 }}>GA4 · Website</span></>} />

      {err && <div className="so-card" style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 12 }}>{err}</div>}

      <NetCr data={netcr} />

      {view === 'history' ? (
        !hist ? <div style={{ padding: 60, textAlign: 'center' }}><Spinner /></div> : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2.2fr) minmax(220px,1fr)', gap: 14 }}>
              <div className="so-card">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                  <div className="so-kpi-lbl" style={{ margin: 0 }}>Daily conversion rate · sessions → purchase</div>
                  {changes.length > 0 && <span className="so-sub" style={{ fontSize: 10.5 }}><span className="so-dot" style={{ background: 'var(--accent)', marginRight: 5 }} />{changes.length} website change{changes.length > 1 ? 's' : ''}</span>}
                </div>
                <DailyTrend rows={hist} changes={changes} />
              </div>
              {(() => {
                const wd = (hist || []).filter(r => Number(r.sessions) > 0);
                const v = wd.map(r => Number(r.purchase_cr) || 0);
                const avg = v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
                const best = wd.length ? wd.reduce((m, r) => Number(r.purchase_cr) > Number(m.purchase_cr) ? r : m) : null;
                const worst = wd.length ? wd.reduce((m, r) => Number(r.purchase_cr) < Number(m.purchase_cr) ? r : m) : null;
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    <div className="so-card" style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 4 }}>
                      <div className="so-kpi-lbl">Avg daily conversion</div>
                      <span className="so-kpi-val" style={{ fontSize: 30, color: 'var(--green)' }}>{avg.toFixed(2)}%</span>
                      <span className="so-sub" style={{ fontSize: 11 }}>{wd.length} days in range</span>
                    </div>
                    <div className="so-card" style={{ flex: 1 }}>
                      <div className="so-kpi-lbl">Best / worst day</div>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 12, marginTop: 6, lineHeight: 1.7 }}>
                        <div style={{ color: 'var(--green)' }}>▲ {best?.the_date} · {Number(best?.purchase_cr || 0).toFixed(2)}%</div>
                        <div style={{ color: '#EC6A5E' }}>▼ {worst?.the_date} · {Number(worst?.purchase_cr || 0).toFixed(2)}%</div>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>
            <div className="so-card" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, padding: '16px 18px 0' }}>
                <div className="so-kpi-lbl" style={{ margin: 0 }}>Daily funnel <span className="so-sub" style={{ fontSize: 10, textTransform: 'none', letterSpacing: 0 }}>· <span style={{ color: 'var(--green)' }}>▲</span>/<span style={{ color: '#EC6A5E' }}>▼</span> vs previous day</span></div>
                <SegmentedToggle options={[['ga4', 'GA4'], ['shopify', 'Shopify']]} value={histSrc} onChange={setHistSrc} size="sm" />
              </div>
              {histSrc === 'ga4' ? (
              <div style={{ overflowX: 'auto' }}>
                <table className="so-table" style={{ marginTop: 8 }}>
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
                    {histSort.sorted.length === 0 && <tr><td colSpan={7} style={{ color: 'var(--t3)', padding: 14 }}>No snapshot days in this range yet.</td></tr>}
                    {histSort.sorted.map(r => {
                      const prev = prevByDate[r.the_date];
                      return (
                      <tr key={r.the_date}>
                        <td style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{r.the_date}</td>
                        <td className="so-num">{numfmt(r.sessions)}<Tick now={r.sessions} prev={prev?.sessions} /></td>
                        <td className="so-num">{numfmt(r.add_to_carts)}<Tick now={r.add_to_carts} prev={prev?.add_to_carts} /></td>
                        <td className="so-num">{numfmt(r.checkouts)}<Tick now={r.checkouts} prev={prev?.checkouts} /></td>
                        <td className="so-num">{numfmt(r.purchases)}<Tick now={r.purchases} prev={prev?.purchases} /></td>
                        <td className="so-num">{fmtPct(r.atc_rate)}<Tick now={r.atc_rate} prev={prev?.atc_rate} /></td>
                        <td className="so-num" style={{ color: 'var(--green)' }}>{fmtPct(r.purchase_cr)}<Tick now={r.purchase_cr} prev={prev?.purchase_cr} /></td>
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
                <div className="so-kpi-lbl" style={{ marginBottom: 10 }}>Changes &amp; events in range · <span style={{ color: 'var(--t3)' }}>what shipped / stock moves</span></div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                  {changes.slice().sort((a, b) => (a.the_date < b.the_date ? 1 : -1)).map(c => (
                    <div key={c.id} style={{ display: 'flex', gap: 12, alignItems: 'baseline', borderBottom: '1px solid var(--surface2)', paddingBottom: 8 }}>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--t2)', width: 88, flexShrink: 0 }}>{c.the_date}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, color: 'var(--t1)', display: 'flex', alignItems: 'center' }}>{streamDot(c.stream)}<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</span>
                          {c.workstream && c.workstream !== 'stock' && <span className="so-sub" style={{ marginLeft: 8, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.4, flexShrink: 0 }}>{c.workstream}{c.surface ? ` · ${c.surface}` : ''}</span>}
                        </div>
                        {c.hypothesis && <div className="so-sub" style={{ fontSize: 11.5, marginTop: 2 }}>{c.hypothesis}</div>}
                      </div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                        {c.status && <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: c.status === 'reverted' ? '#EC6A5E' : 'var(--t3)' }}>{c.status}</span>}
                        <span style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600, color: c.result && c.result !== 'pending' ? 'var(--green)' : 'var(--t3)' }}>{c.result || '—'}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="so-sub" style={{ fontSize: 10.5, color: 'var(--t3)' }}>Frozen daily snapshot of the GA4 website funnel — recent days refresh as GA4 finalises, older days lock. Markers: <span style={{ color: 'var(--accent)' }}>▸ website changes</span> (from the Website repo change-log) · <span style={{ color: '#2DA8F0' }}>■ stock in/out</span> (native Shopify inventory, forward-only). Likely drivers are heuristic time-proximity — correlation, not proof.</div>
          </>
        )
      ) : (
      !rows ? <div style={{ padding: 60, textAlign: 'center' }}><Spinner /></div> : (
        <>
          {/* funnel viz + headline conversion */}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2.2fr) minmax(220px,1fr)', gap: 14 }}>
            <div className="so-card">
              <div className="so-kpi-lbl" style={{ marginBottom: 16 }}>Conversion funnel</div>
              {sessions === 0
                ? <div style={{ color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 12, padding: '28px 0', textAlign: 'center' }}>No traffic in this range yet.</div>
                : <Funnel steps={steps} />}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div className="so-card" style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 4 }}>
                <div className="so-kpi-lbl">Overall conversion</div>
                <span className="so-kpi-val" style={{ fontSize: 34, color: 'var(--green)' }}>{cr.toFixed(2)}%</span>
                <span className="so-sub" style={{ fontSize: 11 }}>sessions → purchase</span>
              </div>
              <div className="so-card" style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 4 }}>
                <div className="so-kpi-lbl">Revenue</div>
                <span className="so-kpi-val" style={{ fontSize: 26 }}>{inr(revenue)}</span>
                <span className="so-sub" style={{ fontSize: 11 }}>GA4 purchase value</span>
              </div>
            </div>
          </div>

          {/* by source */}
          <div className="so-card" style={{ padding: 0, overflow: 'hidden' }}>
            <div className="so-kpi-lbl" style={{ padding: '16px 18px 0' }}>By traffic source</div>
            <table className="so-table" style={{ marginTop: 8 }}>
              <thead><tr>
                <SortHeader k="src_group" label="Source" sort={srcSort} /><SortHeader k="sessions" label="Sessions" sort={srcSort} numeric /><SortHeader k="add_to_carts" label="Add to cart" sort={srcSort} numeric />
                <SortHeader k="checkouts" label="Checkouts" sort={srcSort} numeric /><SortHeader k="purchases" label="Purchases" sort={srcSort} numeric /><SortHeader k="conv" label="Conv. rate" sort={srcSort} numeric />
              </tr></thead>
              <tbody>
                {srcSort.sorted.length === 0 && <tr><td colSpan={6} style={{ color: 'var(--t3)', padding: 14 }}>No traffic in this range yet — connector may still be backfilling.</td></tr>}
                {srcSort.sorted.map((r, i) => {
                  const s = Number(r.sessions || 0), pu = Number(r.purchases || 0);
                  return (<tr key={i}>
                    <td>{r.src_group || '—'}</td>
                    <td className="so-num">{numfmt(r.sessions)}</td>
                    <td className="so-num">{numfmt(r.add_to_carts)}</td>
                    <td className="so-num">{numfmt(r.checkouts)}</td>
                    <td className="so-num">{numfmt(r.purchases)}</td>
                    <td className="so-num">{s > 0 ? (pu / s * 100).toFixed(2) + '%' : '—'}</td>
                  </tr>);
                })}
              </tbody>
            </table>
          </div>

          {/* ── Checkout & payment funnel (Razorpay) ── */}
          {(() => {
            const f = (pay && pay.funnel) || {}, rc = (pay && pay.recon) || {};
            const attempts = Number(f.attempts || 0), captured = Number(f.captured || 0), failed = Number(f.failed || 0);
            const sr = Number(f.success_rate || 0), capAmt = Number(f.captured_amount || 0), cod = Number(f.cod_orders || 0);
            const byMethod = f.by_method || {}, byReason = f.by_failure_reason || {};
            const methods = Object.entries(byMethod).sort((a, b) => (Number(b[1].attempts) || 0) - (Number(a[1].attempts) || 0));
            const reasons = Object.entries(byReason).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 8);
            const maxM = Math.max(...methods.map(m => Number(m[1].attempts) || 0), 1);
            const maxR = Math.max(...reasons.map(r => Number(r[1]) || 0), 1);
            const stat = (lbl, val, sub, color) => (
              <div className="so-card" style={{ flex: 1, minWidth: 120, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div className="so-kpi-lbl">{lbl}</div>
                <span className="so-kpi-val" style={{ fontSize: 22, color: color || 'var(--t1)' }}>{val}</span>
                {sub ? <span className="so-sub" style={{ fontSize: 11 }}>{sub}</span> : null}
              </div>
            );
            return (
              <div className="so-card">
                <div className="so-kpi-lbl" style={{ marginBottom: 12 }}>Checkout &amp; payment · <span style={{ color: 'var(--t3)' }}>Razorpay</span></div>
                {!pay ? <div style={{ padding: 20, textAlign: 'center' }}><Spinner /></div>
                  : (attempts === 0 && cod === 0) ? <div style={{ color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 12, padding: '8px 0' }}>No payment data in this range yet — connector backfilling / webhook warming up.</div>
                    : (
                      <>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
                          {stat('Prepaid attempts', numfmt(attempts))}
                          {stat('Captured', numfmt(captured), `${sr.toFixed(1)}% success`, 'var(--green)')}
                          {stat('Failed', numfmt(failed), failed ? `${(100 * failed / Math.max(attempts, 1)).toFixed(1)}% of attempts` : null, '#EC6A5E')}
                          {stat('COD orders', numfmt(cod), 'captured on delivery', 'var(--t2)')}
                          {stat('Captured value', inr(capAmt))}
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 18 }}>
                          <div>
                            <div className="so-sub" style={{ marginBottom: 8 }}>Why payments fail</div>
                            {reasons.length === 0 ? <div style={{ color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 11 }}>No failures in range.</div>
                              : reasons.map(([reason, c]) => (
                                <div key={reason} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                                  <div style={{ width: 130, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{reason}</div>
                                  <div style={{ flex: 1, height: 13, background: 'var(--surface2)', borderRadius: 3, overflow: 'hidden' }}>
                                    <div style={{ width: `${(Number(c) / maxR) * 100}%`, height: '100%', background: '#EC6A5E', opacity: 0.8 }} />
                                  </div>
                                  <div style={{ width: 40, textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11 }}>{numfmt(c)}</div>
                                </div>
                              ))}
                          </div>
                          <div>
                            <div className="so-sub" style={{ marginBottom: 8 }}>By payment method (captured / attempts)</div>
                            {methods.map(([m, o]) => {
                              const a = Number(o.attempts) || 0, cap = Number(o.captured) || 0;
                              return (
                                <div key={m} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                                  <div style={{ width: 90, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t2)' }}>{m}</div>
                                  <div style={{ flex: 1, height: 13, background: 'var(--surface2)', borderRadius: 3, overflow: 'hidden' }}>
                                    <div style={{ width: `${(a / maxM) * 100}%`, height: '100%', background: '#F2CD1A', opacity: 0.85 }} />
                                  </div>
                                  <div style={{ width: 72, textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11 }}>{numfmt(cap)}/{numfmt(a)}</div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                        <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--surface2)' }}>
                          <div className="so-sub" style={{ marginBottom: 8 }}>Reconciliation · {from} → {to}</div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t2)' }}>
                            <span>GA4 purchases <b style={{ color: 'var(--t1)' }}>{numfmt(rc.ga4_purchases)}</b></span>
                            <span style={{ color: 'var(--t3)' }}>·</span>
                            <span>Shopify orders <b style={{ color: 'var(--t1)' }}>{numfmt(rc.shopify_orders)}</b></span>
                            <span style={{ color: 'var(--t3)' }}>·</span>
                            <span>Razorpay captured <b style={{ color: 'var(--t1)' }}>{numfmt(rc.razorpay_captured)}</b> <span style={{ color: 'var(--t3)' }}>({inr(rc.razorpay_captured_amount)})</span></span>
                          </div>
                          <div className="so-sub" style={{ fontSize: 10.5, marginTop: 6 }}>Prepaid captures come from Razorpay; COD orders have no online capture (they appear in Shopify orders, not here). GA4 typically over-counts slightly.</div>
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
