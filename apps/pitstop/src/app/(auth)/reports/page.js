'use client';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, EmptyState } from '@throttle/ui';
import { BarChart3, Download, Phone, Users } from 'lucide-react';
import { csopsGet } from '../../../lib/csopsFetch.js';
import { KpiCard, btnGhost } from '../../../components/kit/index.js';
// TrendChart is deliberately NOT re-exported from kit/index.js (it pulls ~110KB of recharts),
// so it is imported directly — same as the analytics page does.
import { TrendChart } from '../../../components/kit/Chart.js';
import { dateStr } from '@throttle/domain';

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
  replacement: 'var(--info-fg)',
  refund:      'var(--warn-fg)',
  repair:      'var(--ok-fg)',
  other:       'var(--t3)',
};

export default function ReportsPage() {
  const { user, session, perms } = useAuth();
  const canViewCosts = !!perms?.cs_reports_view;

  const today = new Date();
  const ytdStart = new Date(today.getFullYear(), 0, 1);

  const [view, setView] = useState('tickets');   // 'tickets' | 'calls' | 'agents'
  // ⚠️ `dateStr`, not `.toISOString().slice(0,10)` — PATTERN-221. This one was the worst
  // case of the class: `ytdStart` is a LOCAL midnight (`new Date(y, 0, 1)`), and
  // toISOString() renders local midnight as the PREVIOUS day in any positive offset — so
  // the year-to-date report opened on **31 Dec of the previous year** in IST, every time.
  // `to` had the ordinary form of the bug: yesterday between 00:00 and 05:30 IST.
  const [from, setFrom] = useState(dateStr(ytdStart));
  const [to,   setTo]   = useState(dateStr(today));
  const [data, setData] = useState(null);
  const [callData, setCallData] = useState(null);
  const [agentData, setAgentData] = useState(null);
  const [waitData, setWaitData] = useState(null);   // S319 breakdown — own RPC, own request
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Agents-tab filters (Pruthvi #bugs 2026-07-25). businessHours defaults ON since
  // 2026-08-27 (Pruthvi, #bugs 1787684420 reply): the team is judged on these numbers,
  // so the default basis is their rostered hours; untick for the 24x7 view.
  const [agChannel, setAgChannel] = useState('');
  const [agTag, setAgTag] = useState('');
  const [businessHours, setBusinessHours] = useState(true);
  const [tags, setTags] = useState([]);

  useEffect(() => {
    if (!session || view !== 'agents' || tags.length) return;
    csopsGet('getTags', {}, session)
      .then(t => setTags((Array.isArray(t) ? t : t?.tags || []).filter(x => x.is_active !== false)))
      .catch(() => {});   // a failed tag load must not block the report itself
  }, [session, view, tags.length]);

  useEffect(() => {
    if (!session) return;
    let alive = true;
    setLoading(true);
    const action = view === 'calls' ? 'getCallReports'
                 : view === 'agents' ? 'getAgentConversationReport'
                 : 'getReports';
    const args = { from: toIsoStart(from), to: toIsoEnd(to) };
    if (view === 'agents') {
      if (agChannel) args.channel = agChannel;
      if (agTag) args.tag_id = agTag;
      if (businessHours) args.business_hours = 'true';
    }
    csopsGet(action, args, session)
      .then(d => {
        if (!alive) return;
        if (view === 'calls') setCallData(d);
        else if (view === 'agents') setAgentData(d);
        else setData(d);
        setError(null);
      })
      .catch(e => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoading(false); });

    // The wait breakdown is a SEPARATE request on purpose. It was once folded into
    // the main report and made it 9-22x slower, which broke this page entirely.
    // Kept apart, a slow or failing breakdown costs only its own panel: it never
    // touches `loading` and never sets `error`.
    if (view === 'agents') {
      setWaitData(null);
      csopsGet('getConversationWaitBreakdown', args, session)
        .then(d => { if (alive) setWaitData(d); })
        .catch(() => { if (alive) setWaitData(null); });
    }
    return () => { alive = false; };
  }, [session, from, to, view, agChannel, agTag, businessHours]);

  function exportCsv() {
    // Tab-aware: the Agents tab must not silently hand you the Tickets CSV.
    if (view === 'agents') return exportAgentsCsv();
    if (!data) return;
    const lines = [];
    lines.push(`Pitstop Report,${from} to ${to}`);
    lines.push(`Tickets raised,${data.range.total_rows}`);
    if (data.conversations) {
      lines.push(`Conversations handled,${data.conversations.handled}`);
      lines.push(`Conversations in range (incl. outbound-only),${data.conversations.total}`);
    }
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

  function exportAgentsCsv() {
    if (!agentData?.by_agent?.length) return;
    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const t = agentData.totals || {};
    // Breakdown is a separate request and may legitimately be absent — the CSV then
    // simply omits those rows rather than exporting blanks that read as zeroes.
    // Same gate as the panel: only export the breakdown when its own total agrees
    // with the report's, or the CSV carries three numbers that do not add up to the
    // "Avg to close" two rows above them.
    const wRaw = waitData?.totals || null;
    const wt = (wRaw && t.avg_resolution_min != null && wRaw.avg_resolution_min != null
      && Math.abs(Number(wRaw.avg_resolution_min) - Number(t.avg_resolution_min))
         <= Math.max(60, 0.10 * Number(t.avg_resolution_min))) ? wRaw : null;
    const wByAgent = new Map((waitData?.by_agent || []).map(x => [x.agent_id || x.name, x]));
    const lines = [];
    lines.push(`Pitstop Agent Conversation Report,${from} to ${to}`);
    // The basis and the cohort travel WITH the file — a CSV read a week later
    // must not be ambiguous about whether times are 24x7 or business hours.
    lines.push(`Basis,${agentData.range?.business_hours ? 'Business hours' : '24x7'}`);
    lines.push(`Channel,${esc(agChannel || 'All')}`);
    lines.push(`Tag,${esc(tags.find(x => x.id === agTag)?.name || 'All')}`);
    lines.push(`Conversations in range,${t.total ?? ''}`);
    lines.push(`Queries (customer-initiated),${t.queries ?? ''}`);
    lines.push(`Outbound-only (not queries),${t.outbound_only ?? ''}`);
    lines.push(`No stored history,${t.no_history ?? ''}`);
    lines.push(`Assigned in range,${t.assigned ?? ''}`);
    lines.push(`Handled in range,${t.handled ?? ''}`);
    lines.push(`Closed in range,${t.closed ?? ''}`);
    lines.push('');
    // The decomposition travels with the file for the same reason Basis does: "avg to
    // close" is the FULL wall clock, and a reader a week later must be able to see how
    // much of it was waiting rather than working, without re-running the report.
    lines.push(`Avg to close (min) — full wall clock,${t.avg_resolution_min ?? ''}`);
    if (wt) {
      lines.push(`  of which waiting on customer (min),${wt.avg_customer_wait_min ?? ''}`);
      lines.push(`  of which waiting to be closed (min),${wt.avg_close_lag_min ?? ''}`);
    }
    lines.push('');
    // The date basis travels WITH the file, same reason as Basis/Channel above: a CSV
    // read next week must not leave anyone guessing which day a closure landed on.
    lines.push('Assigned/Handled/Resolved/Closed counted on,The day the activity happened');
    lines.push('Queries/Open/Answered/rates/averages counted on,The day the conversation was raised');
    lines.push('');
    lines.push('Agent,Assigned,Handled,Queries,Open,Resolved,Closed (operational),Closed (no reason),Closed,Closed rate %,Resolution rate %,Answered,Never answered,Answer rate %,Avg first reply (min),Avg reply (min),Avg to close (min),Avg waiting on customer (min),Avg waiting to be closed (min),Waiting on us,Waiting on customer');
    for (const r of agentData.by_agent) {
      lines.push([r.name, r.assigned, r.handled, r.queries, r.open, r.resolved, r.closed_ops, r.closed_unspecified,
        r.closed, r.resolution_rate, r.resolve_rate, r.answered, r.unanswered,
        r.answer_rate, r.avg_frt_min, r.avg_response_min, r.avg_resolution_min,
        wt ? wByAgent.get(r.agent_id || r.name)?.avg_customer_wait_min : '',
        wt ? wByAgent.get(r.agent_id || r.name)?.avg_close_lag_min : '',
        r.waiting_agent, r.waiting_customer].map(esc).join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pitstop-agents-${from}-to-${to}.csv`;
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
    <div style={{ maxWidth: 1400, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', marginBottom: 'var(--gap)' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--t3)', fontSize: 11, fontFamily: 'var(--font-mono)', textTransform: 'uppercase' }}>
            From
            <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={dateInput} />
            <span>To</span>
            <input type="date" value={to} onChange={e => setTo(e.target.value)} style={dateInput} />
          </div>
          <button onClick={exportCsv} disabled={view === 'agents' ? !agentData?.by_agent?.length : !data} style={btnGhost}>
            <Download size={13} strokeWidth={1.75} /> Export CSV
          </button>
        </div>
      </div>

      {/* Section toggle: Tickets | Calls */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 14, borderBottom: '1px solid var(--border)' }}>
        <SectionTab active={view==='tickets'} onClick={() => setView('tickets')} icon={<BarChart3 size={13} />} label="Tickets" />
        <SectionTab active={view==='calls'}   onClick={() => setView('calls')}   icon={<Phone size={13} />}    label="Calls" />
        <SectionTab active={view==='agents'}  onClick={() => setView('agents')}  icon={<Users size={13} />}    label="Agents" />
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

      {view === 'tickets' && (
        loading || !data ? (
          <Spinner />
        ) : data.range.total_rows === 0 ? (
          <EmptyState icon={BarChart3} title="No tickets in range" message="Adjust the date range or create some tickets first." />
        ) : (
          <>
            {/* "Total cases" always counted TICKETS, which is why the two tiles Pruthvi
                asked for would have shown the same number. Relabelled to say what it
                is, with conversations handled beside it — not every conversation
                becomes a ticket (shipment / general queries often don't). */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 'var(--gap)', marginBottom: 'var(--gap)' }}>
              <KpiCard label="Conversations handled" value={data.conversations ? data.conversations.handled.toLocaleString() : '—'}
                       sub={data.conversations ? `of ${data.conversations.total.toLocaleString()} incl. outbound` : 'unavailable'}
                       tone="var(--ok-fg)" size={25} />
              <KpiCard label="Tickets raised"     value={data.range.total_rows.toLocaleString()}       sub={`${from} → ${to}`} tone="var(--accent)"  size={25} />
              <KpiCard label="Return cost"        value={inr(data.cost_summary.return_cost_inr)}       sub="logistics in"    tone="var(--warn-fg)" size={25} />
              <KpiCard label="Replacement cost"   value={inr(data.cost_summary.replacement_cost_inr)}  sub="new units out"   tone="var(--info-fg)" size={25} />
              <KpiCard label="Refund payouts"     value={inr(data.cost_summary.refund_amount_inr)}     sub="money returned"  tone="var(--bad-fg)"  size={25} />
            </div>

            <Panel title="Monthly trend">
              <MonthlyTrendChart monthly={data.monthly_trend} />
            </Panel>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
              <Panel title="By product">
                <BreakdownTable rows={data.by_product} />
              </Panel>
              <Panel title="By platform">
                <BreakdownTable rows={data.by_platform} />
              </Panel>
            </div>

            <Panel title="By agent">
              <BreakdownTable rows={data.by_agent} variant="agent" />
            </Panel>
          </>
        )
      )}

      {view === 'calls' && (
        loading || !callData ? <Spinner /> : <CallsPanel data={callData} />
      )}

      {view === 'agents' && (
        <>
          <AgentFilters
            channel={agChannel} onChannel={setAgChannel}
            tag={agTag} onTag={setAgTag} tags={tags}
            businessHours={businessHours} onBusinessHours={setBusinessHours}
          />
          {loading || !agentData ? <Spinner /> : <AgentsPanel data={agentData} wait={waitData} />}
        </>
      )}
    </div>
  );
}

// ── Agents tab ────────────────────────────────────────────────────────────────
const CHANNEL_OPTS = [
  { v: 'whatsapp',  l: 'WhatsApp' },
  { v: 'instagram', l: 'Instagram' },
  { v: 'email',     l: 'Email' },
  { v: 'web',       l: 'Web' },
  { v: 'messenger', l: 'Messenger' },
];

function AgentFilters({ channel, onChannel, tag, onTag, tags, businessHours, onBusinessHours }) {
  const sel = {
    background: 'var(--surface)', color: 'var(--t1)', border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)', padding: '4px 8px', fontSize: 12, minWidth: 130,
  };
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 'var(--gap)' }}>
      <select value={channel} onChange={e => onChannel(e.target.value)} style={sel} title="Filter by channel">
        <option value="">All channels</option>
        {CHANNEL_OPTS.map(c => <option key={c.v} value={c.v}>{c.l}</option>)}
      </select>
      <select value={tag} onChange={e => onTag(e.target.value)} style={sel} title="Filter by tag">
        <option value="">All tags</option>
        {tags.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--t2)', cursor: 'pointer' }}>
        <input type="checkbox" checked={businessHours} onChange={e => onBusinessHours(e.target.checked)} style={{ cursor: 'pointer' }} />
        Business hours only
      </label>
      <span style={{ fontSize: 11, color: 'var(--t4)' }}>
        {businessHours
          ? 'Times count only each agent’s rostered hours.'
          : 'Times count around the clock (24×7).'}
      </span>
    </div>
  );
}

// Minutes → a readable duration. Response times here run to days, and "2456.3 min"
// is unreadable at a glance.
function dur(min) {
  if (min == null || isNaN(min)) return '—';
  const m = Number(min);
  if (m < 60) return `${m.toFixed(0)}m`;
  if (m < 1440) return `${(m / 60).toFixed(1)}h`;
  return `${(m / 1440).toFixed(1)}d`;
}

function AgentsPanel({ data, wait }) {
  const t = data?.totals;
  if (!t || !t.total) {
    return <EmptyState icon={Users} title="No conversations in range" message="Adjust the date range or filters." />;
  }
  const rows = data.by_agent || [];
  // The breakdown is only shown when the RPC actually returns it. Treating a missing
  // field as zero would render the FULL time to close as "active handling", which is
  // the most flattering possible reading of a number this page exists to be honest
  // about — so absence must hide the panel, never default it.
  // Sourced from the separate breakdown RPC, never from `t` — the main report does
  // not carry these and must not be made to.
  const w = wait?.totals || null;
  const hasWaitBreakdown = w != null && w.avg_customer_wait_min != null;
  // The breakdown computes its OWN avg_resolution_min over the same population. If it
  // ever disagrees with the report's, the two populations have drifted and the
  // subtraction below is no longer honest — so say nothing rather than show a total
  // that does not match the one three panels up.
  // Tolerance is RELATIVE and generous on purpose. The two figures come from two
  // separate HTTP calls, so threads close between them: one thread entering or
  // leaving moves the mean by mean/(n+1) — 1.4 min at n=1779, but 13 min at n=200
  // and 50 min at n=50. A tight check would flicker on the unfiltered view and
  // essentially never pass with a channel or tag filter applied. What this is
  // guarding against is a STRUCTURAL divergence — someone changing the population
  // filter in one function and not the other — which moves the mean far more than
  // 10%. Normal churn must never trip it.
  const resAgrees = hasWaitBreakdown && t.avg_resolution_min != null
    && Math.abs(Number(w.avg_resolution_min) - Number(t.avg_resolution_min))
       <= Math.max(60, 0.10 * Number(t.avg_resolution_min));
  // Per-agent breakdown arrives from the other RPC keyed the same way the report keys
  // its rows (agent_id, falling back to name for the unassigned bucket).
  const waitByAgent = new Map((wait?.by_agent || []).map(x => [x.agent_id || x.name, x]));
  const wRow = (r) => waitByAgent.get(r.agent_id || r.name) || null;
  // Clamped at 0: the three components are each population means over the same threads,
  // so the arithmetic holds in aggregate, but a filtered slice could in principle round
  // its way negative — and a negative "active handling" would read as a bug, not a number.
  // All four panel figures come from the breakdown's own query, so they are
  // internally consistent by construction — never mix its components with the
  // report's total, or the subtraction stops being exact.
  const activeHandling = !resAgrees ? null
    : Math.max(0, Number(w.avg_resolution_min) - Number(w.avg_customer_wait_min ?? 0) - Number(w.avg_close_lag_min ?? 0));
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 'var(--gap)', marginBottom: 'var(--gap)' }}>
        <div title={TIPS.queries}><KpiCard label="Queries"        value={t.queries.toLocaleString()}   sub="customer-initiated" tone="var(--accent)"  size={25} /></div>
        <div title={TIPS.answered}><KpiCard label="Answered"       value={t.answered.toLocaleString()}  sub={t.answer_rate != null ? `${t.answer_rate}% of queries` : ''} tone="var(--ok-fg)" size={25} /></div>
        <div title={TIPS.never_answered}><KpiCard label="Never answered" value={t.unanswered.toLocaleString()} sub="no agent reply"    tone={t.unanswered > 0 ? 'var(--bad-fg)' : 'var(--t3)'} size={25} /></div>
        <div title={TIPS.avg_first_reply}><KpiCard label="Avg first reply" value={dur(t.avg_frt_min)}          sub={data.range?.business_hours ? 'business hours' : '24×7'} tone="var(--warn-fg)" size={25} /></div>
        {/* sub must NOT quote t.closed: since 2026-08-19 that is closure-dated while the
            rate is cohort-dated, so the two are different populations and pairing them
            reads as "92% of 5,743". The rate's own denominator is the honest caption. */}
        {/* resolve_rate (Resolved ÷ Queries), NOT resolution_rate (Closed ÷ Queries) — Pruthvi's
            call, 2026-08-24 13:20 IST: the closed-based number counted spam/duplicate closures as
            resolutions and read 88.8% where the honest figure was 36.9%. The closed-based rate
            still ships in the CSV as "Closed rate %" for anyone tracking the old series. */}
        <div title={TIPS.resolution}>
          <KpiCard label="Resolution rate" value={t.resolve_rate != null ? `${t.resolve_rate}%` : '—'} sub={`of ${t.queries.toLocaleString()} queries raised`} tone="var(--info-fg)" size={25} />
        </div>
      </div>

      {/* The cohort note is not decoration. Only ~a third of threads in a typical
          range are two-way; without this the team reads "Queries" as "everything
          in the inbox" and the numbers look wrong. */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 'var(--gap)',
        padding: '8px 12px', fontSize: 11.5, color: 'var(--t3)',
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
        <span><strong style={{ color: 'var(--t2)' }}>{t.total.toLocaleString()}</strong> conversations in range</span>
        <span>= <strong style={{ color: 'var(--t2)' }}>{t.queries.toLocaleString()}</strong> queries</span>
        <span>+ <strong style={{ color: 'var(--t2)' }}>{t.outbound_only.toLocaleString()}</strong> outbound-only (notifications we sent — not queries)</span>
        {t.no_history > 0 && <span>+ <strong style={{ color: 'var(--t2)' }}>{t.no_history.toLocaleString()}</strong> with no stored history</span>}
      </div>

      {/* Which date each number is counted on. Pruthvi #bugs 2026-08-18: closures used to
          land on the day the conversation was RAISED, so a backlog-clearing day read empty.
          Measured 2026-08-19: 76.8% of threads closed in the last 30 days were raised on a
          different day. Each number now carries its own date; this strip says which, because
          a mixed-basis table is unreadable without it. */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 'var(--gap)',
        padding: '8px 12px', fontSize: 11.5, color: 'var(--t3)',
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
        <span style={{ color: 'var(--t2)' }}><strong>Counted on the day it happened:</strong></span>
        <span><strong style={{ color: 'var(--t2)' }}>Assigned</strong> when handed to the agent</span>
        <span><strong style={{ color: 'var(--t2)' }}>Handled</strong> when they replied to the customer</span>
        <span><strong style={{ color: 'var(--t2)' }}>Resolved / Closed</strong> when it was closed</span>
        <span>Everything else — Queries, Open, Answered, the rates and the averages — counts conversations <strong style={{ color: 'var(--t2)' }}>raised</strong> in this range, so a percentage compares like with like.</span>
      </div>

      {/* Resolved vs Closed only exists from 2026-07-28. Everything closed before that
          has no reason recorded, so it is shown as its own bucket rather than being
          guessed into Resolved — otherwise the resolve rate would read as a cliff. */}
      {t.closed > 0 && (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 'var(--gap)',
          padding: '8px 12px', fontSize: 11.5, color: 'var(--t3)',
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
          <span><strong style={{ color: 'var(--t2)' }}>{t.closed.toLocaleString()}</strong> closed</span>
          <span>= <strong style={{ color: 'var(--ok-fg)' }}>{(t.resolved ?? 0).toLocaleString()}</strong> resolved</span>
          <span>+ <strong style={{ color: 'var(--t2)' }}>{(t.closed_ops ?? 0).toLocaleString()}</strong> closed for an operational reason</span>
          {(t.closed_unspecified ?? 0) > 0 && (
            <span>+ <strong style={{ color: 'var(--t2)' }}>{t.closed_unspecified.toLocaleString()}</strong> closed before Resolve/Close existed (no reason recorded)</span>
          )}
        </div>
      )}

      {/* Afshaan 2026-08-27: keep the REAL resolution time (the full wall clock, customer
          wait included) and expose the waits beside it, so anyone can subtract by hand
          rather than the metric being silently redefined underneath them. Deliberately NOT
          a customer-wait pause on the clock — that was the alternative and it was declined.
          Every figure here is a population mean over exactly the same threads as
          "Avg to close", so the subtraction is valid. */}
      {resAgrees && (
        <Panel title="What the resolution time is made of">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--gap)', padding: 12 }}>
            <div title={TIPS.avg_to_close}>
              <KpiCard label="Total to close" value={dur(w.avg_resolution_min)} sub="raised → closed, unchanged" tone="var(--t1)" size={22} />
            </div>
            <div title={TIPS.customer_wait}>
              <KpiCard label="− Waiting on customer" value={dur(w.avg_customer_wait_min)} sub="ball in their court" tone="var(--t3)" size={22} />
            </div>
            <div title={TIPS.close_lag}>
              <KpiCard label="− Waiting to be closed" value={dur(w.avg_close_lag_min)} sub="after the last message" tone="var(--warn-fg)" size={22} />
            </div>
            <div title={TIPS.active_handling}>
              <KpiCard label="= Active handling" value={dur(activeHandling)} sub="what the team actually spent" tone="var(--accent)" size={22} />
            </div>
          </div>
          <div style={{ padding: '0 12px 12px', fontSize: 11.5, color: 'var(--t3)', lineHeight: 1.5 }}>
            <strong style={{ color: 'var(--t2)' }}>Total to close is the real number and has not changed</strong> — the two
            middle figures are carved out of it so they can be removed by hand when that is the fairer read.
            {' '}<strong style={{ color: 'var(--t2)' }}>Waiting to be closed</strong> is time after the final message in the
            conversation, i.e. how long it took someone to press Close — it is closing discipline, not resolution.
            {' '}All four are on the {data.range?.business_hours ? 'business-hours' : '24×7'} basis; switching that
            moves every one of them.
          </div>
        </Panel>
      )}

      <Panel title="Waiting now">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--gap)', padding: 12 }}>
          <KpiCard label="Waiting on us"       value={t.waiting_agent.toLocaleString()}    sub="customer replied last" tone={t.waiting_agent > 0 ? 'var(--bad-fg)' : 'var(--t3)'} size={22} />
          <KpiCard label="Waiting on customer" value={t.waiting_customer.toLocaleString()} sub="we replied last"       tone="var(--t3)" size={22} />
          <KpiCard label="Open queries"        value={t.open.toLocaleString()}             sub="still open"            tone="var(--warn-fg)" size={22} />
        </div>
      </Panel>

      <Panel title="Activity in this range">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--gap)', padding: 12 }}>
          <KpiCard label="Assigned"  value={(t.assigned ?? 0).toLocaleString()} sub="handed to an agent in range"  tone="var(--accent)"  size={22} />
          <KpiCard label="Handled"   value={(t.handled ?? 0).toLocaleString()}  sub="agent replied to the customer" tone="var(--ok-fg)"   size={22} />
          <KpiCard label="Closed"    value={(t.closed ?? 0).toLocaleString()}   sub="closed in range, whenever raised" tone="var(--info-fg)" size={22} />
        </div>
      </Panel>

      <Panel title="By agent">
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', minWidth: 1240, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <Th>Agent</Th>
                <Th align="right" tip={TIPS.assigned}>Assigned</Th>
                <Th align="right" tip={TIPS.handled}>Handled</Th>
                <Th align="right" tip={TIPS.queries}>Queries</Th>
                <Th align="right" tip={TIPS.open}>Open</Th>
                <Th align="right" tip={TIPS.resolved}>Resolved</Th>
                <Th align="right" tip={TIPS.closed_ops}>Closed (ops)</Th>
                <Th align="right" tip={TIPS.closed}>Closed</Th>
                <Th align="right" tip={TIPS.resolution}>Resolution</Th>
                <Th align="right" tip={TIPS.answered}>Answered</Th>
                <Th align="right" tip={TIPS.never_answered}>Never ans.</Th>
                <Th align="right" tip={TIPS.avg_first_reply}>Avg 1st reply</Th>
                <Th align="right" tip={TIPS.avg_reply}>Avg reply</Th>
                <Th align="right" tip={TIPS.avg_to_close}>Avg to close</Th>
                {resAgrees && <Th align="right" tip={TIPS.customer_wait}>— on customer</Th>}
                {resAgrees && <Th align="right" tip={TIPS.close_lag}>— unclosed</Th>}
                <Th align="right" tip={TIPS.on_us}>On us</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.agent_id || r.name} style={{ borderBottom: '1px solid var(--border)' }}>
                  <Td color="var(--t1)">{r.name}</Td>
                  <Td mono align="right">{(r.assigned ?? 0).toLocaleString()}</Td>
                  <Td mono align="right" color={(r.handled ?? 0) > 0 ? 'var(--t1)' : 'var(--t3)'}>{(r.handled ?? 0).toLocaleString()}</Td>
                  <Td mono align="right" color="var(--t1)">{r.queries.toLocaleString()}</Td>
                  <Td mono align="right">{r.open.toLocaleString()}</Td>
                  <Td mono align="right" color={r.resolved > 0 ? 'var(--ok-fg)' : 'var(--t3)'}>{(r.resolved ?? 0).toLocaleString()}</Td>
                  <Td mono align="right">{(r.closed_ops ?? 0).toLocaleString()}</Td>
                  <Td mono align="right">{r.closed.toLocaleString()}</Td>
                  <Td mono align="right">{r.resolve_rate != null ? `${r.resolve_rate}%` : '—'}</Td>
                  <Td mono align="right">{r.answered.toLocaleString()}</Td>
                  <Td mono align="right" color={r.unanswered > 0 ? 'var(--bad-fg)' : 'var(--t3)'}>{r.unanswered.toLocaleString()}</Td>
                  <Td mono align="right">{dur(r.avg_frt_min)}</Td>
                  <Td mono align="right">{dur(r.avg_response_min)}</Td>
                  <Td mono align="right">{dur(r.avg_resolution_min)}</Td>
                  {resAgrees && <Td mono align="right" color="var(--t3)">{dur(wRow(r)?.avg_customer_wait_min)}</Td>}
                  {resAgrees && <Td mono align="right" color={(wRow(r)?.avg_close_lag_min ?? 0) > 0 ? 'var(--warn-fg)' : 'var(--t3)'}>{dur(wRow(r)?.avg_close_lag_min)}</Td>}
                  <Td mono align="right" color={r.waiting_agent > 0 ? 'var(--bad-fg)' : 'var(--t3)'}>{r.waiting_agent.toLocaleString()}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

function SectionTab({ active, onClick, icon, label }) {
  return (
    <button onClick={onClick} style={{
      display:'inline-flex', alignItems:'center', gap: 6,
      padding: '8px 14px', background: 'none', border: 'none',
      borderBottom: active ? '2px solid var(--yellow)' : '2px solid transparent',
      marginBottom: -1,
      color: active ? 'var(--yellow)' : 'var(--t2)',
      fontWeight: active ? 600 : 500, fontSize: 13, cursor: 'pointer',
    }}>
      {icon} {label}
    </button>
  );
}

function CallsPanel({ data }) {
  if (!data || !data.totals || data.totals.total === 0) {
    return <EmptyState icon={Phone} title="No calls in range" message="Adjust the date range." />;
  }
  const fmtMMSS = (s) => s == null ? '—' : `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 'var(--gap)', marginBottom: 'var(--gap)' }}>
        <KpiCard label="Total calls"  value={data.totals.total.toLocaleString()}    sub={`${data.range.from.slice(0,10)} → ${data.range.to.slice(0,10)}`} tone="var(--info-fg)" size={25} />
        <KpiCard label="Answered"     value={data.totals.answered.toLocaleString()} tone="var(--ok-fg)"  size={25} />
        <KpiCard label="Missed"       value={data.totals.missed.toLocaleString()}   tone={data.totals.missed > 0 ? 'var(--bad-fg)' : 'var(--t3)'} size={25} />
        <KpiCard label="Answer rate"  value={data.totals.answer_rate_pct != null ? `${data.totals.answer_rate_pct}%` : '—'} tone="var(--warn-fg)" size={25} />
        <KpiCard label="Avg duration" value={fmtMMSS(data.totals.avg_duration_seconds)} tone="var(--accent)" size={25} />
      </div>

      <Panel title="By department">
        <CallsBreakdown rows={data.by_department || []} variant="dept" />
      </Panel>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
        <Panel title="By MyOp account">
          <CallsBreakdown rows={data.by_account || []} variant="account" />
        </Panel>
        <Panel title="By direction">
          <DirectionTable d={data.by_direction} />
        </Panel>
      </div>

      <Panel title="By agent">
        <CallsBreakdown rows={data.by_agent || []} variant="agent" />
      </Panel>

      <Panel title="Call volume trend">
        <CallTrend daily={data.daily || []} />
      </Panel>

      <Panel title="Hourly distribution (IST)">
        <HourlyBars hourly={data.hourly || []} />
      </Panel>
    </>
  );
}

// Call volume over time — the first of the four reporting-suite sections (Afshaan, 2026-09-03).
//
// ⚠️ `data.daily` was ALREADY being computed by getCallReports and thrown away: nothing in this
// file read it. So this is rendering existing data, not a new query.
//
// Day / week / month is rolled up HERE rather than server-side on purpose — the payload is one
// row per day (≤366 for a year), so a second grain parameter on the handler would buy nothing
// and give the two grains two places to disagree.
function CallTrend({ daily }) {
  const [grain, setGrain] = useState('day');
  const rows = useMemo(() => {
    // Filter to well-formed dates first. `new Date('nullT00:00:00Z').toISOString()` THROWS a
    // RangeError, and a throw inside useMemo white-screens the whole Calls tab — a malformed
    // row must cost one bar, not the page. The worker only emits YYYY-MM-DD, so this is a belt.
    const src = (daily || [])
      .filter(d => typeof d?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.date))
      .sort((a, b) => a.date.localeCompare(b.date));
    if (grain === 'day') return src.map(d => ({ ...d, bucket: d.date }));
    const acc = new Map();
    for (const d of src) {
      // Dates are IST-bucketed by the worker, so `new Date(d.date)` is parsed as UTC midnight
      // and only ever used for arithmetic here — no further timezone shifting.
      let key;
      if (grain === 'month') key = (d.date || '').slice(0, 7);
      else {
        const dt = new Date(`${d.date}T00:00:00Z`);
        const dow = (dt.getUTCDay() + 6) % 7;            // Monday-start week
        dt.setUTCDate(dt.getUTCDate() - dow);
        key = dt.toISOString().slice(0, 10);
      }
      const cur = acc.get(key) || { bucket: key, in_total: 0, in_answered: 0, out_total: 0, out_answered: 0 };
      cur.in_total += d.in_total || 0;   cur.in_answered += d.in_answered || 0;
      cur.out_total += d.out_total || 0; cur.out_answered += d.out_answered || 0;
      acc.set(key, cur);
    }
    return [...acc.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
  }, [daily, grain]);

  if (!rows.length) return <div style={{ fontSize: 12.5, color: 'var(--t3)' }}>No calls in range.</div>;

  const series = [
    { key: 'in_total',    name: 'Inbound',           color: 'info',   kind: 'area' },
    { key: 'in_answered', name: 'Inbound answered',  color: 'ok',     kind: 'line' },
    { key: 'out_total',   name: 'Outbound',          color: 'accent', kind: 'line' },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        {['day', 'week', 'month'].map(g => (
          <button key={g} onClick={() => setGrain(g)}
            style={{ padding: '4px 10px', fontSize: 11.5, borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                     textTransform: 'capitalize', fontWeight: grain === g ? 700 : 500,
                     border: `1px solid ${grain === g ? 'var(--accent)' : 'var(--border-2)'}`,
                     background: grain === g ? 'var(--accent)' : 'transparent',
                     color: grain === g ? '#fff' : 'var(--t2)' }}>
            {g}
          </button>
        ))}
      </div>
      <TrendChart data={rows} xKey="bucket" series={series} height={240}
        xLabel={grain === 'month' ? 'Month' : grain === 'week' ? 'Week beginning' : 'Day'} showLegend />
    </div>
  );
}

function CallsBreakdown({ rows, variant }) {
  if (!rows?.length) return <div style={{ color:'var(--t4)', fontSize: 12, padding: 12, textAlign:'center' }}>No data</div>;
  if (variant === 'agent') {
    return (
      <table style={{ width:'100%', borderCollapse: 'collapse', fontSize: 12 }}>
        {/* "Answered" used to be answered calls in BOTH directions, so an agent's outbound
            calling was invisible here — the whole of Pruthvi's 2026-08-26 report. It is now
            split: Answered is inbound only, Outgoing is calls they placed, Connected is how
            many of those were picked up. ⚠️ Answered will read LOWER than before for anyone
            who makes outbound calls; that is the correction, not a regression. */}
        <thead><tr style={{ color:'var(--t3)', textAlign:'left' }}>
          <CTh>Agent</CTh><CTh>Answered (in)</CTh><CTh>Outgoing</CTh><CTh>Connected</CTh><CTh>Missed → returned</CTh><CTh>Avg handle</CTh><CTh>Tickets opened</CTh>
        </tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.name} style={{ borderTop: '1px solid var(--border)' }}>
              <CTd>{r.name}</CTd>
              <CTd><code style={callMono}>{r.incoming_answered ?? r.answered_calls}</code></CTd>
              <CTd><code style={callMono}>{r.outgoing_total ?? 0}</code></CTd>
              <CTd><code style={callMono}>{r.outgoing_answered ?? 0}</code></CTd>
              <CTd><code style={callMono}>{r.missed_returned}</code></CTd>
              <CTd><code style={callMono}>{r.avg_handle_seconds == null ? '—' : `${Math.floor(r.avg_handle_seconds/60)}:${String(r.avg_handle_seconds%60).padStart(2,'0')}`}</code></CTd>
              <CTd><code style={callMono}>{r.tickets_opened}</code></CTd>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <table style={{ width:'100%', borderCollapse: 'collapse', fontSize: 12 }}>
      <thead><tr style={{ color:'var(--t3)', textAlign:'left' }}>
        <CTh>{variant === 'dept' ? 'Department' : 'Account'}</CTh><CTh>Total</CTh><CTh>Answered</CTh><CTh>Missed</CTh><CTh>Answer rate</CTh>
      </tr></thead>
      <tbody>
        {rows.map(r => (
          <tr key={r.slug} style={{ borderTop: '1px solid var(--border)' }}>
            <CTd>{r.name}</CTd>
            <CTd><code style={callMono}>{r.total}</code></CTd>
            <CTd><code style={callMono}>{r.answered}</code></CTd>
            <CTd><code style={callMono}>{r.missed}</code></CTd>
            <CTd><code style={callMono}>{r.answer_rate_pct != null ? `${r.answer_rate_pct}%` : '—'}</code></CTd>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DirectionTable({ d }) {
  if (!d) return null;
  return (
    <table style={{ width:'100%', borderCollapse:'collapse', fontSize: 12 }}>
      <thead><tr style={{ color:'var(--t3)', textAlign:'left' }}>
        <CTh>Direction</CTh><CTh>Total</CTh><CTh>Answered</CTh><CTh>Answer rate</CTh>
      </tr></thead>
      <tbody>
        <tr style={{ borderTop: '1px solid var(--border)' }}>
          <CTd>Incoming</CTd><CTd><code style={callMono}>{d.incoming?.total ?? 0}</code></CTd>
          <CTd><code style={callMono}>{d.incoming?.answered ?? 0}</code></CTd>
          <CTd><code style={callMono}>{d.incoming?.answer_rate_pct != null ? `${d.incoming.answer_rate_pct}%` : '—'}</code></CTd>
        </tr>
        <tr style={{ borderTop: '1px solid var(--border)' }}>
          <CTd>Outgoing</CTd><CTd><code style={callMono}>{d.outgoing?.total ?? 0}</code></CTd>
          <CTd><code style={callMono}>{d.outgoing?.answered ?? 0}</code></CTd>
          <CTd><code style={callMono}>{d.outgoing?.answer_rate_pct != null ? `${d.outgoing.answer_rate_pct}%` : '—'}</code></CTd>
        </tr>
      </tbody>
    </table>
  );
}

function HourlyBars({ hourly }) {
  const max = Math.max(1, ...hourly.map(h => h.count));
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 120, padding: '12px 4px 0' }}>
      {hourly.map(h => (
        <div key={h.hour} style={{ flex: 1, display:'flex', flexDirection:'column', alignItems:'center' }}>
          <div style={{ width: '70%', background: 'var(--yellow)', height: `${(h.count / max) * 100}%`, minHeight: h.count ? 2 : 0, borderRadius: '2px 2px 0 0' }} title={`${h.hour}:00 — ${h.count} calls`} />
          <div style={{ marginTop: 4, fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--t3)' }}>{String(h.hour).padStart(2,'0')}</div>
        </div>
      ))}
    </div>
  );
}

function CTh({ children }) { return <th style={{ padding:'6px 10px', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--t3)', textAlign: 'left' }}>{children}</th>; }
function CTd({ children }) { return <td style={{ padding:'6px 10px', verticalAlign:'middle', color: 'var(--t1)' }}>{children}</td>; }
const callMono = { fontFamily:'var(--font-mono)', fontSize: 12, color: 'var(--t1)' };

const dateInput = {
  background: 'var(--surface)',
  color: 'var(--t1)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  padding: '4px 8px',
  fontFamily: 'var(--font-mono)', fontSize: 12,
  colorScheme: 'dark', accentColor: 'var(--accent)',
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

// The 13 metric definitions, agreed with Pruthvi (#bugs thread ts 1787166011.976599,
// wording finalised 2026-08-24): his drafts, with the four corrections he accepted.
const TIPS = {
  assigned: 'Conversations assigned to this agent within the selected date range (counted on the day they were assigned).',
  handled: "Conversations this agent personally replied to in the range — credits whoever actually sent the reply, even when covering a colleague's chat.",
  queries: 'Customer-initiated conversations raised in the range and attributed to this agent.',
  open: 'Of those queries, still open right now.',
  resolved: "Conversations closed as 'resolved' in the range — the customer's issue was addressed (counted on the day closed).",
  closed_ops: 'Closed for administrative reasons (spam, duplicates, wrong number…) rather than issue resolution.',
  closed: 'Everything closed in the range — Resolved + Closed (ops) + closed without a recorded reason.',
  resolution: 'Resolved ÷ Queries: conversations genuinely resolved, as a share of queries raised in the range.',
  answered: 'Queries that received at least one agent reply.',
  never_answered: 'Queries with no agent reply yet — the priority pile.',
  avg_first_reply: "Average time from the customer's first message to the agent's first reply.",
  avg_reply: 'Average agent response time across every customer message in the conversation.',
  avg_to_close: 'Average time from a query being raised to it being closed. This is the FULL wall clock — it includes time spent waiting on the customer and time the conversation sat finished but unclosed. Neither is paused; both are shown separately so you can subtract them.',
  customer_wait: 'Of the time to close, how much was spent waiting on the customer — every stretch where we had replied last and the next move was theirs. Subtract it from Total to close to get our own time.',
  close_lag: 'Of the time to close, how much fell AFTER the last message in the conversation — nobody was talking, it simply had not been closed yet. This is closing discipline rather than resolution speed, and it is usually the largest slice.',
  active_handling: 'Total to close, minus waiting on the customer, minus waiting to be closed — the part that reflects how fast the conversation was actually worked.',
  on_us: "Open queries where the last message is the customer's — waiting on an agent.",
};

function Th({ children, align = 'left', tip }) {
  if (tip) {
    return (
      <th title={tip} style={{ padding: '7px 10px', textAlign: align, color: 'var(--t3)', fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, letterSpacing: 'var(--tracking-wide)', textTransform: 'uppercase', cursor: 'help' }}>
        <span style={{ borderBottom: '1px dotted var(--t3)' }}>{children}</span>
      </th>
    );
  }
  return ThPlain({ children, align });
}
function ThPlain({ children, align = 'left' }) {
  return <th style={{ padding: '7px 10px', textAlign: align, color: 'var(--t3)', fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, letterSpacing: 'var(--tracking-wide)', textTransform: 'uppercase' }}>{children}</th>;
}

function Td({ children, mono, align = 'left', color }) {
  return <td style={{ padding: '8px 10px', textAlign: align, color: color || 'var(--t2)', fontFamily: mono ? 'var(--font-mono)' : 'inherit', fontSize: 12.5 }}>{children}</td>;
}
