'use client';
// The review pack body (F9 R6a — spec §8.1). Renders one getReviewPack payload, live or a stored snapshot
// (the same components, so a held Friday view reads exactly like the page did). Read-only: every number and
// row comes from the worker, already cut to what the viewer may see. §8.1 section 5 (hand-offs) is not in
// this release, so the numbering skips it.
import Link from 'next/link';
import { AlertTriangle, Target, Inbox } from 'lucide-react';
import { Pill } from '../../../components/ui/index.js';
import { fmtPlanDate, fmtPlanStamp } from '../../../lib/plan.js';
import { STATUS_MAP } from '../../../lib/tasks.js';
import { shortDay } from '../../../lib/weeks.js';
import { fmtPct, missLabel, sourceNote, movedText, touchedText, tsDay, barPct, seenText, updateText } from '../../../lib/review.js';

const WARN_LABEL = { no_tasks: 'no actionable tasks', no_data_source: 'no data source', not_agreed: 'not agreed' };
const taskHref = (id) => '/tasks?task=' + id;

export function ReviewPack({ pack }) {
  const final = !!pack?.week?.final;
  const teams = Array.isArray(pack?.teams) ? pack.teams : [];
  return (
    <div className="rv-body">
      {pack.can_admin && Number(pack.hidden_tasks) > 0 && <p className="rv-hidden">+{pack.hidden_tasks} in spaces you’re not in</p>}
      {teams.length === 0 && <div className="pw-ok">No committed tasks this week.</div>}
      {teams.filter(Boolean).map(t => <TeamReview key={t.department_id || 'none'} team={t} final={final} />)}
      {pack.proposals && <Proposals proposals={pack.proposals} />}
    </div>
  );
}

function Sec({ title, count, children }) {
  return (
    <section className="rv-sec">
      <h3 className="rv-sec-h">{title}{count > 0 && <span className="pl-count">{count}</span>}</h3>
      {children}
    </section>
  );
}

function Stat({ label, value, tone }) {
  return <div className={'rv-stat' + (tone ? ' rv-' + tone : '')}><span className="rv-stat-v">{value}</span><span className="rv-stat-l">{label}</span></div>;
}

function TeamReview({ team, final }) {
  const tw = team.this_week || {}, lw = team.last_week || {};
  const ms = team.milestones || {}, st = team.staleness || {}, nx = team.next_two_weeks || {}, up = team.unplanned || {};
  return (
    <article className="rv-team">
      <h2 className="rv-team-h">{team.team_name || 'No team'}</h2>

      <Sec title={`This week · ${final ? 'final' : 'provisional'}`}>
        {!tw.cohort ? <p className="rv-none">No committed tasks this week</p> : (
          <div className="rv-stats">
            <Stat label="committed" value={tw.cohort} />
            <Stat label="on time" value={tw.on_time} tone="ok" />
            <Stat label={final ? 'missed' : 'missed so far'} value={tw.miss} tone={tw.miss > 0 ? 'bad' : null} />
            {!final && <Stat label="still due" value={tw.due} />}
            <Stat label={final ? 'on time' : 'on time · provisional'} value={fmtPct(tw.pct)} tone="big" />
          </div>
        )}
      </Sec>

      <Sec title={`Last week · ${lw.final ? 'final' : 'provisional'}`}>
        <div className="rv-last">
          {lw.cohort ? (
            <div className="rv-stats">
              <Stat label="committed" value={lw.cohort} />
              <Stat label="on time" value={lw.on_time} tone="ok" />
              <Stat label="missed" value={lw.miss} tone={lw.miss > 0 ? 'bad' : null} />
              <Stat label={lw.week_end ? 'week ending ' + shortDay(lw.week_end) : 'on time'} value={fmtPct(lw.pct)} tone="big" />
            </div>
          ) : <p className="rv-none">No committed tasks last week</p>}
          {(team.trend || []).length > 0 && (
            <div className="rv-trend" aria-label="Last four closed weeks, on time">
              {team.trend.filter(Boolean).map(w => (
                <div key={w.week_end} className="rv-tbar" title={`Week ending ${shortDay(w.week_end)} · ${fmtPct(w.pct)} of ${w.cohort}`}>
                  <span className="rv-tbar-v">{fmtPct(w.pct)}</span>
                  <span className="rv-tbar-track"><span className="rv-tbar-fill" style={{ height: barPct(w.pct) + '%' }} /></span>
                  <span className="rv-tbar-l">{shortDay(w.week_end).replace(/^\w+ /, '')}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </Sec>

      <Sec title="Slipped" count={(team.slipped || []).length}>
        {(team.slipped || []).length === 0 ? <p className="rv-none">Nothing slipped</p> : team.slipped.filter(Boolean).map(s => (
          <div key={s.task_id} className="rv-row rv-slip">
            <div className="rv-row-l1">
              <Link className="rv-task" href={taskHref(s.task_id)}><span className="pl-code">{s.task_no}</span> {s.title}</Link>
              {s.miss_reason && <Pill tone="status" color={s.miss_reason === 'abandoned' ? 'var(--st-abandon)' : 'var(--overdue)'}>{missLabel(s.miss_reason)}</Pill>}
            </div>
            <div className="rv-row-sub">
              {s.owner_name || 'Unassigned'} · {tsDay(s.committed_deadline)} → {tsDay(s.effective_deadline)}
              {movedText(s.times_moved) && <> · <b>{movedText(s.times_moved)}</b></>}
            </div>
            {(s.revisions || []).length > 0 && (
              <ul className="rv-revs">
                {s.revisions.map((v, i) => (
                  <li key={i}>
                    <span className="rv-rev-d">{tsDay(v.old)} → {tsDay(v.new)}</span>
                    <span className="rv-rev-r">{v.reason || 'no reason given'}</span>
                    {sourceNote(v.source) && <span className="rv-src">{sourceNote(v.source)}</span>}
                    <span className="rv-rev-at">{fmtPlanStamp(v.at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </Sec>

      <Sec title="Milestones" count={(ms.warnings || []).length}>
        {(ms.due || []).length === 0 && (ms.redated || []).length === 0 && (ms.warnings || []).length === 0
          ? <p className="rv-none">No milestones due or re-dated this week</p> : <>
          {(ms.warnings || []).map((w, i) => (
            <div key={w.kind + w.id + i} className="rv-row rv-warnrow">
              <AlertTriangle size={13} className="pl-warn" aria-hidden />
              <span className="rv-t"><span className="pl-code">{w.code}</span> {w.title}</span>
              <span className="pl-nosrc">{WARN_LABEL[w.kind] || w.kind}</span>
            </div>
          ))}
          {(ms.due || []).map(m => (
            <div key={m.id} className="rv-row rv-ms">
              <Target size={12} aria-hidden className="pw-ic" />
              <span className="rv-t"><span className="pl-code">{m.code}</span> {m.title}</span>
              <span className="rv-meta">{m.owner_name || 'No owner'} · due {fmtPlanDate(m.due)}</span>
              <Pill tone="status" color={m.state === 'done' ? 'var(--st-done)' : 'var(--st-blocked)'}>{m.state === 'done' ? 'done' : 'not done'}</Pill>
            </div>
          ))}
          {(ms.redated || []).map(m => (
            <div key={m.id + m.at} className="rv-row rv-ms">
              <Target size={12} aria-hidden className="pw-ic" />
              <span className="rv-t"><span className="pl-code">{m.code}</span> {m.title}</span>
              <span className="rv-meta">re-dated {fmtPlanDate(m.old)} → {fmtPlanDate(m.new)}{m.reason ? ' · ' + m.reason : ''}</span>
            </div>
          ))}
        </>}
      </Sec>

      <Sec title="Staleness">
        {/* null for any week but the current one — the banner is about yesterday. */}
        {st.quiet_last_working_day === true && (
          <div className="rv-quiet"><AlertTriangle size={13} aria-hidden /> Quiet on {shortDay(st.last_working_day) || 'the last working day'} — no update on any open task</div>
        )}
        {(st.people || []).length === 0 ? <p className="rv-none">No one with open committed tasks</p> : (
          <div className="rv-people">
            {st.people.filter(Boolean).map(p => (
              <div key={p.employee_id} className="rv-row rv-person">
                <span className="rv-pname">{p.name}</span>
                {seenText(p) && <span className="rv-meta">seen {seenText(p)}</span>}
                <span className="rv-meta">updated {updateText(p)}</span>
                <span className="rv-meta">touched {touchedText(p)}</span>
                {p.by_source?.connector > 0 && <span className="rv-src">{p.by_source.connector} via connector</span>}
              </div>
            ))}
          </div>
        )}
      </Sec>

      <Sec title="Next two weeks">
        {(nx.tasks_by_person || []).length === 0 && (nx.milestones || []).length === 0 ? <p className="rv-none">Nothing due in the next two weeks</p> : <>
          {(nx.milestones || []).map(m => (
            <div key={m.id} className="rv-row rv-ms">
              <Target size={12} aria-hidden className="pw-ic" />
              <span className="rv-t"><span className="pl-code">{m.code}</span> {m.title}</span>
              <span className="rv-meta">{m.owner_name || 'No owner'} · due {fmtPlanDate(m.due)}{m.state === 'proposed' ? ' · not agreed' : ''}</span>
            </div>
          ))}
          {(nx.tasks_by_person || []).filter(Boolean).map(g => (
            <div key={g.owner_employee_id || 'none'} className="rv-group">
              <div className="rv-group-h">{g.owner_name || 'Unassigned'}<span className="rv-meta"> · {(g.tasks || []).length}</span></div>
              {(g.tasks || []).map(t => (
                <Link key={t.task_id} href={taskHref(t.task_id)} className="rv-row rv-ntask">
                  <span className="pw-st" style={{ background: STATUS_MAP[t.status]?.color }} aria-label={STATUS_MAP[t.status]?.label} />
                  <span className="rv-t"><span className="pl-code">{t.task_no}</span> {t.title}</span>
                  <span className="rv-meta">{tsDay(t.effective_deadline)}</span>
                </Link>
              ))}
            </div>
          ))}
        </>}
      </Sec>

      <Sec title="Unplanned">
        {!up.committed ? <p className="rv-none">No committed tasks</p>
          : <p className="rv-line"><b>{up.unplanned}</b> of {up.committed} committed tasks have no plan link ({fmtPct(up.pct)})</p>}
      </Sec>
    </article>
  );
}

function Proposals({ proposals }) {
  const list = proposals?.submitted_this_week || [];
  return (
    <article className="rv-team">
      <h2 className="rv-team-h"><Inbox size={15} aria-hidden /> Proposals</h2>
      <p className="rv-line">{Number(proposals?.waiting) > 0 ? <><b>{proposals.waiting}</b> waiting for the founders</> : 'Nothing waiting for the founders'}</p>
      {list.length === 0 ? <p className="rv-none">None submitted this week</p> : list.map(p => (
        <div key={p.id} className="rv-row rv-ms">
          <span className="rv-t">{p.title}</span>
          <span className="rv-meta">{p.proposer_name || 'Someone'} · {fmtPlanStamp(p.created_at)}{p.kind_hint ? ' · ' + p.kind_hint : ''}</span>
          <Pill>{p.status}</Pill>
        </div>
      ))}
    </article>
  );
}
