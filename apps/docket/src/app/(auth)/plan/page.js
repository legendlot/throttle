'use client';
// Plan (F9 R1 — spec docs/superpowers/specs/2026-11-11-docket-plan-layer.md). The container only:
// the founders enter themes → milestones → results here, item by item; nothing is seeded.
//   · super admin (docket_plan_admin): the REGISTER — every theme, milestone and result.
//   · everyone else: MY MILESTONES — the milestones they own (under their theme's title) + results.
// What each row shows is decided by the worker's projection (levels F / O / T, in SQL); which buttons
// appear comes from lib/plan.js, the same matrix the database enforces.
import { useEffect, useMemo, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { Plus, Lock, ChevronUp, ChevronDown, Target, Flag } from 'lucide-react';
import { docketopsGet, docketopsPost } from '../../../lib/docketopsFetch.js';
import { Button, IconButton, Pill, EmptyState } from '../../../components/ui/index.js';
import { PlanPanel } from '../../../components/plan/PlanPanel.js';
import {
  buildPlanTree, myMilestoneGroups, chipState, effectiveDue, isRedated, fmtPlanDate, oneLine, moveSort,
  canAddResult, planErrorText,
} from '../../../lib/plan.js';

export default function PlanPage() {
  const { session } = useAuth();
  const { showToast } = useToast();
  const [data, setData] = useState(null);       // { items, can_admin, employee_id }
  const [employees, setEmployees] = useState([]);
  const [target, setTarget] = useState(null);   // { mode: 'new', kind, parent } | { mode: 'view', id }
  const [moving, setMoving] = useState(false);

  const load = useCallback(async () => {
    if (!session) return;
    try { setData(await docketopsGet('getPlan', {}, session)); }
    catch (e) { setData({ error: planErrorText(e) }); }
  }, [session, showToast]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!session) return;
    docketopsGet('getEmployees', {}, session).then(e => setEmployees(Array.isArray(e) ? e : [])).catch(() => {});
  }, [session]);

  const items = data?.items || [];
  const isSuper = !!data?.can_admin;
  const me = data?.employee_id || null;
  const tree = useMemo(() => buildPlanTree(items), [items]);
  const mine = useMemo(() => myMilestoneGroups(items, me), [items, me]);

  const open = useCallback((id) => setTarget({ mode: 'view', id }), []);
  const add = (kind, parent = null) => setTarget({ mode: 'new', kind, parent });
  const close = useCallback(() => setTarget(null), []);

  async function move(siblings, id, dir) {
    const ups = moveSort(siblings, id, dir);
    if (!ups.length) return;
    setMoving(true);
    try {
      for (const u of ups) await docketopsPost('updatePlanItem', { id: u.id, patch: { sort: u.sort } }, session);
      await load();
    } catch (e) { showToast(planErrorText(e), 'error'); await load(); }
    finally { setMoving(false); }
  }

  if (!data) return <div className="pl"><Spinner /></div>;
  // A failed load is an error, never the empty register (a super admin must not see "no milestones").
  if (data.error) return <div className="pl"><EmptyState icon={Target} title="Couldn’t load the plan" body={data.error}
    action={<Button size="sm" onClick={() => { setData(null); load(); }}>Retry</Button>} /></div>;

  const rowProps = { onOpen: open, isSuper, me, moving };

  return (
    <div className="pl">
      <div className="pl-head">
        <div className="pl-head-tx">
          <h1 className="pl-title">{isSuper ? 'Plan register' : 'My milestones'}</h1>
          <p className="pl-lede">{isSuper
            ? 'Themes → milestones → results. Click any row to edit it, agree it, re-date it or close it.'
            : 'The milestones you own, under their theme, with the results you’ve committed to.'}</p>
        </div>
        {isSuper && <Button variant="primary" icon={Plus} onClick={() => add('theme')}>Theme</Button>}
      </div>

      {isSuper ? (
        tree.themes.length === 0
          ? <EmptyState icon={Target} title="No themes yet" body="Start the register with the first theme."
              action={<Button variant="primary" icon={Plus} onClick={() => add('theme')}>Theme</Button>} />
          : tree.themes.map(t => (
            <section key={t.id} className={'pl-theme' + (t.state === 'dropped' ? ' pl-dim' : '')}>
              <PlanRow item={t} {...rowProps} siblings={tree.themes} onMove={move}
                extra={t.state === 'agreed' && <Button size="sm" variant="ghost" icon={Plus} onClick={() => add('milestone', t)}>Milestone</Button>} />
              {t.target_text && <div className="pl-target"><Flag size={12} aria-hidden /> {t.target_text}</div>}
              <MilestoneList milestones={t.children} rowProps={rowProps} onMove={move} onAdd={add} />
              {t.children.length === 0 && <div className="pl-none">No milestones yet.</div>}
            </section>
          ))
      ) : (
        mine.groups.length === 0 && mine.otherResults.length === 0
          ? <EmptyState icon={Target} title="You don’t own any milestones yet"
              body="When the founders give you a milestone, it appears here with its results." />
          : <>
            {mine.groups.map(g => (
              <section key={g.theme.id} className="pl-theme">
                <div className="pl-theme-t"><span className="pl-code">{g.theme.code}</span> {g.theme.title}</div>
                <MilestoneList milestones={g.milestones} rowProps={rowProps} onMove={move} onAdd={add} />
              </section>
            ))}
            {mine.otherResults.length > 0 && (
              <section className="pl-theme">
                <div className="pl-theme-t">Results I own on other milestones</div>
                {mine.otherResults.map(r => <PlanRow key={r.id} item={r} depth={1} {...rowProps} />)}
              </section>
            )}
          </>
      )}

      {target && (
        <PlanPanel target={target} isSuper={isSuper} employeeId={me} byId={tree.byId} employees={employees}
          session={session} onClose={close} onChanged={load} onOpen={open} />
      )}
    </div>
  );
}

function MilestoneList({ milestones, rowProps, onMove, onAdd }) {
  return milestones.map(m => (
    <div key={m.id} className={'pl-ms' + (m.state === 'dropped' ? ' pl-dim' : '')}>
      <PlanRow item={m} depth={1} {...rowProps} siblings={milestones} onMove={onMove}
        extra={canAddResult(m, { isSuper: rowProps.isSuper, employeeId: rowProps.me })
          && <Button size="sm" variant="ghost" icon={Plus} onClick={() => onAdd('result', m)}>Result</Button>} />
      {m.children.map(r => <PlanRow key={r.id} item={r} depth={2} {...rowProps} siblings={m.children} onMove={onMove} />)}
    </div>
  ));
}

function PlanRow({ item, depth = 0, onOpen, isSuper, siblings, onMove, moving, extra }) {
  const chip = chipState(item);
  const due = effectiveDue(item);
  const sub = item.kind !== 'theme' ? oneLine(item.done_when) : '';
  const go = () => onOpen(item.id);
  return (
    <div className={`pl-row pl-${item.kind}`} style={{ paddingLeft: 10 + depth * 22 }} role="button" tabIndex={0}
      onClick={go} onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) { e.preventDefault(); go(); } }}>
      <div className="pl-row-main">
        <div className="pl-row-l1">
          <span className="pl-code">{item.code}</span>
          <span className="pl-row-t">{item.title}</span>
          {item.restricted && <Lock size={12} className="pl-lock" aria-label="Restricted" />}
        </div>
        {sub && <div className="pl-row-sub">{sub}</div>}
      </div>
      <span className="pl-owner">{item.owner_name || (item.kind === 'theme' && item.level === 'F' ? 'Both founders' : '')}</span>
      {item.kind !== 'theme' && (
        <span className="pl-due">{due ? fmtPlanDate(due) : <span className="pl-muted">No date</span>}
          {isRedated(item) && <Pill className="pl-redated">Re-dated</Pill>}</span>
      )}
      <Pill tone="status" color={chip.color}>{chip.label}</Pill>
      <span className="pl-row-acts" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        {extra}
        {isSuper && siblings && siblings.length > 1 && <>
          <IconButton icon={ChevronUp} size="sm" label="Move up" disabled={moving} onClick={() => onMove(siblings, item.id, -1)} />
          <IconButton icon={ChevronDown} size="sm" label="Move down" disabled={moving} onClick={() => onMove(siblings, item.id, 1)} />
        </>}
      </span>
    </div>
  );
}
