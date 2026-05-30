'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, KpiCard, EmptyState } from '@throttle/ui';
import { BarChart3, Download } from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell,
} from 'recharts';
import { ignitionopsGet } from '../../../lib/ignitionopsFetch.js';

function inr(n) { return n == null || isNaN(n) ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`; }
const ORANGE = '#FF6B00';
const GRID = '#2a2a2a';

export default function ReportsPage() {
  const { session, perms } = useAuth();
  const canView = !!perms?.ignition_reports_view;

  const today = new Date();
  const yearStart = new Date(today.getFullYear(), 0, 1);
  const [from, setFrom] = useState(yearStart.toISOString().slice(0, 10));
  const [to, setTo] = useState(today.toISOString().slice(0, 10));
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
    lines.push('Totals,Deals,Spend,Orders,Views,Conversions value,Avg CPM,Avg ROAS');
    const t = data.totals;
    lines.push(`,${t.deals},${t.spend},${t.orders},${t.views},${t.conversions_value},${t.avg_cpm ?? ''},${t.avg_roas ?? ''}`);
    lines.push('');
    lines.push('Spend by month,Month,Spend,Deals,Orders,Views');
    for (const m of data.by_month) lines.push(`,${m.month},${m.spend},${m.deals},${m.orders},${m.views}`);
    lines.push('');
    lines.push('Spend by product,Product,Deals,Spend,Orders,Views');
    for (const p of data.by_product) lines.push(`,${p.name},${p.deals},${p.spend},${p.orders},${p.views}`);
    lines.push('');
    lines.push('Top performers,Engagement,Influencer,Product,Orders,Conv value,Spend,ROAS');
    for (const p of data.top_performers) lines.push(`,${p.engagement_no},${p.influencer},${p.product},${p.orders},${p.conversions_value},${p.spend},${p.roas ?? ''}`);
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `ignition-report-${from}-to-${to}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  if (!canView) return <EmptyState icon={BarChart3} title="Access denied" message="You don't have the ignition_reports_view permission." />;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Reports</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', fontFamily: 'var(--font-mono)' }}>From</span>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={dateInput} />
          <span style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', fontFamily: 'var(--font-mono)' }}>To</span>
          <input type="date" value={to} onChange={e => setTo(e.target.value)} style={dateInput} />
          <button onClick={exportCsv} disabled={!data} style={btnGhost}><Download size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />CSV</button>
        </div>
      </div>

      {error && <div style={{ padding: 12, marginBottom: 12, background: 'var(--state-error-bg)', color: 'var(--state-error-fg)', border: '1px solid var(--state-error)', borderRadius: 'var(--radius-md)' }}>{error}</div>}

      {loading || !data ? <Spinner /> : data.totals.deals === 0 ? (
        <EmptyState icon={BarChart3} title="No deals in range" message="Adjust the date range." />
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 20 }}>
            <KpiCard label="Deals" value={data.totals.deals.toLocaleString()} sub={`${from} → ${to}`} />
            <KpiCard label="Total spend" value={inr(data.totals.spend)} accent={ORANGE} />
            <KpiCard label="Orders" value={data.totals.orders.toLocaleString()} />
            <KpiCard label="Conv. value" value={inr(data.totals.conversions_value)} />
            <KpiCard label="Avg CPM" value={data.totals.avg_cpm != null ? `₹${data.totals.avg_cpm}` : '—'} />
            <KpiCard label="Avg ROAS" value={data.totals.avg_roas != null ? `${data.totals.avg_roas}×` : '—'} />
          </div>

          <Panel title="Spend by month">
            <Chart data={data.by_month} xKey="month" barKey="spend" money />
          </Panel>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Panel title="ROAS distribution">
              <Chart data={data.roas_distribution} xKey="bucket" barKey="count" />
            </Panel>
            <Panel title="CPM distribution (₹)">
              <Chart data={data.cpm_distribution} xKey="bucket" barKey="count" />
            </Panel>
          </div>

          <Panel title="Spend by product">
            <table style={tableStyle}>
              <thead><tr>{['Product', 'Deals', 'Spend', 'Orders', 'Views'].map((h, i) => <th key={h} style={{ ...thr, textAlign: i ? 'right' : 'left' }}>{h}</th>)}</tr></thead>
              <tbody>
                {data.by_product.map(p => (
                  <tr key={p.name} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={tdl}>{p.name}</td>
                    <td style={tdr}>{p.deals}</td>
                    <td style={{ ...tdr, color: ORANGE }}>{inr(p.spend)}</td>
                    <td style={tdr}>{p.orders.toLocaleString()}</td>
                    <td style={tdr}>{p.views.toLocaleString()}</td>
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
          <XAxis dataKey={xKey} tick={{ fill: '#999', fontSize: 11 }} axisLine={{ stroke: GRID }} tickLine={false} />
          <YAxis tick={{ fill: '#999', fontSize: 11 }} axisLine={false} tickLine={false} width={money ? 56 : 32}
            tickFormatter={v => money ? (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v) : v} />
          <Tooltip
            cursor={{ fill: 'rgba(255,107,0,0.08)' }}
            contentStyle={{ background: '#111', border: '1px solid #333', borderRadius: 6, fontSize: 12 }}
            labelStyle={{ color: '#eee' }}
            formatter={v => [money ? inr(v) : v, money ? 'Spend' : 'Count']} />
          <Bar dataKey={barKey} radius={[3, 3, 0, 0]}>
            {data.map((_, i) => <Cell key={i} fill={ORANGE} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function Panel({ title, children }) {
  return (
    <section style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden', marginBottom: 12 }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--font-cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-2)' }}>{title}</div>
      <div style={{ padding: 14 }}>{children}</div>
    </section>
  );
}

const dateInput = { background: 'var(--surface)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '5px 8px', fontFamily: 'var(--font-mono)', fontSize: 12 };
const btnGhost = { padding: '6px 12px', background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', cursor: 'pointer' };
const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: 13 };
const thr = { padding: '7px 10px', fontSize: 10, color: 'var(--text-3)', letterSpacing: '0.05em', textTransform: 'uppercase', fontWeight: 700, fontFamily: 'var(--font-mono)' };
const tdl = { padding: '8px 10px', textAlign: 'left', color: 'var(--text-2)' };
const tdr = { padding: '8px 10px', textAlign: 'right', color: 'var(--text-2)', fontFamily: 'var(--font-mono)', fontSize: 12.5 };
