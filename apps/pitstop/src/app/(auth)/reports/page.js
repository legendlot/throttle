'use client';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, EmptyState, KpiCard } from '@throttle/ui';
import { BarChart3, Download } from 'lucide-react';
import { csopsGet } from '../../../lib/csopsFetch.js';

function toIsoStart(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
function toIsoEnd(date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}
function inr(n) { return n == null || isNaN(n) ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`; }

const TYPE_COLORS = {
  replacement: '#7b93ff',
  refund:      '#fbbf24',
  repair:      '#4ade80',
  other:       '#888',
};

export default function ReportsPage() {
  const { user, session, perms } = useAuth();
  const canViewCosts = !!perms?.cs_reports_view;

  const today = new Date();
  const ytdStart = new Date(today.getFullYear(), 0, 1);

  const [from, setFrom] = useState(ytdStart.toISOString().slice(0, 10));
  const [to,   setTo]   = useState(today.toISOString().slice(0, 10));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!session) return;
    let alive = true;
    setLoading(true);
    csopsGet('getReports', { from: toIsoStart(from), to: toIsoEnd(to) }, session)
      .then(d => { if (alive) { setData(d); setError(null); } })
      .catch(e => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [session, from, to]);

  function exportCsv() {
    if (!data) return;
    const lines = [];
    lines.push(`Pitstop Report,${from} to ${to}`);
    lines.push('');
    lines.push('By Product,Total,Replacements,Refunds,Repairs');
    for (const r of data.by_product) {
      lines.push(`${r.name},${r.total},${r.replacement || 0},${r.refund || 0},${r.repair || 0}`);
    }
    lines.push('');
    lines.push('By Platform,Total,Replacements,Refunds,Repairs');
    for (const r of data.by_platform) {
      lines.push(`${r.name},${r.total},${r.replacement || 0},${r.refund || 0},${r.repair || 0}`);
    }
    lines.push('');
    lines.push('By Agent,Total,Closed,Avg close (days)');
    for (const r of data.by_agent) {
      lines.push(`${r.name},${r.total},${r.closed},${r.avg_close_days ?? ''}`);
    }
    lines.push('');
    lines.push('Cost Summary');
    lines.push(`Return cost (₹),${data.cost_summary.return_cost_inr}`);
    lines.push(`Replacement cost (₹),${data.cost_summary.replacement_cost_inr}`);
    lines.push(`Refund amount (₹),${data.cost_summary.refund_amount_inr}`);
    const csv = lines.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pitstop-report-${from}-to-${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!canViewCosts && !loading) {
    return (
      <EmptyState
        icon={BarChart3}
        title="Access denied"
        message="You don't have the cs_reports_view permission."
      />
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 'var(--space-4)' }}>
        <h1 style={{
          fontFamily: 'var(--font-cond)',
          fontSize: 'var(--text-xl)',
          fontWeight: 600,
          letterSpacing: 'var(--tracking-tight)',
          textTransform: 'uppercase',
          color: 'var(--t1)',
        }}>Reports</h1>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--t3)', fontSize: 11, fontFamily: 'var(--font-mono)', textTransform: 'uppercase' }}>
            From
            <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={dateInput} />
            <span>To</span>
            <input type="date" value={to} onChange={e => setTo(e.target.value)} style={dateInput} />
          </div>
          <button onClick={exportCsv} disabled={!data} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '6px 12px',
            background: 'transparent',
            color: 'var(--t2)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600,
            letterSpacing: '0.06em', textTransform: 'uppercase',
            cursor: 'pointer',
          }}>
            <Download size={13} strokeWidth={1.75} /> Export CSV
          </button>
        </div>
      </div>

      {error && (
        <div style={{
          padding: 12, marginBottom: 12,
          background: 'var(--state-error-bg)',
          color: 'var(--state-error-fg)',
          border: '1px solid var(--state-error)',
          borderRadius: 'var(--radius-md)',
        }}>{error}</div>
      )}

      {loading || !data ? (
        <Spinner />
      ) : data.range.total_rows === 0 ? (
        <EmptyState icon={BarChart3} title="No tickets in range" message="Adjust the date range or create some tickets first." />
      ) : (
        <>
          {/* Cost summary KPIs */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-3)', marginBottom: 'var(--space-4)' }}>
            <KpiCard label="Total cases"        value={data.range.total_rows.toLocaleString()} sub={`${from} → ${to}`} />
            <KpiCard label="Return cost"        value={inr(data.cost_summary.return_cost_inr)}      sub="logistics in" color="orange" />
            <KpiCard label="Replacement cost"   value={inr(data.cost_summary.replacement_cost_inr)} sub="new units out" color="blue" />
            <KpiCard label="Refund payouts"     value={inr(data.cost_summary.refund_amount_inr)}    sub="money returned" color="red" />
          </div>

          {/* Monthly trend */}
          <Panel title="Monthly trend">
            <MonthlyTrendChart monthly={data.monthly_trend} />
          </Panel>

          {/* By product + By platform — side by side */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
            <Panel title="By product">
              <BreakdownTable rows={data.by_product} />
            </Panel>
            <Panel title="By platform">
              <BreakdownTable rows={data.by_platform} />
            </Panel>
          </div>

          {/* By agent */}
          <Panel title="By agent">
            <BreakdownTable rows={data.by_agent} variant="agent" />
          </Panel>
        </>
      )}
    </div>
  );
}

const dateInput = {
  background: 'var(--surface)',
  color: 'var(--t1)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  padding: '4px 8px',
  fontFamily: 'var(--font-mono)', fontSize: 12,
};

function Panel({ title, children }) {
  return (
    <section style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)',
      overflow: 'hidden',
      marginBottom: 'var(--space-3)',
    }}>
      <div style={{
        padding: '10px 14px',
        borderBottom: '1px solid var(--border)',
        fontFamily: 'var(--font-cond)',
        fontSize: 13, fontWeight: 700,
        letterSpacing: '0.04em', textTransform: 'uppercase',
        color: 'var(--t1)',
      }}>{title}</div>
      <div style={{ padding: 14 }}>{children}</div>
    </section>
  );
}

function MonthlyTrendChart({ monthly }) {
  // Pure SVG stacked bars — small, no recharts dep for this view
  if (!monthly?.length) {
    return <div style={{ color: 'var(--t4)', fontSize: 12, textAlign: 'center', padding: 24 }}>No data</div>;
  }
  const maxTotal = Math.max(...monthly.map(m => m.total));
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 18, height: 200, padding: '12px 4px 0' }}>
      {monthly.map(m => (
        <div key={m.month} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div style={{
            display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
            width: '70%', maxWidth: 56, minWidth: 16, height: '100%', position: 'relative',
          }}>
            <div title={`replacement: ${m.replacement || 0}`} style={{ background: TYPE_COLORS.replacement, height: `${(m.replacement || 0) / maxTotal * 100}%`, minHeight: m.replacement ? 2 : 0 }} />
            <div title={`refund: ${m.refund || 0}`} style={{ background: TYPE_COLORS.refund, height: `${(m.refund || 0) / maxTotal * 100}%`, minHeight: m.refund ? 2 : 0 }} />
            <div title={`repair: ${m.repair || 0}`} style={{ background: TYPE_COLORS.repair, height: `${(m.repair || 0) / maxTotal * 100}%`, minHeight: m.repair ? 2 : 0 }} />
            <div title={`other: ${m.other || 0}`} style={{ background: TYPE_COLORS.other, height: `${(m.other || 0) / maxTotal * 100}%`, minHeight: m.other ? 2 : 0 }} />
            <div style={{ position: 'absolute', top: -16, left: 0, right: 0, textAlign: 'center', color: 'var(--t2)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{m.total}</div>
          </div>
          <div style={{ marginTop: 6, color: 'var(--t3)', fontFamily: 'var(--font-mono)', fontSize: 10 }}>{m.month}</div>
        </div>
      ))}
    </div>
  );
}

function BreakdownTable({ rows, variant }) {
  if (!rows?.length) {
    return <div style={{ color: 'var(--t4)', fontSize: 12, textAlign: 'center', padding: 12 }}>No data</div>;
  }
  const total = rows.reduce((s, r) => s + r.total, 0);
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}>
      <thead>
        <tr>
          <Th>{variant === 'agent' ? 'Agent' : 'Name'}</Th>
          <Th align="right">Total</Th>
          {variant !== 'agent' ? (
            <>
              <Th align="right">Replace</Th>
              <Th align="right">Refund</Th>
              <Th align="right">Repair</Th>
              <Th align="right">% Share</Th>
            </>
          ) : (
            <>
              <Th align="right">Closed</Th>
              <Th align="right">Avg Close</Th>
              <Th align="right">% Share</Th>
            </>
          )}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.name + i} style={{ borderTop: '1px solid var(--surface-2)' }}>
            <Td><span style={{ color: 'var(--t1)' }}>{r.name}</span></Td>
            <Td align="right" mono>{r.total}</Td>
            {variant !== 'agent' ? (
              <>
                <Td align="right" mono color={TYPE_COLORS.replacement}>{r.replacement || 0}</Td>
                <Td align="right" mono color={TYPE_COLORS.refund}>{r.refund || 0}</Td>
                <Td align="right" mono color={TYPE_COLORS.repair}>{r.repair || 0}</Td>
                <Td align="right" mono>{((r.total / total) * 100).toFixed(1)}%</Td>
              </>
            ) : (
              <>
                <Td align="right" mono>{r.closed}</Td>
                <Td align="right" mono>{r.avg_close_days != null ? `${r.avg_close_days}d` : '—'}</Td>
                <Td align="right" mono>{((r.total / total) * 100).toFixed(1)}%</Td>
              </>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Th({ children, align = 'left' }) {
  return <th style={{ padding: '7px 10px', textAlign: align, color: 'var(--t3)', fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, letterSpacing: 'var(--tracking-wide)', textTransform: 'uppercase' }}>{children}</th>;
}

function Td({ children, mono, align = 'left', color }) {
  return <td style={{ padding: '8px 10px', textAlign: align, color: color || 'var(--t2)', fontFamily: mono ? 'var(--font-mono)' : 'inherit', fontSize: 12.5 }}>{children}</td>;
}
