'use client';
/* ════════════════════════════════════════════════════════════
   OVERVIEW — "what needs me now" (handoff §6.1, NEW screen).
   KPI rail (6, date presets) · "Needs attention" exception feed
   (severity-filterable + right-slide drawer) · Agent load panel.
   Backed by getOverviewSummary (one dept-scoped, server-computed
   roll-up: point-in-time KPIs + EXACT exception counts + EXACT
   per-agent load) + getCallsKpis (call side). Ranged calls/
   resolved (week/month presets) layer in getReports/getCallReports.
   ════════════════════════════════════════════════════════════ */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import {
  KpiCard, SectionHead, DatePresets, SevFilter, ExceptionRow, Drawer, Icon,
  sevPalette, fmt, btnPrimary,
} from '../../components/kit/index.js';
import { TrendChart, hourFmt } from '../../components/kit/Chart.js';
import { csopsGet } from '../../lib/csopsFetch.js';
import { getActiveDept } from '../../components/DeptSwitcher.js';
import { useRefreshState } from './layout.js';

const AGENT_CAP = 15; // soft per-agent open-ticket capacity (no capacity field exists yet)

function rangeFor(preset) {
  // IST-anchored date-only bounds (the worker accepts ISO; date-only is fine).
  const istNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const to = istNow.toISOString().slice(0, 10);
  const d = new Date(istNow);
  if (preset === 'week') { const day = (d.getDay() + 6) % 7; d.setDate(d.getDate() - day); } // Monday
  else if (preset === 'month') { d.setDate(1); }
  const from = d.toISOString().slice(0, 10);
  return { from, to };
}

export default function OverviewPage() {
  const router = useRouter();
  const { perms, brandUser, session } = useAuth();
  const { setRefreshing, setLastRefreshed } = useRefreshState();

  const [preset, setPreset] = useState('today');
  const [sev, setSev] = useState('all');
  const [drawerId, setDrawerId] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!session) return;
    setRefreshing?.(true);
    try {
      const dept = getActiveDept(perms, brandUser?.cs_department_slug) || undefined;
      const dp = dept ? { department: dept } : {};
      // ONE dept-scoped, server-computed roll-up (point-in-time KPIs +
      // exception counts + EXACT per-agent load) + call KPIs.
      const [summary, callsKpis] = await Promise.all([
        csopsGet('getOverviewSummary', dp, session).catch(() => null),
        csopsGet('getCallsKpis', dp, session).catch(() => null),
      ]);

      let ranged = null;
      if (preset !== 'today') {
        const r = rangeFor(preset);
        const [rep, callRep] = await Promise.all([
          csopsGet('getReports', { ...dp, ...r }, session).catch(() => null),
          csopsGet('getCallReports', { ...dp, ...r }, session).catch(() => null),
        ]);
        ranged = { rep, callRep };
      }
      setData({ summary, callsKpis, ranged });
      setLastRefreshed?.(new Date());
    } finally {
      setRefreshing?.(false);
      setLoading(false);
    }
  }, [session, perms, brandUser?.cs_department_slug, preset, setRefreshing, setLastRefreshed]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const iv = setInterval(load, 30000);
    const onDept = () => load();
    window.addEventListener('pitstop:dept-changed', onDept);
    return () => { clearInterval(iv); window.removeEventListener('pitstop:dept-changed', onDept); };
  }, [load]);

  // ── KPI rail (from getOverviewSummary + getCallsKpis; ranged from reports) ──
  const kpis = useMemo(() => {
    const d = data || {};
    const s = d.summary || {}, ck = d.callsKpis || {};
    const isToday = preset === 'today';
    const callRepTot = d.ranged?.callRep?.totals;
    const resolvedRange = (d.ranged?.rep?.by_agent || []).reduce((s2, a) => s2 + (Number(a.closed) || 0), 0);
    const answerRate = isToday ? ck.answer_rate_pct : callRepTot?.answer_rate_pct;
    const calls = isToday ? ck.total_today : callRepTot?.total;
    const callsAnswered = isToday ? ck.answered_today : callRepTot?.answered;
    const resolved = isToday ? s.resolved_today : resolvedRange;
    const suffix = isToday ? 'today' : preset === 'week' ? '(wk)' : '(mo)';
    const num = v => (v == null ? '—' : fmt(v));
    return [
      { label: 'Open tickets', value: num(s.open), icon: 'list', tone: 'var(--accent)', sub: 'in queue', subTone: 'var(--t3)' },
      { label: 'SLA breached', value: num(s.sla_breached), icon: 'alert', tone: 'var(--bad-fg)',
        sub: (s.sla_breached ? 'needs action now' : 'all on track'), subTone: s.sla_breached ? 'var(--bad-fg)' : 'var(--t3)' },
      { label: 'Awaiting evidence', value: num(s.awaiting_evidence), icon: 'clock', tone: 'var(--warn-fg)', sub: 'aging >3d', subTone: 'var(--warn-fg)' },
      { label: 'Answer rate', value: answerRate == null ? '—' : `${answerRate}%`, icon: 'phone',
        tone: (answerRate != null && answerRate < 90) ? 'var(--warn-fg)' : 'var(--ok-fg)', sub: 'target 90%',
        subTone: (answerRate != null && answerRate < 90) ? 'var(--warn-fg)' : 'var(--ok-fg)' },
      { label: `Calls ${suffix}`, value: num(calls), icon: 'in', tone: 'var(--info-fg)',
        sub: callsAnswered != null ? `${fmt(callsAnswered)} answered` : '', subTone: 'var(--t3)' },
      { label: `Resolved ${suffix}`, value: num(resolved), icon: 'check', tone: 'var(--ok-fg)', sub: 'closed out', subTone: 'var(--ok-fg)' },
    ];
  }, [data, preset]);

  // ── exception feed (exact, from getOverviewSummary + getCallsKpis) ─────
  const exceptions = useMemo(() => {
    const d = data || {};
    const s = d.summary || {}, ck = d.callsKpis || {};
    const list = [];
    if ((s.sla_breached || 0) > 0) list.push({
      id: 'sla', sev: 'high', icon: 'alert', dept: 'ALL', title: `${s.sla_breached} ticket${s.sla_breached > 1 ? 's' : ''} past SLA`,
      detail: s.sla_oldest_days ? `Oldest ${s.sla_oldest_days}d past due` : 'Due date passed, still open',
      metric: String(s.sla_breached), owner: 'Leads',
      rec: 'These tickets have passed their SLA due date and are still open. Open the queue, advance the ones that can move, and escalate anything genuinely blocked before end of day.',
      ctx: [['Breached', String(s.sla_breached)], ['Oldest', `${s.sla_oldest_days || 0}d over`], ['Action', 'Advance / escalate'], ['Scope', 'Open queue']],
      primary: 'Open in Queue', route: '/queue?tab=open',
    });
    if ((ck.unanswered_awaiting_callback || 0) > 0) list.push({
      id: 'callback', sev: 'high', icon: 'missed', dept: 'Calls', title: `${ck.unanswered_awaiting_callback} missed call${ck.unanswered_awaiting_callback > 1 ? 's' : ''} awaiting callback`,
      detail: `Answer rate ${ck.answer_rate_pct != null ? ck.answer_rate_pct + '%' : '—'} today`,
      metric: String(ck.unanswered_awaiting_callback), owner: 'Floor',
      rec: 'These callers were missed and have not been called back. Return the calls — prioritise repeat numbers, which usually mean the same unresolved issue.',
      ctx: [['Missed', String(ck.missed_today ?? '—')], ['Awaiting', String(ck.unanswered_awaiting_callback)], ['Answer rate', `${ck.answer_rate_pct ?? '—'}%`], ['Target', '90%']],
      primary: 'Open Call Log', route: '/calls?tab=missed',
    });
    if ((s.awaiting_evidence || 0) > 0) list.push({
      id: 'evidence', sev: 'med', icon: 'clock', dept: 'ALL', title: `${s.awaiting_evidence} awaiting evidence >48h`,
      detail: 'Blocked on customer photo / video', metric: String(s.awaiting_evidence), owner: 'Messaging',
      rec: 'These are blocked on customer evidence. Send the approved evidence-request WhatsApp template to nudge, then snooze. Auto-close anything silent past policy.',
      ctx: [['Aging', String(s.awaiting_evidence)], ['Blocked on', 'Customer'], ['Nudge', 'WA template'], ['Then', 'Snooze 24h']],
      primary: 'Open in Queue', route: '/queue?tab=awaiting',
    });
    if ((s.refunds_pending || 0) > 0) list.push({
      id: 'refunds', sev: 'med', icon: 'refund', dept: 'ALL', title: `${s.refunds_pending} refund${s.refunds_pending > 1 ? 's' : ''} pending approval`,
      detail: s.refunds_total_inr ? `₹${fmt(s.refunds_total_inr)} inspected & ready` : 'Inspected & ready to initiate',
      metric: s.refunds_total_inr ? `₹${fmt(s.refunds_total_inr)}` : String(s.refunds_pending), owner: 'You',
      rec: 'These inspected tickets passed fault verification and are waiting on refund approval. Approve to initiate, or convert to a replacement if stock allows.',
      ctx: [['Pending', String(s.refunds_pending)], ['Total', `₹${fmt(s.refunds_total_inr || 0)}`], ['Stage', 'Inspected'], ['Next', 'Initiate / swap']],
      primary: 'Open in Queue', route: '/queue?disposition=refund&stage=inspected',
    });
    if ((s.unassigned || 0) > 0) list.push({
      id: 'unassigned', sev: 'med', icon: 'list', dept: 'ALL', title: `${s.unassigned} unassigned in queue`,
      detail: `${s.unassigned_from_calls || 0} auto-created from calls`, metric: String(s.unassigned), owner: 'Floor',
      rec: 'These tickets have no owner — several came from telephony and have no disposition yet. Claim & triage, or assign to the lightest-loaded agents.',
      ctx: [['Unassigned', String(s.unassigned)], ['From calls', String(s.unassigned_from_calls || 0)], ['Action', 'Claim / assign'], ['Scope', 'All open']],
      primary: 'Open in Queue', route: '/queue',
    });
    return list;
  }, [data]);

  const exFiltered = exceptions.filter(e => sev === 'all' || e.sev === sev);
  const drawerEx = exceptions.find(e => e.id === drawerId) || null;

  // ── agent load (EXACT, from getOverviewSummary) ────────────
  const agents = useMemo(() => {
    const rows = (data?.summary?.agents || []).map(a => {
      const name = a.name || '—';
      const open = Number(a.open) || 0;
      const pct = Math.min(100, Math.round((open / AGENT_CAP) * 100));
      const over = open > AGENT_CAP;
      const loadColor = over ? 'var(--bad-fg)' : pct > 75 ? 'var(--warn-fg)' : 'var(--ok-fg)';
      return { name, initial: (name[0] || '?').toUpperCase(), open, openLabel: `${open}/${AGENT_CAP}`, pct, loadColor };
    }).sort((a, b) => b.open - a.open);
    return rows;
  }, [data]);

  const presetRange = { today: 'Today · live', week: 'This week → today', month: '1st → today' }[preset];

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto' }}>
      <SectionHead sub={presetRange} action={<DatePresets value={preset} onChange={setPreset} />}>What needs me now</SectionHead>

      {/* KPI rail */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 'var(--gap)', marginBottom: 'var(--gap)' }}>
        {kpis.map((k, i) => <KpiCard key={i} {...k} size={27} />)}
      </div>

      {/* tickets created · hourly (today) */}
      <section style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden', marginBottom: 'var(--gap)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px var(--cardpad)', borderBottom: '1px solid var(--border)' }}>
          <span className="label" style={{ fontSize: 11, color: 'var(--t2)', fontWeight: 600 }}>Tickets created · hourly</span>
          <span className="num" style={{ fontSize: 10.5, color: 'var(--t4)' }}>today · IST</span>
        </div>
        <div style={{ padding: '14px 10px 6px' }}>
          <TrendChart
            data={data?.summary?.created_today_hourly || []}
            xKey="hour" xFmt={hourFmt} xLabel="Hour" height={220}
            series={[{ key: 'count', name: 'Created', color: 'accent', kind: 'area' }]}
          />
        </div>
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.55fr) minmax(0,1fr)', gap: 'var(--gap)' }}>
        {/* exception feed */}
        <section style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px var(--cardpad)', borderBottom: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="label" style={{ fontSize: 11, color: 'var(--t2)', fontWeight: 600 }}>Needs attention</span>
              <span className="num" style={{ fontSize: 10, color: 'var(--accent)', background: 'var(--accent-bg)', border: '1px solid var(--accent-bd)', borderRadius: 99, padding: '1px 7px' }}>{exFiltered.length}</span>
            </div>
            <SevFilter value={sev} onChange={setSev} />
          </div>
          <div style={{ padding: 8 }}>
            {loading && <div style={{ padding: 28, textAlign: 'center', color: 'var(--t3)', fontSize: 13 }}>Loading…</div>}
            {!loading && exFiltered.length === 0 && (
              <div style={{ padding: '36px 20px', textAlign: 'center', color: 'var(--t3)' }}>
                <Icon name="check" size={26} style={{ color: 'var(--ok-fg)' }} />
                <div style={{ marginTop: 10, fontSize: 13.5, color: 'var(--t2)' }}>Nothing needs you right now.</div>
                <div style={{ fontSize: 12, color: 'var(--t4)', marginTop: 3 }}>No SLA breaches, callbacks, or pending approvals in scope.</div>
              </div>
            )}
            {!loading && exFiltered.map(ex => <ExceptionRow key={ex.id} ex={ex} onClick={() => setDrawerId(ex.id)} />)}
          </div>
        </section>

        {/* agent load */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--gap)' }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px var(--cardpad)', borderBottom: '1px solid var(--border)' }}>
              <span className="label" style={{ fontSize: 11, color: 'var(--t2)', fontWeight: 600 }}>Agent load</span>
              <span className="num" style={{ fontSize: 10.5, color: 'var(--t3)' }}>{agents.length} agents</span>
            </div>
            <div style={{ padding: '8px 10px' }}>
              {agents.length === 0 && <div style={{ padding: 20, textAlign: 'center', color: 'var(--t3)', fontSize: 12.5 }}>No agents in scope.</div>}
              {agents.map(a => (
                <div key={a.name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 6px' }}>
                  <div style={{ width: 28, height: 28, borderRadius: '50%', flexShrink: 0, display: 'grid', placeItems: 'center',
                    fontFamily: 'var(--f-display)', fontWeight: 700, fontSize: 11, background: 'var(--surface-3)', color: 'var(--accent)', position: 'relative' }}>
                    {a.initial}
                    <span style={{ position: 'absolute', right: -1, bottom: -1, width: 8, height: 8, borderRadius: '50%', background: a.loadColor, border: '2px solid var(--surface)' }} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--t1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.name}</span>
                      <span className="num" style={{ fontSize: 10.5, color: 'var(--t3)' }}>{a.openLabel}</span>
                    </div>
                    <div style={{ height: 5, borderRadius: 99, background: 'var(--surface-3)', marginTop: 5, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${a.pct}%`, background: a.loadColor, borderRadius: 99 }} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>

      {/* exception drawer */}
      <Drawer open={!!drawerEx} onClose={() => setDrawerId(null)}>
        {drawerEx && (() => {
          const p = sevPalette(drawerEx.sev);
          return (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
                <span style={{ fontFamily: 'var(--f-display)', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
                  color: p.fg, background: p.bg, border: `1px solid ${p.bd}`, borderRadius: 5, padding: '3px 9px' }}>{drawerEx.sev} priority</span>
                <span style={{ flex: 1 }} />
                <button onClick={() => setDrawerId(null)} style={{ background: 'none', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-sm)', width: 28, height: 28, color: 'var(--t3)', cursor: 'pointer', display: 'grid', placeItems: 'center' }}><Icon name="x" size={14} /></button>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 18 }}>
                  <div style={{ width: 42, height: 42, borderRadius: 'var(--radius-sm)', flexShrink: 0, display: 'grid', placeItems: 'center', background: p.bg, color: p.fg, border: `1px solid ${p.bd}` }}><Icon name={drawerEx.icon} size={21} /></div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--t1)', lineHeight: 1.25 }}>{drawerEx.title}</div>
                    <div style={{ fontSize: 12.5, color: 'var(--t3)', marginTop: 3 }}>Owner · {drawerEx.owner}</div>
                  </div>
                  <span className="num" style={{ fontWeight: 700, fontSize: 26, color: p.fg, flexShrink: 0 }}>{drawerEx.metric}</span>
                </div>
                <div style={{ borderLeft: `2px solid ${p.bd}`, paddingLeft: 14, marginBottom: 20 }}>
                  <div className="label" style={{ fontSize: 10, color: 'var(--t2)', marginBottom: 6 }}>What to do</div>
                  <div style={{ fontSize: 13.5, color: 'var(--t2)', lineHeight: 1.55 }}>{drawerEx.rec}</div>
                </div>
                <div className="label" style={{ fontSize: 10, color: 'var(--t2)', marginBottom: 10 }}>Context</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9 }}>
                  {drawerEx.ctx.map(([kk, vv], i) => (
                    <div key={i} style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)', padding: '9px 12px' }}>
                      <div style={{ fontFamily: 'var(--f-display)', fontSize: 9, letterSpacing: '0.1em', color: 'var(--t4)', textTransform: 'uppercase' }}>{kk}</div>
                      <div className="num" style={{ fontSize: 14, fontWeight: 600, color: 'var(--t1)', marginTop: 3 }}>{vv}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ borderTop: '1px solid var(--border)', padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <button onClick={() => { setDrawerId(null); router.push(drawerEx.route); }} style={{ ...btnPrimary, width: '100%', padding: 12 }}>
                  {drawerEx.primary} <Icon name="chevR" size={15} />
                </button>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => setDrawerId(null)} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, background: 'var(--surface-2)', color: 'var(--t2)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-sm)', padding: 10, fontFamily: 'var(--f-ui)', fontWeight: 600, fontSize: 12, cursor: 'pointer' }}><Icon name="check" size={14} />Acknowledge</button>
                  <button onClick={() => setDrawerId(null)} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, background: 'var(--surface-2)', color: 'var(--t2)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-sm)', padding: 10, fontFamily: 'var(--f-ui)', fontWeight: 600, fontSize: 12, cursor: 'pointer' }}><Icon name="snooze" size={14} />Snooze</button>
                </div>
              </div>
            </>
          );
        })()}
      </Drawer>
    </div>
  );
}
