'use client';
/* ════════════════════════════════════════════════════════════════════
   Support Analytics Dashboard (Pruthvi #bugs 2026-07-14) — live off
   cs_tickets, replacing the manual "Complaints Dashboard" sheet.
   Panels mirror the sheet: KPI band (+ Within/After 3 days), product ×
   issue-category matrix, by issue-category, by LOT product-line, by sale
   channel + support channel, top sub-categories, monthly product +
   category trends. One getSupportAnalytics call (gated cs_reports_view).
   Spec: docs/superpowers/specs/2026-07-16-pitstop-support-analytics-dashboard-design.md
   ════════════════════════════════════════════════════════════════════ */
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, EmptyState } from '@throttle/ui';
import { BarChart3 } from 'lucide-react';
import { csopsGet } from '../../../lib/csopsFetch.js';
import { KpiCard, Panel, selectStyle, inputStyle } from '../../../components/kit/index.js';
import { TrendChart } from '../../../components/kit/Chart.js';

const SERIES_COLORS = ['#7b93ff', '#25D366', '#F59E0B', '#E1306C', '#0084FF', '#a78bfa', '#f472b6', '#34d399', '#fbbf24', '#60a5fa', '#f87171', '#c084fc'];

function isoStart(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.toISOString(); }
function isoEnd(d)   { const x = new Date(d); x.setHours(23, 59, 59, 999); return x.toISOString(); }

// Resolve a preset → {from, to} Date objects (local; IST offset handled server-side).
function presetRange(preset) {
  const now = new Date();
  if (preset === 'today')  return { from: now, to: now };
  if (preset === 'mtd')    return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: now };
  if (preset === 'last')   return { from: new Date(now.getFullYear(), now.getMonth() - 1, 1), to: new Date(now.getFullYear(), now.getMonth(), 0) };
  if (preset === 'year')   return { from: new Date(now.getFullYear(), 0, 1), to: now };
  return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: now };
}

export default function AnalyticsPage() {
  const { session, perms } = useAuth();
  const canView = !!perms?.cs_reports_view;

  const [preset, setPreset] = useState('mtd');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const range = useMemo(() => {
    if (preset === 'custom' && customFrom && customTo) return { from: isoStart(customFrom), to: isoEnd(customTo) };
    const r = presetRange(preset);
    return { from: isoStart(r.from), to: isoEnd(r.to) };
  }, [preset, customFrom, customTo]);

  useEffect(() => {
    if (!session || !canView) { setLoading(false); return; }
    let alive = true;
    setLoading(true);
    csopsGet('getSupportAnalytics', { from: range.from, to: range.to }, session)
      .then(d => { if (alive) { setData(d); setError(null); } })
      .catch(e => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [session, canView, range.from, range.to]);

  if (!canView) return <EmptyState icon={<BarChart3 size={28} />} title="No access" message="You need the reports permission to view analytics." />;

  const PRESETS = [['today', 'Today'], ['mtd', 'MTD'], ['last', 'Last month'], ['year', 'This year'], ['custom', 'Custom']];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 4, padding: 4, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
          {PRESETS.map(([id, label]) => (
            <button key={id} onClick={() => setPreset(id)} style={{
              fontFamily: 'var(--f-ui)', fontSize: 12, fontWeight: 600, padding: '5px 12px', borderRadius: 5,
              border: 'none', cursor: 'pointer',
              background: preset === id ? 'var(--surface-3)' : 'transparent',
              color: preset === id ? 'var(--t1)' : 'var(--t3)' }}>{label}</button>
          ))}
        </div>
        {preset === 'custom' && (
          <>
            <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} style={inputStyle} />
            <span style={{ color: 'var(--t3)' }}>→</span>
            <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} style={inputStyle} />
          </>
        )}
      </div>

      {error && <div style={{ padding: 12, background: 'var(--bad-bg)', color: 'var(--bad-fg)', borderRadius: 8, fontSize: 13 }}>{error}</div>}
      {loading ? <div style={{ padding: 60, textAlign: 'center' }}><Spinner /></div>
        : !data ? <EmptyState icon={<BarChart3 size={28} />} title="No data" message="No complaints in this range." />
        : <Dashboard data={data} />}
    </div>
  );
}

function Dashboard({ data }) {
  const k = data.kpis || {};
  return (
    <>
      {/* KPI band */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        <KpiCard label="Total Complaints" value={k.total ?? 0} icon="list" />
        <KpiCard label="Within 3 Days" value={k.within_3d ?? 0} tone="var(--ok-fg)" sub="of purchase" icon="check" />
        <KpiCard label="After 3 Days" value={k.after_3d ?? 0} tone="var(--warn-fg)" sub="of purchase" icon="clock" />
        <KpiCard label="Ageing Unknown" value={k.ageing_unknown ?? 0} tone="var(--t3)" sub={k.ageing_unknown ? 'no purchase date on file' : ''} icon="alert" />
      </div>

      {/* Product × issue-category matrix */}
      <Panel title="Complaints by Product" sub="rows = product · columns = issue category">
        <ProductMatrix matrix={data.by_product_matrix} />
      </Panel>

      {/* By issue category + top sub-categories */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
        <Panel title="Complaints by Issue Category"><RankedList rows={data.by_issue_category} showPct /></Panel>
        <Panel title="Top Issue Sub-categories"><RankedList rows={data.top_subcategories} /></Panel>
      </div>

      {/* Product line + channels */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
        <Panel title="By Product Line (LOT line)"><RankedList rows={data.by_product_line} showPct /></Panel>
        <Panel title="By Sale Channel"><RankedList rows={data.by_sale_channel} showPct /></Panel>
        <Panel title="By Support Channel"><RankedList rows={data.by_support_channel} showPct /></Panel>
      </div>

      {/* Monthly trends */}
      <Panel title="Monthly Product Issue Trend">
        <TrendBlock series={data.monthly_product_trend} dimLabel="Product" />
      </Panel>
      <Panel title="Monthly Category Trend">
        <TrendBlock series={data.monthly_category_trend} dimLabel="Issue category" />
      </Panel>
    </>
  );
}

function ProductMatrix({ matrix }) {
  if (!matrix || !matrix.products?.length) return <Empty />;
  const cats = matrix.categories || [];
  const max = Math.max(1, ...matrix.products.flatMap(p => cats.map(c => p.cats[c] || 0)));
  const totals = cats.map(c => matrix.products.reduce((s, p) => s + (p.cats[c] || 0), 0));
  const grand = matrix.products.reduce((s, p) => s + p.total, 0);
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12.5 }}>
        <thead>
          <tr>
            <th style={thL}>Product</th>
            <th style={thR}>Total</th>
            {cats.map(c => <th key={c} style={thR} title={c}>{abbr(c)}</th>)}
          </tr>
        </thead>
        <tbody>
          {matrix.products.map(p => (
            <tr key={p.product}>
              <td style={tdL}>{p.product}</td>
              <td style={{ ...tdR, fontWeight: 700 }}>{p.total}</td>
              {cats.map(c => {
                const v = p.cats[c] || 0;
                return <td key={c} style={{ ...tdR, background: heat(v, max) }}>{v || ''}</td>;
              })}
            </tr>
          ))}
          <tr>
            <td style={{ ...tdL, fontWeight: 700, borderTop: '2px solid var(--border)' }}>TOTAL</td>
            <td style={{ ...tdR, fontWeight: 700, borderTop: '2px solid var(--border)' }}>{grand}</td>
            {totals.map((t, i) => <td key={i} style={{ ...tdR, fontWeight: 700, borderTop: '2px solid var(--border)' }}>{t}</td>)}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function RankedList({ rows, showPct }) {
  if (!rows || !rows.length) return <Empty />;
  const max = Math.max(1, ...rows.map(r => r.count));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      {rows.map(r => (
        <div key={r.name} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ flex: '0 0 42%', fontSize: 12.5, color: 'var(--t2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.name}>{r.name}</span>
          <div style={{ flex: 1, height: 8, background: 'var(--surface-2)', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ width: `${(r.count / max) * 100}%`, height: '100%', background: 'var(--accent)', borderRadius: 4 }} />
          </div>
          <span className="num" style={{ flex: '0 0 auto', fontSize: 12.5, fontWeight: 700, color: 'var(--t1)', minWidth: 34, textAlign: 'right' }}>{r.count}</span>
          {showPct && <span className="num" style={{ flex: '0 0 auto', fontSize: 11, color: 'var(--t3)', minWidth: 42, textAlign: 'right' }}>{r.pct}%</span>}
        </div>
      ))}
    </div>
  );
}

// Monthly trend: total-cases line chart + the full month × dimension table (sheet-faithful).
function TrendBlock({ series, dimLabel }) {
  if (!series || series.length === 0) return <Empty />;
  // union of dimension keys across months, ordered by total desc; top 8 as chart series.
  const totalsByDim = {};
  for (const row of series) for (const kk of Object.keys(row)) {
    if (kk === 'month' || kk === 'total') continue;
    totalsByDim[kk] = (totalsByDim[kk] || 0) + row[kk];
  }
  const dims = Object.entries(totalsByDim).sort((a, b) => b[1] - a[1]).map(([n]) => n);
  const chartDims = dims.slice(0, 8);
  const chartSeries = chartDims.map((d, i) => ({ key: d, name: d, color: SERIES_COLORS[i % SERIES_COLORS.length], kind: 'area', stackId: 'a' }));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <TrendChart data={series} xKey="month" series={chartSeries} height={240} xLabel="Month" showLegend />
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12.5 }}>
          <thead>
            <tr>
              <th style={thL}>Month</th>
              <th style={thR}>Total</th>
              {dims.map(d => <th key={d} style={thR} title={d}>{abbr(d)}</th>)}
            </tr>
          </thead>
          <tbody>
            {series.map(row => (
              <tr key={row.month}>
                <td style={tdL}>{row.month}</td>
                <td style={{ ...tdR, fontWeight: 700 }}>{row.total}</td>
                {dims.map(d => <td key={d} style={tdR}>{row[d] || ''}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Empty() { return <div style={{ color: 'var(--t3)', fontSize: 12, padding: '20px 0', textAlign: 'center' }}>No data in this range.</div>; }
function abbr(s) { return String(s).length > 16 ? String(s).slice(0, 15) + '…' : s; }
function heat(v, max) {
  if (!v) return 'transparent';
  const a = 0.08 + (v / max) * 0.4;
  return `rgba(123, 147, 255, ${a.toFixed(3)})`;
}

const thL = { textAlign: 'left', padding: '7px 10px', fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--t3)', borderBottom: '1px solid var(--border)', position: 'sticky', left: 0, background: 'var(--surface)' };
const thR = { textAlign: 'right', padding: '7px 10px', fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };
const tdL = { textAlign: 'left', padding: '6px 10px', color: 'var(--t1)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', position: 'sticky', left: 0, background: 'var(--surface)' };
const tdR = { textAlign: 'right', padding: '6px 10px', color: 'var(--t2)', borderBottom: '1px solid var(--border)', fontFamily: 'var(--f-mono)' };
