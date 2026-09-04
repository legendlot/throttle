'use client';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, EmptyState } from '@throttle/ui';
import { BarChart3, Download, Phone, Users } from 'lucide-react';
import { csopsGet, joinMulti } from '../../../lib/csopsFetch.js';
import { KpiCard, MultiSelect, btnGhost } from '../../../components/kit/index.js';
// TrendChart is deliberately NOT re-exported from kit/index.js (it pulls ~110KB of recharts),
// so it is imported directly — same as the analytics page does.
import { TrendChart } from '../../../components/kit/Chart.js';
import { dateStr } from '@throttle/domain';

// IST-EXPLICIT range boundaries (S344) — same fix as analytics/page.js, and the same bug: these
// used the VIEWER's midnight via setHours(), so a non-IST browser shifted the whole range and every
// number on the page with it. The user's picker gives the calendar date they mean; the boundary we
// want is IST midnight, because the business day is IST.
// ⚠️ Verified under TZ=Asia/Kolkata (byte-identical, a no-op for the team today) and
// TZ=America/New_York (corrected — the old code lost the first 9.5 hours of the day).
const pad2 = (n) => String(n).padStart(2, '0');
// ⚠️ Accepts EITHER a Date (the preset paths build Date objects) OR a 'YYYY-MM-DD' string (what
// <input type="date"> gives us). Both callers exist, and getting this wrong broke both ways in
// S344 before the hostile review caught it:
//   - reading .getFullYear() straight off the argument THREW on the string path (page crash)
//   - round-tripping the string through `new Date(s)` parses it as UTC, so in a west-of-UTC
//     browser the calendar date moves back a day and the range starts a whole IST day early
// A 'YYYY-MM-DD' string is ALREADY the calendar date the user picked, so slice it and never
// re-parse it. Only a Date needs its LOCAL Y/M/D read.
const istBoundary = (d, endOfDay) => {
  const ymd = typeof d === 'string'
    ? d.slice(0, 10)
    : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return new Date(`${ymd}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}+05:30`).toISOString();
};
// A value beginning = + - @ is executed as a formula by Excel/Sheets, and an agent name
// containing a comma would split the cohort line into two columns. Same helper the analytics
// export already has (hostile review S344, finding 7).
const csvEsc = (v) => {
  let x = v == null ? '' : String(v);
  if (/^[=+\-@]/.test(x)) x = "'" + x;
  return /[",\r\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
};
function toIsoStart(date) { return istBoundary(date, false); }
function toIsoEnd(date)   { return istBoundary(date, true); }
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
  // Trend (S349b/c) — its own request, its own effect, its own error: a slow or failed trend costs
  // only its panel, exactly as the wait breakdown does. Never touches `loading` or `error`.
  const [dailyData, setDailyData] = useState(null);
  const [dailyErr, setDailyErr] = useState(null);
  const [dailyMetric, setDailyMetric] = useState('queries');
  const [dailyClamped, setDailyClamped] = useState(false);   // range longer than the daily cap
  const [dailyGrain, setDailyGrain] = useState('day');       // 'day' | 'week' | 'month' (S349c)
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Agents-tab filters (Pruthvi #bugs 2026-07-25). businessHours defaults ON since
  // 2026-08-27 (Pruthvi, #bugs 1787684420 reply): the team is judged on these numbers,
  // so the default basis is their rostered hours; untick for the 24x7 view.
  // MULTI-select since S347 (string[]; [] = All). The Tickets tab and all six Analytics
  // dimensions went multi-select in S344 and this tab was the last single-select surface.
  // It could not be done in the UI alone: cs_agent_conversation_report aggregates SERVER-side,
  // so post-filtering rows would leave the KPI totals whole-cohort while the table under them
  // was filtered — correct-looking and wrong. Both RPCs took array params instead.
  const [agChannels, setAgChannels] = useState([]);
  const [agTags, setAgTags] = useState([]);
  const [agAgents, setAgAgents] = useState([]);
  const [businessHours, setBusinessHours] = useState(true);
  const [tags, setTags] = useState([]);
  // The agent roster is captured from an UNFILTERED response and then held. Deriving the
  // options from the current response instead would shrink the list as soon as you picked
  // someone, leaving no way to add a second agent.
  const [agRoster, setAgRoster] = useState([]);

  // Tickets-tab filters (Pruthvi #bugs 1788512544, S344). Reports had NO agent dimension while
  // Analytics has had one, and Pitstop is used across departments — a team's numbers could not
  // be isolated here at all. Both MULTI-select (string[]; [] = All), sent to getReports as a
  // comma-separated list. Option lists come from the response, computed BEFORE the filters, so
  // picking an agent does not collapse the channel list.
  const [tkAgents, setTkAgents] = useState([]);
  const [tkChannels, setTkChannels] = useState([]);

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
    if (view === 'tickets') {
      if (tkAgents.length)   args.agent   = joinMulti(tkAgents);
      if (tkChannels.length) args.channel = joinMulti(tkChannels);
    }
    if (view === 'agents') {
      if (agChannels.length) args.channel = joinMulti(agChannels);
      if (agTags.length)     args.tag_id  = joinMulti(agTags);
      if (agAgents.length)   args.agent   = joinMulti(agAgents);
      if (businessHours) args.business_hours = 'true';
    }
    csopsGet(action, args, session)
      .then(d => {
        if (!alive) return;
        if (view === 'calls') setCallData(d);
        else if (view === 'agents') {
          setAgentData(d);
          // Only a TRULY unfiltered response describes the whole roster. Guarding on the agent
          // chips alone (as this did when it shipped) let a channel- or tag-filtered response
          // freeze the roster to that subset, after which the other agents were unreachable
          // until every chip was cleared — caught by the S347 hostile review.
          if (!agAgents.length && !agChannels.length && !agTags.length) {
            setAgRoster((d?.by_agent || [])
              .filter(a => a.agent_id)
              .map(a => ({ v: a.agent_id, l: a.name })));
          }
        }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, from, to, view, agChannels, agTags, agAgents, businessHours, tkAgents, tkChannels]);

  // The Agents trend is its OWN effect (S349c review): it shares the filters and basis with the
  // report above, but a grain change must refetch only the trend — keyed into the main effect it
  // re-ran the ~3 s YTD report and spinnered the whole tab for a dropdown the user just touched.
  // Worker fans out one report per bucket, capped per grain, so the page clamps first.
  useEffect(() => {
    if (!session || view !== 'agents') return;
    let alive = true;
    const args = { from: toIsoStart(from), to: toIsoEnd(to) };
    if (agChannels.length) args.channel = joinMulti(agChannels);
    if (agTags.length)     args.tag_id  = joinMulti(agTags);
    if (agAgents.length)   args.agent   = joinMulti(agAgents);
    if (businessHours) args.business_hours = 'true';
    // Grain-aware clamp in DAYS: 62 days · 62 weeks (62*7-6 days is exactly tight) · 24 months
    // (24*28 days is conservative — the worker's month cap is lower because a month costs ~1.6 s).
    const dayCount = Math.round((Date.parse(toIsoStart(to)) - Date.parse(toIsoStart(from))) / 86400000) + 1;
    const maxDays = dailyGrain === 'month' ? MONTH_MAX_BUCKETS * 28 : dailyGrain === 'week' ? DAILY_MAX_DAYS * 7 - 6 : DAILY_MAX_DAYS;
    const clamped = dayCount > maxDays;
    const dailyArgs = {
      ...(clamped
        ? { ...args, from: toIsoStart(new Date(Date.parse(toIsoStart(to)) - (maxDays - 1) * 86400000 + 5.5 * 3600 * 1000).toISOString().slice(0, 10)) }
        : args),
      grain: dailyGrain,
    };
    setDailyData(null); setDailyErr(null); setDailyClamped(clamped);
    csopsGet('getAgentConversationDaily', dailyArgs, session)
      .then(d => { if (alive) setDailyData(d); })
      .catch(e => { if (alive) { setDailyData(null); setDailyErr(e.message); } });
    return () => { alive = false; };
  }, [session, view, from, to, agChannels, agTags, agAgents, businessHours, dailyGrain]);

  function exportCsv() {
    // Tab-aware: the Agents tab must not silently hand you the Tickets CSV.
    if (view === 'agents') return exportAgentsCsv();
    if (!data) return;
    const lines = [];
    lines.push(`Pitstop Report,${from} to ${to}`);
    // The cohort travels WITH the file, same reason the Agents CSV carries its basis and
    // channel: a filtered export read next week must not be mistaken for the whole month.
    // Read off the RESPONSE, never the live controls — `data` holds the previous payload
    // until a refetch resolves, so the controls could stamp new filters onto old numbers.
    const applied = data.applied_filters || {};
    lines.push(`Agent,${csvEsc((applied.agent || []).join(' · ') || 'All')}`);
    lines.push(`Support channel,${csvEsc((applied.channel || []).join(' · ') || 'All')}`);
    lines.push(`Tickets raised,${data.range.total_rows}`);
    if (data.range.range_total != null && data.range.range_total !== data.range.total_rows) {
      lines.push(`Tickets raised in range (before filters),${data.range.range_total}`);
    }
    if (data.conversations) {
      // `unfiltered` = the counts RPC is date-ranged only, so this figure is the WHOLE range
      // even when the ticket numbers above are a one-agent slice. Say so in the file.
      lines.push(`Conversations handled${data.conversations.unfiltered ? ' (whole range — not filtered)' : ''},${data.conversations.handled}`);
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
    // Raised and Closed are on different date bases (raised-in-window vs closed-in-window) —
    // the header says so, because a CSV outlives the screen that explained it.
    lines.push('By Agent,Raised in range,Closed in range,Avg close (days)');
    for (const r of data.by_agent) {
      lines.push(`${r.name},${r.total},${r.closed},${r.avg_close_days ?? ''}`);
    }
    lines.push('');
    lines.push('Cost Summary');
    lines.push(`Return cost (₹),${data.cost_summary.return_cost_inr}`);
    lines.push(`Replacement cost (₹),${data.cost_summary.replacement_cost_inr}`);
    lines.push(`Refund amount (₹),${data.cost_summary.refund_amount_inr}`);
    // BOM first — Excel ignores the MIME charset on a double-clicked .csv (S349 review).
    const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
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
    lines.push(`Channel,${esc(agChannels.length ? agChannels.map(c => CHANNEL_OPTS.find(o => o.v === c)?.l || c).join(' | ') : 'All')}`);
    lines.push(`Tag,${esc(agTags.length ? agTags.map(id => tags.find(x => x.id === id)?.name || id).join(' | ') : 'All')}`);
    lines.push(`Agent,${esc(agAgents.length ? agAgents.map(id => agRoster.find(a => a.v === id)?.l || id).join(' | ') : 'All')}`);
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
    lines.push('Agent,Assigned,Handled,Open,Resolved,Closed (operational),Closed (no reason),Closed,Closed rate %,Resolution rate %,Answered,Never answered,Answer rate %,Avg first reply (min),Avg reply (min),Avg to close (min),Avg waiting on customer (min),Avg waiting to be closed (min),Waiting on us,Waiting on customer');
    for (const r of agentData.by_agent) {
      lines.push([r.name, r.assigned, r.handled, r.open, r.resolved, r.closed_ops, r.closed_unspecified,
        r.closed, r.resolution_rate, r.resolve_rate, r.answered, r.unanswered,
        r.answer_rate, r.avg_frt_min, r.avg_response_min, r.avg_resolution_min,
        wt ? wByAgent.get(r.agent_id || r.name)?.avg_customer_wait_min : '',
        wt ? wByAgent.get(r.agent_id || r.name)?.avg_close_lag_min : '',
        r.waiting_agent, r.waiting_customer].map(esc).join(','));
    }
    // Daily trend (S349b) — every metric, one row per day for the team, then per agent. Only when
    // the panel actually loaded: an absent block is honest, a block of blanks reads as zeros.
    if (dailyData?.days?.length) {
      const M = dailyData.metrics || [];
      lines.push('');
      const gw = grainWord(dailyData.range?.grain);
      lines.push(`${gw.title} trend (${dailyData.range?.business_hours ? 'business hours' : '24x7'}),${dailyData.days.length} ${gw.plural}`);
      lines.push([gw.bucket, 'Agent', ...M.map(m => m.label + (m.kind === 'minutes' ? ' (min)' : m.kind === 'pct' ? ' %' : ''))].map(esc).join(','));
      for (const d of dailyData.days) lines.push([d.day, 'All agents', ...M.map(m => d[m.key] ?? '')].map(esc).join(','));
      for (const a of (dailyData.by_agent || [])) {
        for (const d of a.days) lines.push([d.day, a.name, ...M.map(m => d[m.key] ?? '')].map(esc).join(','));
      }
    }
    // BOM first: agent names and the "— unassigned —" bucket are non-ASCII (S349 review).
    const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pitstop-agents-${from}-to-${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Options for the tickets-tab filters. A value that is selected but absent from the current
  // response (the date range moved under it) is still listed — otherwise the control silently
  // blanks to "All" while the report is still filtered by it.
  function ticketOptions(key) {
    const opts = data?.filter_options?.[key] || [];
    const sel = key === 'agent' ? tkAgents : tkChannels;
    const missing = sel.filter(v => !opts.includes(v));
    return missing.length ? [...missing, ...opts] : opts;
  }

  // Same rule as ticketOptions: a selected agent absent from the roster (the range moved under
  // it) is still listed, or the control silently reads "All" while the report stays filtered.
  function agentOptions() {
    const missing = agAgents.filter(v => !agRoster.some(o => o.v === v));
    return missing.length ? [...missing.map(v => ({ v, l: v })), ...agRoster] : agRoster;
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
          {/* The one range Pruthvi said he would open every morning (2026-08-26): a rolling week.
              A preset rather than a default — the Tickets tab's YTD default is what finance reads. */}
          <button onClick={() => { const d = new Date(); const f = new Date(d); f.setDate(d.getDate() - 6);
                                   setFrom(dateStr(f)); setTo(dateStr(d)); }}
            style={{ ...btnGhost, padding: '5px 10px', fontSize: 11.5 }} title="Today and the six days before it">
            Last 7 days
          </button>
          <button onClick={() => { const d = new Date(); setFrom(dateStr(new Date(d.getFullYear(), d.getMonth(), 1))); setTo(dateStr(d)); }}
            style={{ ...btnGhost, padding: '5px 10px', fontSize: 11.5 }} title="The 1st of this month to today">
            MTD
          </button>
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

      {/* ⚠️ The 50,000-row hard stop MUST be visible. Both paged fetches set range.truncated
          and, until 2026-09-03, nothing on this page read it — which rebuilt the exact bug the
          paging replaced (a capped result that looks complete), one order of magnitude up.
          Mirrors the analytics banner. */}
      {(data?.range?.truncated || callData?.range?.truncated) && (
        <div style={{ padding: 12, marginBottom: 12, background: 'var(--warn-bg)', color: 'var(--warn-fg)', borderRadius: 'var(--radius-md)', fontSize: 13 }}>
          This range hit the 50,000-row ceiling, so the figures below and any export are incomplete. Narrow the dates.
        </div>
      )}

      {view === 'tickets' && (
        <>
        {/* Tickets-tab filters. Rendered outside the loading/empty branches on purpose: a filter
            that matches nothing must still be reachable to un-set. */}
        <TicketFilters
          agents={tkAgents} onAgents={setTkAgents} agentOptions={ticketOptions('agent')}
          channels={tkChannels} onChannels={setTkChannels} channelOptions={ticketOptions('channel')}
          rangeTotal={data?.range?.range_total} shownTotal={data?.range?.total_rows}
        />
        {loading || !data ? (
          <Spinner />
        ) : data.range.total_rows === 0 ? (
          (tkAgents.length || tkChannels.length)
            ? <EmptyState icon={BarChart3} title="No tickets match these filters" message="Nothing in this date range matches every filter you picked. Clear one and try again." />
            : <EmptyState icon={BarChart3} title="No tickets in range" message="Adjust the date range or create some tickets first." />
        ) : (
          <>
            {/* "Total cases" always counted TICKETS, which is why the two tiles Pruthvi
                asked for would have shown the same number. Relabelled to say what it
                is, with conversations handled beside it — not every conversation
                becomes a ticket (shipment / general queries often don't). */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 'var(--gap)', marginBottom: 'var(--gap)' }}>
              {/* ⚠️ The conversation counts RPC is date-ranged only — it takes no agent or channel
                  argument — so under a filter this tile is the WHOLE range while every tile beside
                  it is the slice. The sub-label says so rather than letting it read as the slice. */}
              <KpiCard label="Conversations handled" value={data.conversations ? data.conversations.handled.toLocaleString() : '—'}
                       sub={data.conversations
                         ? (data.conversations.unfiltered
                             ? `of ${data.conversations.total.toLocaleString()} — whole range, unfiltered`
                             : `of ${data.conversations.total.toLocaleString()} incl. outbound`)
                         : 'unavailable'}
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
        )}
        </>
      )}

      {view === 'calls' && (
        loading || !callData ? <Spinner /> : <CallsPanel data={callData} />
      )}

      {view === 'agents' && (
        <>
          <AgentFilters
            channels={agChannels} onChannels={setAgChannels}
            tagIds={agTags} onTagIds={setAgTags} tags={tags}
            agents={agAgents} onAgents={setAgAgents} agentOptions={agentOptions()}
            businessHours={businessHours} onBusinessHours={setBusinessHours}
          />
          {loading || !agentData ? <Spinner /> : <AgentsPanel data={agentData} wait={waitData} />}
          {!loading && agentData && (
            <DailyTrendPanel data={dailyData} error={dailyErr} metric={dailyMetric} onMetric={setDailyMetric}
              businessHours={!!agentData.range?.business_hours} clamped={dailyClamped}
              grain={dailyGrain} onGrain={setDailyGrain} />
          )}
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

// Tickets tab — agent + support-channel cohort (Pruthvi #bugs 1788512544, S344). Both
// multi-select: Pitstop is used across departments, so "these three agents" is the normal
// question and one-at-a-time cannot answer it. The options are SERVER-side lists computed
// before the filters, not a hardcoded list like CHANNEL_OPTS below — the support channel is
// derived (calls fold into "Calls"), so only the worker can enumerate it honestly.
function TicketFilters({ agents, onAgents, agentOptions, channels, onChannels, channelOptions, rangeTotal, shownTotal }) {
  const active = agents.length + channels.length;
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 'var(--gap)' }}>
      <MultiSelect label="Agent"   value={agents}   options={agentOptions}   onChange={onAgents} />
      <MultiSelect label="Channel" value={channels} options={channelOptions} onChange={onChannels} title="Filter by the support channel the ticket came in on" />
      {active > 0 && (
        <>
          <button onClick={() => { onAgents([]); onChannels([]); }} style={{ ...btnGhost, padding: '5px 10px', fontSize: 11.5 }}>
            Clear filter{active > 1 ? 's' : ''}
          </button>
          {rangeTotal != null && (
            <span style={{ fontSize: 12, color: 'var(--t3)' }}>
              <strong style={{ color: 'var(--t1)' }}>{shownTotal}</strong> of {rangeTotal} tickets raised in range
            </span>
          )}
        </>
      )}
    </div>
  );
}

// ── Daily trend (S349b) ─────────────────────────────────────────────────────────────────────
// One line for the team, one per agent, for a metric the reader picks. The data is the Agents
// report evaluated per IST day (worker), so every point carries the definition and date basis the
// strip above the table documents. Agents are capped at the six busiest by handled; the rest are
// summed into "Others" for COUNT metrics only — an average of averages is not a number anyone
// should read, so for minutes/rates the smaller agents are simply not drawn.
const DAILY_TOP_AGENTS = 6;
const DAILY_MAX_DAYS = 62;     // mirrors csops MAX_DAILY_DAYS — the page clamps so the worker never has to refuse
const MONTH_MAX_BUCKETS = 24;  // mirrors csops MAX_MONTH_BUCKETS
const GRAINS = [['day', 'Daily'], ['week', 'Weekly'], ['month', 'Monthly']];
function grainWord(g) {
  if (g === 'month') return { title: 'Monthly', plural: 'months', bucket: 'Month' };
  if (g === 'week')  return { title: 'Weekly',  plural: 'weeks',  bucket: 'Week beginning' };
  return { title: 'Daily', plural: 'days', bucket: 'Day' };
}
const fmtSecs = (s) => s == null || isNaN(s) ? '—' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const DAILY_COLORS = ['#7b93ff', '#25D366', '#F59E0B', '#E1306C', '#0084FF', '#a78bfa', '#f472b6'];
const fmtDay = (d, grain) => {
  const t = Date.parse(`${d}T00:00:00Z`);
  if (!Number.isFinite(t)) return d;
  if (grain === 'month') return new Date(t).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  return new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
};

function DailyTrendPanel({ data, error, metric, onMetric, businessHours, clamped, grain = 'day', onGrain, title }) {
  const metrics = data?.metrics || [];
  const m = metrics.find(x => x.key === metric) || metrics[0];
  const rows = useMemo(() => {
    if (!data?.days?.length || !m) return [];
    const top = (data.by_agent || []).slice(0, DAILY_TOP_AGENTS);
    const rest = (data.by_agent || []).slice(DAILY_TOP_AGENTS);
    return data.days.map((d, i) => {
      const row = { day: d.day, team: d[m.key] };
      if (m.teamOnly) return row;   // a metric with no per-agent meaning (e.g. calls nobody took)
      for (const a of top) row[a.name] = a.days[i]?.[m.key] ?? null;
      if (rest.length && m.kind === 'count') row.Others = rest.reduce((s, a) => s + (a.days[i]?.[m.key] || 0), 0);
      return row;
    });
  }, [data, m]);
  const series = useMemo(() => {
    if (!data?.by_agent || !m) return [];
    const top = data.by_agent.slice(0, DAILY_TOP_AGENTS);
    // A literal, not var(--t1): recharts writes `stroke` as an SVG presentation attribute, where a
    // CSS variable is not guaranteed to resolve (Chart.js documents the same constraint).
    const out = [{ key: 'team', name: 'All agents', color: '#f5f5f6', kind: 'line' }];
    if (m.teamOnly) return out;
    top.forEach((a, i) => out.push({ key: a.name, name: a.name, color: DAILY_COLORS[i % DAILY_COLORS.length], kind: 'line' }));
    if (data.by_agent.length > DAILY_TOP_AGENTS && m.kind === 'count') out.push({ key: 'Others', name: 'Others', color: '#8b8f98', kind: 'line' });
    return out;
  }, [data, m]);
  const yFmt = m?.kind === 'minutes' ? (v) => dur(v) : m?.kind === 'seconds' ? fmtSecs : m?.kind === 'pct' ? (v) => `${v}%` : undefined;
  const gw = grainWord(grain);
  const hidden = Math.max(0, (data?.by_agent?.length || 0) - DAILY_TOP_AGENTS);

  return (
    <div style={{ marginTop: 'var(--gap)', padding: 'var(--pad)', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <div style={{ fontFamily: 'var(--f-mono)', fontSize: 11, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          {title || `${gw.title} trend`}{businessHours != null ? ` · ${businessHours ? 'business hours' : '24×7'}` : ''}
        </div>
        {onGrain && (
          <select value={grain} onChange={e => onGrain(e.target.value)}
            style={{ fontFamily: 'var(--f-ui)', fontSize: 12, padding: '4px 8px', background: 'var(--surface-2)', color: 'var(--t1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
            {GRAINS.map(([g, l]) => <option key={g} value={g}>{l}</option>)}
          </select>
        )}
        <select value={m?.key || ''} onChange={e => onMetric(e.target.value)}
          style={{ fontFamily: 'var(--f-ui)', fontSize: 12, padding: '4px 8px', background: 'var(--surface-2)', color: 'var(--t1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
          {metrics.map(x => <option key={x.key} value={x.key}>{x.label}</option>)}
        </select>
        {data?.range && <span style={{ fontSize: 11.5, color: 'var(--t3)' }}>{clamped ? `last ${data.range.days} ${gw.plural} of the range shown (caps at ${DAILY_MAX_DAYS})` : `${data.range.days} ${gw.plural}`}{m?.teamOnly ? ' · team only (this metric has no per-agent meaning)' : ` · one line per agent, busiest ${Math.min(DAILY_TOP_AGENTS, data.by_agent?.length || 0)} shown${hidden > 0 ? (m?.kind === 'count' ? `, ${hidden} more as Others` : `, ${hidden} more not drawn (no honest average of averages)`) : ''}`}</span>}
        {/* Verified live 2026-09-04: queries/answered/assigned/resolved sum to the range total exactly;
            handled does NOT (1,589 vs 1,179 over 7 days) because a conversation replied to on three
            days is handled on each of them and once in the range. Say so, or the sum reads as a bug. */}
        {m?.key === 'handled' && <span style={{ fontSize: 11.5, color: 'var(--t4)' }}>A conversation counts in every {gw.plural.slice(0, -1)} it was replied to, so the {gw.plural} add up to more than the range total.</span>}
        {grain !== 'day' && data?.days?.length > 0 && <span style={{ fontSize: 11.5, color: 'var(--t4)' }}>The first and last {gw.plural.slice(0, -1)} cover only the part inside the selected dates.</span>}
      </div>
      {error ? (
        <div style={{ color: 'var(--warn-fg)', fontSize: 12.5, padding: '12px 0' }}>{error}</div>
      ) : !data ? (
        <Spinner />
      ) : (
        <TrendChart data={rows} xKey="day" series={series} xFmt={(d) => fmtDay(d, grain)} yFmt={yFmt} height={260} xLabel={gw.bucket} showLegend />
      )}
    </div>
  );
}

function AgentFilters({ channels, onChannels, tagIds, onTagIds, tags, agents, onAgents, agentOptions,
                       businessHours, onBusinessHours }) {
  const active = channels.length + tagIds.length + agents.length;
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 'var(--gap)' }}>
      <MultiSelect label="Agent"   value={agents}   options={agentOptions} onChange={onAgents}
        title="Filter by assigned agent — the KPIs above the table follow the same cohort" />
      <MultiSelect label="Channel" value={channels} options={CHANNEL_OPTS} onChange={onChannels}
        title="Filter by channel" />
      <MultiSelect label="Tag"     value={tagIds}
        options={tags.map(t => ({ v: t.id, l: t.name }))} onChange={onTagIds}
        title="Filter by tag" />
      {active > 0 && (
        <button onClick={() => { onAgents([]); onChannels([]); onTagIds([]); }}
          style={{ ...btnGhost, padding: '5px 10px', fontSize: 11.5 }}>
          Clear filter{active > 1 ? 's' : ''}
        </button>
      )}
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
        {/* ⚠️ These two were "Answered" (provider status, both directions) and "Missed"
            (totals.missed). Missed was FALSE for the whole MyOperator era — that system only
            wrote 'missed' in one narrow case that almost never fired, so it logged 45 missed
            calls in total while 4,330 inbound calls never reached anybody. They now show the
            inbound reality: reached an agent, and did not. "Didn't reach an agent" is
            deliberately not called "missed" — it includes IVR drop-offs and hang-ups before
            routing, so it is not all our failure to answer. Corrected 2026-09-03, approved by
            Pruthvi (#bugs 1788429685). */}
        <KpiCard label="Reached an agent" value={data.totals.incoming_reached?.toLocaleString() ?? '—'} sub="inbound" tone="var(--ok-fg)"  size={25} />
        <KpiCard label="Didn't reach an agent" value={data.totals.incoming_not_reached?.toLocaleString() ?? '—'} sub="inbound — incl. IVR drop-offs" tone={data.totals.incoming_not_reached > 0 ? 'var(--bad-fg)' : 'var(--t3)'} size={25} />
        <KpiCard label="Inbound answer rate"  value={data.by_direction?.incoming?.answer_rate_pct != null ? `${data.by_direction.incoming.answer_rate_pct}%` : '—'} tone="var(--warn-fg)" size={25} />
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

      {/* The trend panel draws its own card (shared with the Agents tab) — no Panel wrapper. */}
      <CallTrend daily={data.daily || []} byAgent={data.daily_by_agent || []} />

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
// Calls trend (S349c) — the SAME panel as the Agents tab, fed by folding the worker's per-day
// team rows and per-day per-agent rows into day / Monday-week / month buckets on the page. Only
// SUMS are folded (counts, duration sum + count); the rate and the average are derived per bucket
// AFTER the fold, so a weekly answer rate is the week's own rate, never a mean of daily rates.
const CALL_METRICS = [
  { key: 'in_total',     label: 'Inbound',                 kind: 'count', teamOnly: true },
  { key: 'in_answered',  label: 'Reached an agent',        kind: 'count' },
  { key: 'in_missed',    label: 'Did not reach an agent',  kind: 'count', teamOnly: true },
  { key: 'answer_rate',  label: 'Inbound answer rate',     kind: 'pct',   teamOnly: true },
  { key: 'out_total',    label: 'Outbound',                kind: 'count' },
  { key: 'out_answered', label: 'Outbound answered',       kind: 'count' },
  { key: 'avg_duration', label: 'Avg duration',            kind: 'seconds' },
];
function bucketOf(date, grain) {
  if (grain === 'month') return `${date.slice(0, 7)}-01`;
  if (grain === 'week') { const dt = new Date(`${date}T00:00:00Z`); dt.setUTCDate(dt.getUTCDate() - (dt.getUTCDay() + 6) % 7); return dt.toISOString().slice(0, 10); }
  return date;
}
const CALL_SUMS = ['in_total', 'in_answered', 'out_total', 'out_answered', 'dur_sum', 'dur_count'];
function finishCallRow(r, isTeam) {
  return {
    ...r,
    // Inbound totals exist only on the team rows (a call nobody took has no agent), so the two
    // derived inbound figures are team-only too — deriving them per agent gave negative "missed".
    in_missed:    isTeam ? (r.in_total || 0) - (r.in_answered || 0) : null,
    answer_rate:  isTeam && r.in_total ? +((100 * r.in_answered) / r.in_total).toFixed(1) : null,
    avg_duration: r.dur_count ? Math.round(r.dur_sum / r.dur_count) : null,
  };
}
function foldCalls(daily = [], byAgent = [], grain) {
  const ok = (d) => typeof d?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.date);
  const fold = (rows) => {
    const acc = new Map();
    for (const d of rows.filter(ok)) {
      const k = bucketOf(d.date, grain);
      const cur = acc.get(k) || Object.fromEntries([['day', k], ...CALL_SUMS.map(x => [x, 0])]);
      for (const x of CALL_SUMS) cur[x] += d[x] || 0;
      acc.set(k, cur);
    }
    return acc;
  };
  const team = fold(daily);
  const days = [...team.keys()].sort().map(k => finishCallRow(team.get(k), true));
  const by_agent = byAgent.map(a => {
    const f = fold(a.days || []);
    const rows = days.map(d => finishCallRow(f.get(d.day) || Object.fromEntries([['day', d.day], ...CALL_SUMS.map(x => [x, 0])]), false));
    return { name: a.name, agent_id: null, handled_total: rows.reduce((s, r) => s + (r.in_answered || 0) + (r.out_answered || 0), 0), days: rows };
  }).sort((a, b) => b.handled_total - a.handled_total || a.name.localeCompare(b.name));
  return { range: { days: days.length, grain }, metrics: CALL_METRICS, days, by_agent };
}
function CallTrend({ daily, byAgent }) {
  const [grain, setGrain] = useState('day');
  const [metric, setMetric] = useState('in_total');
  const data = useMemo(() => foldCalls(daily, byAgent, grain), [daily, byAgent, grain]);
  if (!data.days.length) {
    return (
      <div style={{ marginTop: 'var(--gap)', padding: 'var(--pad)', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
        <div style={{ fontFamily: 'var(--f-mono)', fontSize: 11, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Call trend</div>
        <div style={{ fontSize: 12.5, color: 'var(--t3)' }}>No calls in range.</div>
      </div>
    );
  }
  return <DailyTrendPanel data={data} metric={metric} onMetric={setMetric} grain={grain} onGrain={setGrain} title="Call trend" businessHours={null} />;
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
      {/* Split by direction to match by_agent and the totals (S344). "Answered" here used to be
          the provider's raw status across BOTH directions, so an inbound caller reaching a human
          and an outbound call being picked up were added together — and "Missed" was the
          MyOperator-era false 45, which the provider almost never set. ⚠️ Answer rate now reads
          LOWER and Not reached reads far HIGHER than before; that is the correction landing, the
          same one by_agent took in S340. */}
      <thead><tr style={{ color:'var(--t3)', textAlign:'left' }}>
        <CTh>{variant === 'dept' ? 'Department' : 'Account'}</CTh><CTh>Total</CTh><CTh>Answered (in)</CTh><CTh>Not reached (in)</CTh><CTh>Outgoing</CTh><CTh>Connected</CTh><CTh>Answer rate (in)</CTh>
      </tr></thead>
      <tbody>
        {rows.map(r => (
          <tr key={r.slug} style={{ borderTop: '1px solid var(--border)' }}>
            <CTd>{r.name}</CTd>
            <CTd><code style={callMono}>{r.total}</code></CTd>
            <CTd><code style={callMono}>{r.incoming_reached ?? r.answered}</code></CTd>
            <CTd><code style={callMono}>{r.incoming_not_reached ?? r.missed}</code></CTd>
            <CTd><code style={callMono}>{r.outgoing_total ?? 0}</code></CTd>
            <CTd><code style={callMono}>{r.outgoing_answered ?? 0}</code></CTd>
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
          {/* ⚠️ On the agent variant these two columns are on DIFFERENT date bases as of
              2026-09-03, so they must not both read as plain counts of one set. "Raised" is
              tickets raised in the window and assigned to them; "Closed" is tickets they closed
              in the window, whenever those were raised. Closed can therefore legitimately EXCEED
              Raised for anyone clearing backlog — labelling it "Total" made that read as a fault.
              % Share stays a share of raised. */}
          <Th align="right">{variant === 'agent' ? 'Raised' : 'Total'}</Th>
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
                {/* Same guard as the agent variant below — this array cannot currently be
                    non-empty with a zero total, but the two cells are the same class and
                    fixing one of two is how the class survives. */}
                <Td align="right" mono>{total ? `${((r.total / total) * 100).toFixed(1)}%` : '—'}</Td>
              </>
            ) : (
              <>
                <Td align="right" mono>{r.closed}</Td>
                <Td align="right" mono>{r.avg_close_days != null ? `${r.avg_close_days}d` : '—'}</Td>
                {/* ⚠️ Guarded since 2026-09-03. `by_agent` is now seeded from BOTH the raised
                    and the closed row sets, so a range with 0 raised and >=1 closed produces
                    rows whose totals are all 0 — 0/0 rendered "NaN%" on every line. Before the
                    split the array was empty in that case and this never ran. */}
                <Td align="right" mono>{total ? `${((r.total / total) * 100).toFixed(1)}%` : '—'}</Td>
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
