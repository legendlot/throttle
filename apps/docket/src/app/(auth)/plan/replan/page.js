'use client';
// Monthly re-plan (F9 R9b — spec docs/superpowers/specs/2026-11-11-docket-plan-layer.md §8.7; level F only).
// ONE read (getReplan&month=YYYY-MM, default next month IST): the month's milestones with readiness — agreed?
// owner? data source? actionable tasks in its first two weeks? — the risks raised as `risk` proposals, and the
// closing month's weekly scores. "Cutting the next month" is creating that month's tasks; this list shows
// what is still missing. Read-only.
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { CalendarClock, ChevronLeft, ChevronRight, Check, X, Lock, AlertTriangle } from 'lucide-react';
import { docketopsGet } from '../../../../lib/docketopsFetch.js';
import { Button, EmptyState, Pill } from '../../../../components/ui/index.js';
import { chipState, fmtPlanDate, fmtPlanStamp, planErrorText } from '../../../../lib/plan.js';
import { fmtPct } from '../../../../lib/review.js';
import { shortDay } from '../../../../lib/weeks.js';
import { isMonth, stepMonth, nextMonthIST, monthLabel, READINESS, readinessCells, isReady, sortReadiness, teamOptions, filterTeam, teamName, scoresTable, riskStatusLabel } from '../../../../lib/replan.js';

export default function ReplanPage() {
  return <Suspense fallback={<div className="pl"><Spinner /></div>}><ReplanInner /></Suspense>;
}

function ReplanInner() {
  const { session } = useAuth();
  const router = useRouter();
  const param = useSearchParams().get('month');
  const month = isMonth(param) ? param : nextMonthIST();
  const [data, setData] = useState(null);
  const [team, setTeam] = useState('');
  const [notReadyFirst, setNotReadyFirst] = useState(true);

  const ticket = useRef(0);
  const load = useCallback(async () => {
    if (!session) return;
    const mine = ++ticket.current;
    try { const d = await docketopsGet('getReplan', { month }, session); if (mine === ticket.current) setData(d); }
    catch (e) {
      if (mine !== ticket.current) return;
      const code = e?.message || '', t = planErrorText(e);
      setData({ error: code === 'forbidden' || e?.status === 403 ? 'forbidden' : (t && t !== code ? t : 'Couldn’t load the re-plan — try again.') });
    }
  }, [session, month]);
  useEffect(() => { setData(null); load(); }, [load]);
  useEffect(() => () => { ticket.current++; }, []);
  const go = (m) => router.replace('/plan/replan?month=' + m);

  const milestones = useMemo(() => (data?.milestones || []).filter(Boolean), [data]);
  const rows = useMemo(() => sortReadiness(filterTeam(milestones, team), notReadyFirst), [milestones, team, notReadyFirst]);
  const teams = useMemo(() => teamOptions(milestones), [milestones]);
  const scores = useMemo(() => scoresTable(data?.scores), [data]);

  if (!data) return <div className="pl"><Spinner /></div>;
  if (data.error === 'forbidden') return <div className="pl"><EmptyState icon={Lock} title="Founders only" body="The monthly re-plan is for the founders (plan admins)." /></div>;
  if (data.error) return <div className="pl"><EmptyState icon={CalendarClock} title="Couldn’t load the re-plan" body={data.error}
    action={<Button size="sm" onClick={() => { setData(null); load(); }}>Retry</Button>} /></div>;

  const c = data.counts || {};
  const risks = (data.risks || []).filter(Boolean);
  return (
    <div className="pl rp">
      <div className="pl-head">
        <div className="pl-head-tx">
          <h1 className="pl-title">Re-plan · {monthLabel(month)}</h1>
          <p className="pl-lede">{c.milestones ?? milestones.length} milestone{(c.milestones ?? milestones.length) === 1 ? '' : 's'} due · <b className="rp-ok">{c.ready ?? 0} ready</b> · <b className="rp-bad">{c.not_ready ?? 0} not ready</b></p>
        </div>
        <div className="rv-step" role="group" aria-label="Month">
          <Button size="sm" variant="neutral" icon={ChevronLeft} aria-label="Previous month" onClick={() => go(stepMonth(month, -1))} />
          <Button size="sm" variant={month === nextMonthIST() ? 'primary' : 'neutral'} onClick={() => go(nextMonthIST())}>Next month</Button>
          <Button size="sm" variant="neutral" icon={ChevronRight} aria-label="Following month" onClick={() => go(stepMonth(month, 1))} />
        </div>
      </div>

      <article className="rv-team">
        <div className="rp-bar">
          <h2 className="rv-team-h">Readiness</h2>
          <label className="pw-team"><span className="pl-lbl">Team</span>
            <select className="tk-fp-sel" value={team} onChange={e => setTeam(e.target.value)} aria-label="Team">
              {teams.map(o => <option key={o.value || 'all'} value={o.value}>{o.label}</option>)}
            </select></label>
          <label className="pl-check"><input type="checkbox" checked={notReadyFirst} onChange={e => setNotReadyFirst(e.target.checked)} /> Not ready first</label>
        </div>
        {rows.length === 0 ? <p className="rv-none">No milestones due in {monthLabel(month)}{team ? ' for this team' : ''}.</p> : (
          <div className="rp-scroll">
            <table className="rp-table">
              <thead><tr>
                <th>Milestone</th><th>Team</th><th>Owner</th><th>Due</th>
                {READINESS.map(r => <th key={r.key} className="rp-c">{r.label}</th>)}
                <th className="rp-c">Ready</th>
              </tr></thead>
              <tbody>
                {rows.map(m => {
                  const chip = chipState(m);
                  const ready = isReady(m);
                  return (
                    <tr key={m.id} className={ready ? '' : 'rp-notready'}>
                      <td className="rp-ms"><span className="pl-code">{m.code}</span> {m.title} <Pill tone="status" color={chip.color}>{chip.label}</Pill></td>
                      <td>{teamName(m)}</td>
                      <td>{m.owner_name || <span className="pl-muted">No owner</span>}</td>
                      <td className="rp-nowrap">{fmtPlanDate(m.effective_due)}</td>
                      {readinessCells(m).map(cell => (
                        <td key={cell.key} className="rp-c">
                          {cell.ok ? <Check size={14} className="rp-ok" aria-label="yes" /> : <X size={14} className="rp-bad" aria-label="no" />}
                          {cell.key === 'actionable' && <span className="rp-n">{cell.n}</span>}
                        </td>
                      ))}
                      <td className="rp-c">{ready ? <Check size={14} className="rp-ok" aria-label="ready" /> : <AlertTriangle size={14} className="rp-bad" aria-label="not ready" />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </article>

      <article className="rv-team">
        <h2 className="rv-team-h">Risks{risks.length > 0 && <span className="pl-count">{risks.length}</span>}</h2>
        {risks.length === 0 ? <p className="rv-none">No risks raised since the last re-plan.</p> : risks.map((r, i) => (
          <div key={r.id || i} className="rv-row rp-risk">
            <span className="rv-t"><b>{r.title}</b>{r.why && <span className="rv-note">{r.why}</span>}</span>
            <span className="rv-meta">{r.proposer_name || 'Someone'} · {fmtPlanStamp(r.created_at)}{r.suggested_theme_title ? ` · ${r.suggested_theme_title}` : ''}</span>
            {r.status && <Pill>{riskStatusLabel(r.status)}</Pill>}
          </div>
        ))}
      </article>

      <article className="rv-team">
        <h2 className="rv-team-h">Scores · {monthLabel(stepMonth(month, -1))}</h2>
        {scores.weeks.length === 0 ? <p className="rv-none">No closed weeks in {monthLabel(stepMonth(month, -1))}.</p> : (
          <div className="rp-scroll">
            <table className="rp-table">
              <thead><tr><th>Team</th>{scores.weeks.map(we => <th key={we} className="rp-c">{shortDay(we).replace(/^\w+ /, '')}</th>)}</tr></thead>
              <tbody>
                {scores.rows.map(r => (
                  <tr key={r.key} className={r.key === 'all' ? 'rp-total' : ''}>
                    <td>{r.name}</td>
                    {r.cells.map(c2 => <td key={c2.week_end} className="rp-c" title={`${c2.on_time} of ${c2.cohort}`}>{c2.cohort ? fmtPct(c2.pct) : '—'}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </article>
    </div>
  );
}
