'use client';
/* ════════════════════════════════════════════════════════════
   Ticket History — creation progression over time, Day/Week/Month
   granularity. Two stacked series: manual tickets vs auto-created
   (call requests). Backed by csops getTicketHistory (dept-scoped,
   cs_reports_view). (S160)
   ════════════════════════════════════════════════════════════ */
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { EmptyState, Spinner } from '@throttle/ui';
import { csopsGet } from '../../../lib/csopsFetch.js';
import { getActiveDept } from '../../../components/DeptSwitcher.js';
import { KpiCard, DatePresets, fmt } from '../../../components/kit/index.js';
import { TrendChart } from '../../../components/kit/Chart.js';

// Default look-back window per granularity.
function rangeFor(gran) {
  const to = new Date();
  const from = new Date();
  if (gran === 'month') from.setMonth(from.getMonth() - 12);
  else if (gran === 'week') from.setDate(from.getDate() - 7 * 12);
  else from.setDate(from.getDate() - 30);
  return { from: from.toISOString(), to: to.toISOString() };
}

const bucketFmt = (gran) => (b) => {
  if (!b) return b;
  if (gran === 'month') {
    const [y, m] = String(b).split('-');
    return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1] + ' ' + String(y).slice(2);
  }
  return String(b).slice(5); // MM-DD
};

export default function HistoryPage() {
  const { session, perms, brandUser } = useAuth();
  const [gran, setGran] = useState('day');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const canView = !!perms?.cs_reports_view;

  useEffect(() => {
    if (!session || !canView) { setLoading(false); return; }
    let alive = true;
    setLoading(true);
    const dept = getActiveDept(perms, brandUser?.cs_department_slug) || undefined;
    const r = rangeFor(gran);
    csopsGet('getTicketHistory', { granularity: gran, ...r, ...(dept ? { department: dept } : {}) }, session)
      .then(d => { if (alive) setData(d); })
      .catch(() => { if (alive) setData(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [session, gran, perms, brandUser?.cs_department_slug, canView]);

  const totals = useMemo(() => {
    const s = data?.series || [];
    const total = s.reduce((a, b) => a + (b.total || 0), 0);
    const auto = s.reduce((a, b) => a + (b.auto || 0), 0);
    const manual = total - auto;
    const peak = s.reduce((mx, b) => (b.total > (mx?.total || 0) ? b : mx), null);
    const avg = s.length ? Math.round(total / s.length) : 0;
    return { total, auto, manual, peak, avg };
  }, [data]);

  if (!canView && !loading) {
    return <EmptyState title="Access denied" message="You don't have the cs_reports_view permission." />;
  }

  const granLabel = { day: 'per day', week: 'per week', month: 'per month' }[gran];

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 'var(--gap)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h2 style={{ fontFamily: 'var(--f-display)', fontWeight: 600, fontSize: 16, letterSpacing: '0.03em', color: 'var(--t1)', textTransform: 'uppercase', margin: 0 }}>Ticket creation over time</h2>
          <span className="num" style={{ fontSize: 11, color: 'var(--t4)' }}>{granLabel}</span>
        </div>
        <DatePresets value={gran} onChange={setGran} options={[['day', 'Daily'], ['week', 'Weekly'], ['month', 'Monthly']]} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--gap)', marginBottom: 'var(--gap)' }}>
        <KpiCard label="Total created" value={fmt(totals.total)} sub="in range" tone="var(--accent)" size={25} />
        <KpiCard label="From calls" value={fmt(totals.auto)} sub="auto-created requests" tone="var(--info-fg)" size={25} />
        <KpiCard label="Manual" value={fmt(totals.manual)} sub="agent-created" tone="var(--ok-fg)" size={25} />
        <KpiCard label={`Avg / ${gran}`} value={fmt(totals.avg)} sub={totals.peak ? `peak ${fmt(totals.peak.total)}` : ''} tone="var(--warn-fg)" size={25} />
      </div>

      <section style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
        <div style={{ padding: '14px var(--cardpad)', borderBottom: '1px solid var(--border)' }}>
          <span className="label" style={{ fontSize: 11, color: 'var(--t2)', fontWeight: 600 }}>Tickets created · {granLabel}</span>
        </div>
        <div style={{ padding: '16px 10px 8px' }}>
          {loading ? <Spinner /> : (
            <TrendChart
              data={data?.series || []}
              xKey="bucket" xFmt={bucketFmt(gran)} xLabel={gran === 'month' ? 'Month' : 'Date'} height={340} showLegend
              series={[
                { key: 'manual', name: 'Manual', color: 'ok', kind: 'area', stackId: 't' },
                { key: 'auto', name: 'From calls', color: 'info', kind: 'area', stackId: 't' },
              ]}
            />
          )}
        </div>
      </section>
    </div>
  );
}
