'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, EmptyState } from '@throttle/ui';
import { BarChart3, Download } from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell,
} from 'recharts';
import { ignitionopsGet } from '../../../lib/ignitionopsFetch.js';
import { istToday } from '../../../lib/istDate.js';
import { Card, Segmented, Tile } from '../../../components/ui/index.js';

function inr(n) { return n == null || isNaN(n) ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`; }
const TIER_LABELS = { nano: 'Nano', micro: 'Micro', macro: 'Macro', brand: 'Brand', store: 'Store', untyped: 'Untyped' };
function tierLabel(t) { return TIER_LABELS[t] || (t ? t[0].toUpperCase() + t.slice(1) : '—'); }
const ORANGE = 'var(--accent)';
const GRID = 'var(--border)';

// Range presets map onto the page's from/to state (IST dates). The active preset is DERIVED from
// from/to, so editing a date by hand deselects it. 'all' = a floor date before any deal existed.
const ALL_FROM = '2020-01-01';
function shiftDays(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);
}
function presetRange(key, today) {
  if (key === '30d') return [shiftDays(today, 30), today];
  if (key === '90d') return [shiftDays(today, 90), today];
  if (key === 'ytd') return [`${today.slice(0, 4)}-01-01`, today];
  return [ALL_FROM, today];
}
const PRESETS = [{ value: '30d', label: '30d' }, { value: '90d', label: '90d' }, { value: 'ytd', label: 'YTD' }, { value: 'all', label: 'All' }];
// Histogram band colours (worker returns 5 bands each): ROAS higher = better, CPM lower = better.
const ROAS_TONES = ['var(--state-error-fg)', 'var(--state-warning-fg)', 'var(--state-warning-fg)', 'var(--state-success-fg)', 'var(--state-success-fg)'];
const CPM_TONES = ['var(--state-success-fg)', 'var(--state-success-fg)', 'var(--state-warning-fg)', 'var(--state-error-fg)', 'var(--state-error-fg)'];

export default function ReportsPage() {
  const { session, perms } = useAuth();
  const canView = !!perms?.ignition_reports_view;

  const today = istToday();
  const [from, setFrom] = useState(() => presetRange('ytd', istToday())[0]);
  const [to, setTo] = useState(() => istToday());
  const activePreset = PRESETS.find(p => { const [f, t] = presetRange(p.value, today); return f === from && t === to; })?.value ?? null;
  function pickPreset(k) { const [f, t] = presetRange(k, today); setFrom(f); setTo(t); }
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!session || !canView) { setLoading(false); return; }
    let alive = true;
    setLoading(true);
    ignitionopsGet('getReports', { from: `${from}T00:00:00`, to: `${to}T23:59:59` }, session)
      .then(d => { if (alive) { setData(d); setError(null); } })
      .catch(e => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [session, from, to, canView]);

  function exportCsv() {
    if (!data) return;
    const lines = [];
    lines.push(`Ignition Report,${from} to ${to}`);
    lines.push('');
    // S373: every "Views" figure the worker returns is ORGANIC (views − paid); paid sits beside it.
    lines.push('Totals,Deals,Spend,Orders,Organic views,Paid views,Conversions value,Avg CPM,Avg ROAS');
    const t = data.totals;
    lines.push(`,${t.deals},${t.spend},${t.orders},${t.views},${t.paid_views ?? 0},${t.conversions_value},${t.avg_cpm ?? ''},${t.avg_roas ?? ''}`);
    lines.push('');
    lines.push('Spend by month,Month,Spend,Deals,Orders,Organic views,Paid views');
    for (const m of data.by_month) lines.push(`,${m.month},${m.spend},${m.deals},${m.orders},${m.views},${m.paid_views ?? 0}`);
    lines.push('');
    lines.push('Spend by product,Product,Deals,Spend,Orders,Organic views,Paid views');
    for (const p of data.by_product) lines.push(`,${p.name},${p.deals},${p.spend},${p.orders},${p.views},${p.paid_views ?? 0}`);
    lines.push('');
    lines.push('Top performers,Engagement,Influencer,Product,Orders,Conv value,Spend,ROAS');
    for (const p of data.top_performers) lines.push(`,${p.engagement_no},${p.influencer},${p.product},${p.orders},${p.conversions_value},${p.spend},${p.roas ?? ''}`);
    lines.push('');
    lines.push('By tier,Tier,Influencers,Deals,Organic views,Paid views,Avg organic views/inf,Likes,Shares,Spend,Orders,Conv value');
    for (const t of (data.by_tier || [])) lines.push(`,${t.tier},${t.influencer_count},${t.deals},${t.views},${t.paid_views ?? 0},${t.avg_views_per_influencer},${t.likes},${t.shares},${t.spend},${t.orders},${t.conversions_value}`);
    lines.push('');
    lines.push('Engagement totals,Organic views,Paid views,Likes,Shares');
    lines.push(`,${data.engagement_totals?.views ?? 0},${data.engagement_totals?.paid_views ?? 0},${data.engagement_totals?.likes ?? 0},${data.engagement_totals?.shares ?? 0}`);
    lines.push('');
    lines.push('UGC,Deals,Organic views,Paid views,Likes,Budget consumed,Orders,Conv value');
    if (data.ugc) lines.push(`,${data.ugc.deals},${data.ugc.views},${data.ugc.paid_views ?? 0},${data.ugc.likes},${data.ugc.budget_consumed},${data.ugc.orders},${data.ugc.conversions_value}`);
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `ignition-report-${from}-to-${to}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  if (!canView) return <EmptyState icon={BarChart3} title="Access denied" message="You don't have the ignition_reports_view permission." />;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 16 }}>
        <div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--text-4)' }}>Analyze · spend, reach, return</div>
          <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 32, fontWeight: 700, marginTop: 6 }}>Reports</h1>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Segmented options={PRESETS} value={activePreset} onChange={pickPreset} />
          <span style={lbl}>From</span>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={dateInput} />
          <span style={lbl}>To</span>
          <input type="date" value={to} onChange={e => setTo(e.target.value)} style={dateInput} />
          <button onClick={exportCsv} disabled={!data} style={btnGhost}><Download size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />CSV</button>
        </div>
      </div>

      {error && <div style={{ padding: 12, marginBottom: 12, background: 'var(--state-error-bg)', color: 'var(--state-error-fg)', border: '1px solid var(--state-error)', borderRadius: 'var(--r-btn)' }}>{error}</div>}

      {loading || !data ? <Spinner /> : data.totals.deals === 0 ? (
        <EmptyState icon={BarChart3} title="No deals in range" message="Adjust the date range." />
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 14 }}>
            <Tile size={22} label="Deals" value={data.totals.deals.toLocaleString()} hint={`${from} → ${to}`} />
            <Tile size={22} label="Total spend" value={inr(data.totals.spend)} color={ORANGE} />
            <Tile size={22} label="Orders" value={data.totals.orders.toLocaleString()} />
            <Tile size={22} label="Conv. value" value={inr(data.totals.conversions_value)} />
            <Tile size={22} label="Avg CPM" value={data.totals.avg_cpm != null ? `₹${data.totals.avg_cpm}` : '—'} />
            <Tile size={22} label="Avg ROAS" value={data.totals.avg_roas != null ? `${data.totals.avg_roas}×` : '—'} />
            <Tile size={22} label="Organic views" value={(data.engagement_totals?.views ?? 0).toLocaleString()} />
            <Tile size={22} label="Paid views (ads)" value={(data.engagement_totals?.paid_views ?? 0).toLocaleString()} />
            <Tile size={22} label="Total likes" value={(data.engagement_totals?.likes ?? 0).toLocaleString()} />
            <Tile size={22} label="Total shares" value={(data.engagement_totals?.shares ?? 0).toLocaleString()} />
          </div>

          <Panel title="By influencer tier">
            <table style={tableStyle}>
              <thead><tr>{['Tier', 'Influencers', 'Deals', 'Organic views', 'Paid views', 'Avg organic views/inf', 'Likes', 'Shares', 'Spend', 'Orders', 'Conv. value'].map((h, i) => <th key={h} style={{ ...thr, textAlign: i ? 'right' : 'left' }}>{h}</th>)}</tr></thead>
              <tbody>
                {(!data.by_tier || !data.by_tier.length) && <tr><td colSpan={11} style={{ ...tdl, color: 'var(--text-3)', textAlign: 'center' }}>No data</td></tr>}
                {(data.by_tier || []).map(t => (
                  <tr key={t.tier} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={tdl}>{tierLabel(t.tier)}</td>
                    <td style={tdr}>{t.influencer_count.toLocaleString()}</td>
                    <td style={tdr}>{t.deals.toLocaleString()}</td>
                    <td style={tdr}>{t.views.toLocaleString()}</td>
                    <td style={tdr}>{(t.paid_views ?? 0).toLocaleString()}</td>
                    <td style={tdr}>{t.avg_views_per_influencer.toLocaleString()}</td>
                    <td style={tdr}>{t.likes.toLocaleString()}</td>
                    <td style={tdr}>{t.shares.toLocaleString()}</td>
                    <td style={{ ...tdr, color: ORANGE }}>{inr(t.spend)}</td>
                    <td style={tdr}>{t.orders.toLocaleString()}</td>
                    <td style={tdr}>{inr(t.conversions_value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>

          {data.ugc && (
            <Panel title="UGC — user-generated content">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 12 }}>
                <Tile size={22} label="UGC deals" value={data.ugc.deals.toLocaleString()} />
                <Tile size={22} label="UGC organic views" value={data.ugc.views.toLocaleString()} />
                <Tile size={22} label="UGC likes" value={data.ugc.likes.toLocaleString()} />
                <Tile size={22} label="Budget consumed" value={inr(data.ugc.budget_consumed)} color={ORANGE} />
                <Tile size={22} label="Orders" value={data.ugc.orders.toLocaleString()} />
                <Tile size={22} label="Conv. value" value={inr(data.ugc.conversions_value)} />
              </div>
            </Panel>
          )}

          <Panel title="Spend by month">
            <Chart data={data.by_month} xKey="month" barKey="spend" money />
          </Panel>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))', gap: 14 }}>
            <Panel title="ROAS distribution">
              <Histogram data={data.roas_distribution} tones={ROAS_TONES} unit="×" />
            </Panel>
            <Panel title="CPM distribution (₹)">
              <Histogram data={data.cpm_distribution} tones={CPM_TONES} unit="₹" />
            </Panel>
          </div>

          <Panel title="Spend by product">
            <table style={tableStyle}>
              <thead><tr>{['Product', 'Deals', 'Spend', 'Orders', 'Organic views', 'Paid views'].map((h, i) => <th key={h} style={{ ...thr, textAlign: i ? 'right' : 'left' }}>{h}</th>)}</tr></thead>
              <tbody>
                {data.by_product.map(p => (
                  <tr key={p.name} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={tdl}>{p.name}</td>
                    <td style={tdr}>{p.deals}</td>
                    <td style={{ ...tdr, color: ORANGE }}>{inr(p.spend)}</td>
                    <td style={tdr}>{p.orders.toLocaleString()}</td>
                    <td style={tdr}>{p.views.toLocaleString()}</td>
                    <td style={tdr}>{(p.paid_views ?? 0).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>

          <Panel title="Top performers">
            <table style={tableStyle}>
              <thead><tr>{['Engagement', 'Influencer', 'Product', 'Orders', 'Conv. value', 'Spend', 'ROAS'].map((h, i) => <th key={h} style={{ ...thr, textAlign: i > 2 ? 'right' : 'left' }}>{h}</th>)}</tr></thead>
              <tbody>
                {data.top_performers.length === 0 && <tr><td colSpan={7} style={{ ...tdl, color: 'var(--text-3)', textAlign: 'center' }}>No measured performance yet.</td></tr>}
                {data.top_performers.map(p => (
                  <tr key={p.engagement_no} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ ...tdl, color: ORANGE, fontWeight: 600 }}>{p.engagement_no}</td>
                    <td style={tdl}>{p.influencer}</td>
                    <td style={tdl}>{p.product}</td>
                    <td style={tdr}>{p.orders.toLocaleString()}</td>
                    <td style={tdr}>{inr(p.conversions_value)}</td>
                    <td style={tdr}>{inr(p.spend)}</td>
                    <td style={tdr}>{p.roas != null ? `${p.roas}×` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </>
      )}
    </div>
  );
}

function Chart({ data, xKey, barKey, money }) {
  if (!data?.length) return <div style={{ color: 'var(--text-3)', fontSize: 12, textAlign: 'center', padding: 24 }}>No data</div>;
  return (
    <div style={{ width: '100%', height: 240 }}>
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
          <XAxis dataKey={xKey} tick={{ fill: 'var(--text-3)', fontSize: 11 }} axisLine={{ stroke: GRID }} tickLine={false} />
          <YAxis tick={{ fill: 'var(--text-3)', fontSize: 11 }} axisLine={false} tickLine={false} width={money ? 56 : 32}
            tickFormatter={v => money ? (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v) : v} />
          <Tooltip
            cursor={{ fill: 'var(--surface-hover)' }}
            contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 8, fontSize: 12 }}
            labelStyle={{ color: 'var(--text-1)' }}
            formatter={v => [money ? inr(v) : v, money ? 'Spend' : 'Count']} />
          <Bar dataKey={barKey} radius={[3, 3, 0, 0]}>
            {data.map((_, i) => <Cell key={i} fill={i === data.length - 1 ? ORANGE : 'var(--border-3)'} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// Worker returns 5 bands per histogram ({ bucket, count }); bars are scaled to the tallest band.
function Histogram({ data, tones, unit }) {
  if (!data?.length) return <div style={{ color: 'var(--text-3)', fontSize: 12, textAlign: 'center', padding: 24 }}>No data</div>;
  const max = Math.max(1, ...data.map(b => Number(b.count) || 0));
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 120 }}>
      {data.map((b, i) => (
        <div key={b.bucket} title={`${unit === '₹' ? '₹' : ''}${b.bucket}${unit === '×' ? '×' : ''}: ${b.count} deals`}
          style={{ flex: 1, height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-2)' }}>{b.count}</span>
          <div style={{ width: '100%', height: `${(Number(b.count) || 0) / max * 70}%`, minHeight: 2, background: tones[i] || ORANGE, borderRadius: '6px 6px 2px 2px', transformOrigin: 'bottom', animation: `igGrowY 600ms ${i * 40}ms cubic-bezier(.22,1,.36,1) both` }} />
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-4)', whiteSpace: 'nowrap' }}>{b.bucket}</span>
        </div>
      ))}
    </div>
  );
}

function Panel({ title, children }) {
  return (
    <Card title={title} style={{ marginBottom: 14 }}>
      <div style={{ overflowX: 'auto' }}>{children}</div>
    </Card>
  );
}

const lbl = { fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', fontFamily: 'var(--font-mono)' };
const dateInput = { background: 'var(--input)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--r-btn)', height: 42, padding: '0 12px', fontFamily: 'var(--font-mono)', fontSize: 13 };
const btnGhost = { height: 42, padding: '0 14px', background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-btn)', fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: 13 };
const thr = { padding: '7px 10px', fontSize: 10, color: 'var(--text-3)', letterSpacing: '0.05em', textTransform: 'uppercase', fontWeight: 700, fontFamily: 'var(--font-mono)' };
const tdl = { padding: '8px 10px', textAlign: 'left', color: 'var(--text-2)' };
const tdr = { padding: '8px 10px', textAlign: 'right', color: 'var(--text-2)', fontFamily: 'var(--font-mono)', fontSize: 12.5 };
