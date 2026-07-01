'use client';
/* ════════════════════════════════════════════════════════════
   COSTS — Daily production cost per unit. Running daily tally
   (V2 production-only + V3 full ₹/unit) with a trend chart +
   range filter, plus per-day detail (breakdown + per-product).
   factory_cost_view only. Aggregate only — no salaries.
   ════════════════════════════════════════════════════════════ */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { workerFetch } from '@throttle/db';
import { Spinner } from '@throttle/ui';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import { Panel, FilterChip } from '../../../components/kit/index.js';
import { Coins, Factory, Boxes, TrendingUp } from 'lucide-react';

// ── date helpers (local = IST on the team's machines) ──
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => new Date();
function rangeFor(preset, cFrom, cTo) {
  const t = today();
  if (preset === 'today') return { from: iso(t), to: iso(t) };
  if (preset === 'week') { const d = new Date(t); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); return { from: iso(d), to: iso(t) }; } // Mon→today
  if (preset === 'month') return { from: iso(new Date(t.getFullYear(), t.getMonth(), 1)), to: iso(t) };
  if (preset === 'lastmonth') return { from: iso(new Date(t.getFullYear(), t.getMonth() - 1, 1)), to: iso(new Date(t.getFullYear(), t.getMonth(), 0)) };
  return { from: cFrom, to: cTo };
}
const rup = (n) => n == null ? '—' : '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const num = (n) => n == null ? '—' : Number(n).toLocaleString('en-IN');

const PRESETS = [
  { k: 'today', label: 'Today' }, { k: 'week', label: 'This Week' },
  { k: 'month', label: 'This Month' }, { k: 'lastmonth', label: 'Last Month' },
  { k: 'custom', label: 'Custom' },
];

export default function DailyCostPage() {
  const { session, perms } = useAuth();
  const [preset, setPreset] = useState('month');
  const [cFrom, setCFrom] = useState(iso(new Date(today().getFullYear(), today().getMonth(), 1)));
  const [cTo, setCTo] = useState(iso(today()));
  const { from, to } = useMemo(() => rangeFor(preset, cFrom, cTo), [preset, cFrom, cTo]);

  const [series, setSeries] = useState(null);   // { rows: [{date,cars,v2_per_unit,v3_per_unit}] }
  const [detailDate, setDetailDate] = useState(iso(today()));
  const [detail, setDetail] = useState(null);
  const [err, setErr] = useState(null);

  const loadSeries = useCallback(async () => {
    if (!session) return;
    setSeries(null); setErr(null);
    try {
      const r = await workerFetch('getFactoryCostSeries', { from, to }, session);
      setSeries(r.data);
      // default the detail day to the latest day in the range that has data
      const rows = r.data?.rows || [];
      if (rows.length) setDetailDate(rows[rows.length - 1].date); else setDetailDate(to);
    } catch (e) { setErr(e.message || 'Failed'); }
  }, [session, from, to]);
  useEffect(() => { loadSeries(); }, [loadSeries]);

  const loadDetail = useCallback(async () => {
    if (!session || !detailDate) return;
    setDetail(null);
    try { const r = await workerFetch('getFactoryCostDaily', { date: detailDate }, session); setDetail(r.data); }
    catch { setDetail(false); }
  }, [session, detailDate]);
  useEffect(() => { loadDetail(); }, [loadDetail]);

  if (perms && !perms.factory_cost_view) return <div style={{ color: 'var(--t3)', padding: 20 }}>Requires factory_cost_view.</div>;

  const rows = series?.rows || [];
  const b = detail?.breakdown;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1040 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 20, color: 'var(--t1)', margin: 0 }}><Coins size={18} style={{ verticalAlign: '-3px' }} /> Daily Cost / Unit</h1>
      </div>

      {/* range filter */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        {PRESETS.map(p => <FilterChip key={p.k} active={preset === p.k} onClick={() => setPreset(p.k)}>{p.label}</FilterChip>)}
        {preset === 'custom' && (
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', marginLeft: 4 }}>
            <input type="date" value={cFrom} onChange={e => setCFrom(e.target.value)} style={inp} />
            <span style={{ color: 'var(--t3)' }}>→</span>
            <input type="date" value={cTo} onChange={e => setCTo(e.target.value)} style={inp} />
          </span>
        )}
      </div>

      {err && <div style={{ color: 'var(--red)' }}>{err}</div>}
      {!series && !err && <Spinner />}

      {series && (
        <>
          {/* trend chart */}
          <Panel title="Cost per unit — daily trend" icon={TrendingUp}>
            {rows.length === 0 ? (
              <div style={{ color: 'var(--t3)', padding: '30px 0', textAlign: 'center' }}>No production in this range.</div>
            ) : (
              <div style={{ height: 280 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={rows} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="date" stroke="var(--t4)" tick={tick} tickFormatter={d => d.slice(5)} />
                    <YAxis stroke="var(--t4)" tick={tick} tickFormatter={v => '₹' + v} width={56} />
                    <Tooltip contentStyle={ttip} labelStyle={{ color: 'var(--t2)' }} formatter={(v, n) => [rup(v), n]} />
                    <Legend wrapperStyle={{ fontSize: 11, fontFamily: 'var(--font-ui)' }} />
                    <Line type="monotone" dataKey="v2_per_unit" name="Production-only (V2)" stroke="var(--yellow)" strokeWidth={2} dot={{ r: 2 }} activeDot={{ r: 4 }} />
                    <Line type="monotone" dataKey="v3_per_unit" name="Full (V3)" stroke="var(--green)" strokeWidth={2} dot={{ r: 2 }} activeDot={{ r: 4 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </Panel>

          {/* running daily tally */}
          <Panel title="Daily tally" icon={Boxes}>
            <div style={{ overflowX: 'auto' }}>
              <table style={tbl}>
                <thead><tr>
                  <th style={th}>Date</th><th style={thNum}>Cars</th>
                  <th style={thNum}>V2 /unit</th><th style={thNum}>V3 /unit</th>
                </tr></thead>
                <tbody>
                  {rows.length === 0 && <tr><td style={td} colSpan={4}><span style={{ color: 'var(--t3)' }}>No production in this range.</span></td></tr>}
                  {[...rows].reverse().map((r, i) => (
                    <tr key={i} onClick={() => setDetailDate(r.date)} style={{ cursor: 'pointer', background: r.date === detailDate ? 'var(--surface-2)' : 'transparent' }}>
                      <td style={td}>{r.date}</td>
                      <td style={tdNum}>{num(r.cars)}</td>
                      <td style={tdNum}>{rup(r.v2_per_unit)}</td>
                      <td style={tdNum}>{rup(r.v3_per_unit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--t3)' }}>Click a day to see its breakdown below.</div>
          </Panel>

          {/* per-day detail */}
          <Panel title={`Day detail — ${detailDate}`} icon={Factory}>
            {detail === false && <div style={{ color: 'var(--t3)' }}>Could not load this day.</div>}
            {!detail && detail !== false && <Spinner />}
            {detail && (
              <>
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 14 }}>
                  <Stat label="Cars packed" value={num(detail.cars_total)} accent="var(--blue)" />
                  <Stat label="Production-only / unit (V2)" value={rup(detail.v2?.per_unit)} accent="var(--yellow)" />
                  <Stat label="Full / unit (V3)" value={rup(detail.v3?.per_unit)} accent="var(--green)" />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(155px,1fr))', gap: 10, marginBottom: 14 }}>
                  <Cat label="Production manpower" v={rup(b?.prod_manpower)} />
                  <Cat label="Store manpower" v={rup(b?.store_manpower)} />
                  <Cat label="Dispatch manpower" v={rup(b?.dispatch_manpower)} />
                  <Cat label="Fixed (rent/elec/other)" v={rup(b?.fixed)} />
                  <Cat label="Overhead (admin/security)" v={rup(b?.overhead)} />
                  <Cat label="Overtime (incl. above)" v={rup(b?.ot_total)} />
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={tbl}>
                    <thead><tr>
                      <th style={th}>Product</th><th style={thNum}>Cars</th>
                      <th style={thNum}>V2 alloc</th><th style={thNum}>V2 /unit</th>
                      <th style={thNum}>V3 alloc</th><th style={thNum}>V3 /unit</th>
                    </tr></thead>
                    <tbody>
                      {(detail.per_product || []).length === 0 && <tr><td style={td} colSpan={6}><span style={{ color: 'var(--t3)' }}>No cars packed this day.</span></td></tr>}
                      {(detail.per_product || []).map((p, i) => (
                        <tr key={i}>
                          <td style={td}>{p.product}</td>
                          <td style={tdNum}>{num(p.cars)}</td>
                          <td style={tdNum}>{rup(p.v2_alloc)}</td>
                          <td style={tdNum}>{rup(p.v2_per_unit)}</td>
                          <td style={tdNum}>{rup(p.v3_alloc)}</td>
                          <td style={tdNum}>{rup(p.v3_per_unit)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--t3)' }}>
                  Working days this month (Mon–Sat): {detail.working_days} · OT ₹{detail.ot_rate}/hr (avg). V2 = production manpower + fixed. V3 = V2 + store + dispatch + overhead. Add the ₹/unit onto each product's COGS.
                </div>
              </>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, accent }) {
  return (
    <div style={{ flex: '1 1 200px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderLeft: `3px solid ${accent}`, borderRadius: 'var(--r-sm)', padding: '12px 14px' }}>
      <div style={{ fontSize: 11, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 24, color: 'var(--t1)', marginTop: 3 }}>{value}</div>
    </div>
  );
}
function Cat({ label, v }) {
  return (
    <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '9px 11px' }}>
      <div style={{ fontSize: 10.5, color: 'var(--t3)' }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 14, color: 'var(--t1)', marginTop: 2 }}>{v}</div>
    </div>
  );
}

const inp = { background: 'var(--surface-2)', color: 'var(--t1)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '6px 9px', fontSize: 12.5, outline: 'none' };
const tbl = { width: '100%', borderCollapse: 'collapse', fontSize: 13 };
const th = { textAlign: 'left', padding: '7px 10px', fontSize: 11, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };
const thNum = { ...th, textAlign: 'right' };
const td = { padding: '8px 10px', borderBottom: '1px solid var(--border)', color: 'var(--t1)' };
const tdNum = { ...td, fontFamily: 'var(--font-mono)', textAlign: 'right' };
const tick = { fontSize: 11, fontFamily: 'var(--font-ui)', fill: 'var(--t3)' };
const ttip = { background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 8, fontSize: 12 };
