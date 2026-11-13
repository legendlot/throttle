'use client';
// Three weeks (F9 R4 — spec docs/superpowers/specs/2026-11-11-docket-plan-layer.md §7.2). A ROLLING window:
// Overdue · this week · next week · the week after (week-ending dates from §6, IST, the org's week end).
// Rows by team (default), person or theme; each cell lists the milestones / results and tasks due that
// week. Four warnings, each naming who resolves it. Everything comes from ONE read (getPlanWeeks) through
// the worker's gates — plan rows via the projection (F / O / T), tasks via the task-visibility gate — so a
// cell or a warning never shows something the viewer couldn't open elsewhere. The only write is the
// theme-only fix: the existing updateTask plan_item_id path.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { CalendarRange, Target, AlertTriangle, Clock, Link2, Hourglass, ListX, ChevronDown } from 'lucide-react';
import { docketopsGet, docketopsPost } from '../../../../lib/docketopsFetch.js';
import { Button, EmptyState, SegmentedTabs, Menu, MenuItem, MenuLabel } from '../../../../components/ui/index.js';
import { PlanChip } from '../../../../components/plan/PlanPicker.js';
import { fmtShortDate } from '../../../../components/primitives.js';
import { fmtPlanDate, planErrorText } from '../../../../lib/plan.js';
import { STATUS_MAP, effectiveDeadline } from '../../../../lib/tasks.js';

const ROW_TABS = [{ value: 'team', label: 'Team' }, { value: 'person', label: 'Person' }, { value: 'theme', label: 'Theme' }];
const WARN = {
  no_actionable: { icon: ListX, title: 'No actionable tasks', hint: 'Agreed, due in the window, and no open task with an owner and a date.' },
  not_agreed: { icon: Hourglass, title: 'Not agreed yet', hint: 'Proposed milestones due in the window.' },
  theme_only: { icon: Link2, title: 'Linked to a theme only', hint: 'Open tasks on a theme that now has agreed milestones.' },
  stale: { icon: Clock, title: 'Stale', hint: 'No update or comment for 3+ working days.' },
};
const WARN_ORDER = ['no_actionable', 'not_agreed', 'theme_only', 'stale'];

export default function PlanWeeksPage() {
  const { session } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const [rowsBy, setRowsBy] = useState('team');
  const [team, setTeam] = useState('');          // '' = the default scope (plan admin: all; else own team)
  const [data, setData] = useState(null);
  const [linking, setLinking] = useState(null);  // task id being re-linked

  // Only the newest request may land: switching Rows / Team fast must never leave an older grouping on
  // screen under the newer control (or its error over a good answer). A stale ticket is dropped.
  const ticket = useRef(0);
  const load = useCallback(async () => {
    if (!session) return;
    const mine = ++ticket.current;
    try {
      const d = await docketopsGet('getPlanWeeks', { rows: rowsBy, team }, session);
      if (mine === ticket.current) setData(d);
    } catch (e) { if (mine === ticket.current) setData({ error: planErrorText(e) }); }
  }, [session, rowsBy, team]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => () => { ticket.current++; }, []);   // unmount: drop whatever is in flight

  const openTask = (id) => router.push('/tasks?task=' + id);
  async function linkTo(taskId, milestoneId) {
    setLinking(taskId);
    try {
      await docketopsPost('updateTask', { id: taskId, plan_item_id: milestoneId }, session);
      showToast('Linked to the milestone', 'success');
      await load();
    } catch (e) { showToast(planErrorText(e), 'error'); }
    finally { setLinking(null); }
  }

  if (!data) return <div className="pl"><Spinner /></div>;
  if (data.error) return <div className="pl"><EmptyState icon={CalendarRange} title="Couldn’t load the three weeks" body={data.error}
    action={<Button size="sm" onClick={() => { setData(null); load(); }}>Retry</Button>} /></div>;

  const teamValue = data.all_teams ? 'all' : (data.team_id || 'all');
  const teamName = data.team_id ? ((data.departments || []).find(d => d.id === data.team_id)?.name || 'your team') : 'every team';
  const empty = data.rows.length === 0 && data.warnings.length === 0;

  return (
    <div className="pl pw">
      <div className="pl-head">
        <div className="pl-head-tx">
          <h1 className="pl-title">Three weeks</h1>
          <p className="pl-lede">What’s overdue, due this week and the next two — milestones and tasks — and what needs someone’s hand.</p>
        </div>
        <div className="pl-head-acts">
          <Button variant="neutral" icon={Target} onClick={() => router.push('/plan')}>Plan</Button>
        </div>
      </div>

      <div className="pw-bar">
        <SegmentedTabs label="Rows" tabs={ROW_TABS} value={rowsBy} onChange={setRowsBy} />
        <label className="pw-team">
          <span className="pl-lbl">Team</span>
          <select className="tk-fp-sel" value={teamValue} onChange={e => setTeam(e.target.value)} aria-label="Team">
            <option value="all">All teams</option>
            {(data.departments || []).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
      </div>

      {empty ? (
        <EmptyState icon={CalendarRange} title="Nothing due in the next three weeks"
          body={`Milestones, results and tasks due this week or the next two — and anything overdue — for ${teamName} show up here, with a note when one needs attention.`}
          action={data.team_id ? <Button variant="neutral" size="sm" onClick={() => setTeam('all')}>All teams</Button> : null} />
      ) : <>
        <Warnings data={data} onOpenTask={openTask} onLink={linkTo} linking={linking} />
        <div className="pw-scroll">
          <div className="pw-grid" role="table" aria-label="Three weeks">
            <div className="pw-row pw-hrow" role="row">
              <div className="pw-rl" role="columnheader">{ROW_TABS.find(t => t.value === rowsBy)?.label}</div>
              {data.columns.map(c => (
                <div key={c.key} className={'pw-ch' + (c.key === 'overdue' ? ' pw-over' : '')} role="columnheader">
                  <span className="pw-ch-t">{c.which === 'this' ? 'This week' : c.which === 'next' ? 'Next week' : c.which === 'after' ? 'Week after' : 'Overdue'}</span>
                  {c.key !== 'overdue' && <span className="pw-ch-s">{c.label}</span>}
                </div>
              ))}
            </div>
            {data.rows.map(r => (
              <div key={r.key} className="pw-row" role="row">
                <div className="pw-rl" role="rowheader">{r.label}</div>
                {data.columns.map(c => <Cell key={c.key} cell={r.cells[c.key]} over={c.key === 'overdue'} onOpenTask={openTask} />)}
              </div>
            ))}
          </div>
        </div>
      </>}
    </div>
  );
}

function Cell({ cell, over, onOpenTask }) {
  const n = (cell?.items.length || 0) + (cell?.tasks.length || 0);
  return (
    <div className={'pw-cell' + (over ? ' pw-over' : '')} role="cell">
      {n === 0 && <span className="pw-none">—</span>}
      {cell?.items.map(i => (
        <div key={i.id} className={'pw-item' + (i.state === 'proposed' ? ' pw-prop' : '')} title={i.title}>
          <Target size={12} aria-hidden className="pw-ic" />
          <span className="pl-code">{i.code}</span>
          <span className="pw-t">{i.title}</span>
          {i.warnings.length > 0 && <AlertTriangle size={12} className="pl-warn" aria-label={i.warnings.map(w => WARN[w]?.title).join(', ')} />}
          <span className="pw-due">{fmtPlanDate(i.due)}</span>
          {/* Level F only (§5.3): its owned, dated, open tasks include some in spaces the viewer isn't in. */}
          {i.hidden_actionable > 0 && <span className="pw-meta">+{i.hidden_actionable} in spaces you’re not in</span>}
        </div>
      ))}
      {cell?.tasks.map(t => (
        <button key={t.id} type="button" className={'pw-task dk-press' + (t.status === 'done' ? ' pw-done' : '')} onClick={() => onOpenTask(t.id)}
          title={`${t.task_no || ''} ${t.title}`.trim()}>
          <span className="pw-st" style={{ background: STATUS_MAP[t.status]?.color }} aria-label={STATUS_MAP[t.status]?.label} />
          <span className="pw-t">{t.title}</span>
          {t.warnings.includes('stale') && <Clock size={12} className="pl-warn" aria-label="Stale" />}
          {t.warnings.includes('theme_only') && <Link2 size={12} className="pl-warn" aria-label="Linked to a theme only" />}
          <span className="pw-meta">{t.owner_name || 'Unassigned'} · {fmtShortDate(effectiveDeadline(t))}</span>
        </button>
      ))}
    </div>
  );
}

function Warnings({ data, onOpenTask, onLink, linking }) {
  const kinds = WARN_ORDER.filter(k => data.counts[k] > 0);
  if (!kinds.length) return <div className="pw-ok">No warnings — every agreed item due in the window has an owned, dated task, and nothing’s gone quiet.</div>;
  return (
    <div className="pw-warns">
      {kinds.map(k => {
        const W = WARN[k];
        const list = data.warnings.filter(w => w.kind === k);
        return (
          <section key={k} className="pw-wsec">
            <div className="pw-wh"><W.icon size={13} aria-hidden className="pl-warn" /> {W.title}<span className="pl-count">{list.length}</span>
              <span className="pw-wh-hint">{W.hint}</span></div>
            {list.map((w, n) => (
              <div key={(w.item?.id || w.task?.id) + ':' + n} className="pw-w">
                {w.item
                  ? <span className="pw-w-t"><span className="pl-code">{w.item.code}</span> {w.item.title}<span className="pw-w-d"> · due {fmtPlanDate(w.item.due)}</span></span>
                  : <button type="button" className="pw-w-t pw-link" onClick={() => onOpenTask(w.task.id)}>
                      <span className="pl-code">{w.task.task_no}</span> {w.task.title}
                      {w.theme && <span className="pw-w-d"> · on {w.theme.title}</span>}
                    </button>}
                {w.task?.plan && !w.theme && <PlanChip plan={w.task.plan} />}
                <span className="pw-res">For {w.resolver.kind === 'founders' ? 'the founders' : (w.resolver.name || 'no owner yet')}</span>
                {k === 'theme_only' && w.task.can_edit && <LinkMenu warning={w} onLink={onLink} busy={linking === w.task.id} />}
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}

// One-click fix for a theme-only link: the theme's agreed milestones the viewer can see (the worker sent
// only those) → updateTask plan_item_id. Shown only when the worker's canEditTask says the viewer may edit
// the task (`can_edit`); updateTask still enforces it.
function LinkMenu({ warning, onLink, busy }) {
  const btn = useRef(null);
  const [open, setOpen] = useState(false);
  return <>
    <Button ref={btn} size="sm" variant="ghost" icon={Link2} iconRight={ChevronDown} loading={busy} onClick={() => setOpen(o => !o)}
      aria-haspopup="menu">Link to a milestone</Button>
    <Menu anchorRef={btn} open={open} onClose={() => setOpen(false)} align="right" width={280} label="Link to a milestone">
      <MenuLabel>{warning.theme.title}</MenuLabel>
      {warning.milestones.map(m => (
        <MenuItem key={m.id} icon={Target} onClick={() => onLink(warning.task.id, m.id)}>
          {[m.code, m.title].filter(Boolean).join(' · ')}{m.due ? ` — ${fmtPlanDate(m.due)}` : ''}
        </MenuItem>
      ))}
    </Menu>
  </>;
}

