'use client';
// Plan (F9 R1 — spec docs/superpowers/specs/2026-11-11-docket-plan-layer.md). The container only:
// the founders enter themes → milestones → results here, item by item; nothing is seeded.
//   · super admin (docket_plan_admin): the REGISTER — every theme, milestone and result.
//   · everyone else: MY MILESTONES — the milestones they own (under their theme's title) + results.
// What each row shows is decided by the worker's projection (levels F / O / T, in SQL); which buttons
// appear comes from lib/plan.js, the same matrix the database enforces.
// R3: ⚠ No data source on live milestones/results, split items greyed with "Split → M47, M48", and
// proposals — a Propose button for everyone, "My proposals", and the founders' Proposed queue.
import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { Plus, Lock, ChevronUp, ChevronDown, Target, Flag, Lightbulb, CalendarRange, Check, CheckCircle2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { docketopsGet, docketopsPost } from '../../../lib/docketopsFetch.js';
import { Button, IconButton, Pill, EmptyState } from '../../../components/ui/index.js';
import { PlanPanel } from '../../../components/plan/PlanPanel.js';
import { NoSourceChip, ReadingChip } from '../../../components/plan/MeasureFields.js';
import { reachedEvidence, fmtMeasureValue, metricUnit } from '../../../lib/measure.js';
import { ProposalSections } from '../../../components/plan/Proposals.js';
import {
  buildPlanTree, myMilestoneGroups, chipState, effectiveDue, isRedated, fmtPlanDate, oneLine, moveSort,
  canAddResult, planErrorText, noDataSource, splitIntoCodes, isReviewRegister,
} from '../../../lib/plan.js';

export default function PlanPage() {
  const { session } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const [data, setData] = useState(null);       // { items, can_admin, employee_id }
  const [employees, setEmployees] = useState([]);
  const [target, setTarget] = useState(null);   // { mode: 'new', kind, parent } | { mode: 'view', id } | { mode: 'propose' } | { mode: 'proposal', proposal }
  const [moving, setMoving] = useState(false);
  const [proposals, setProposals] = useState([]);
  const [reached, setReached] = useState([]);   // R9b (level F): agreed items whose latest reading reached the target

  const loadProposals = useCallback(async () => {
    if (!session) return;
    try { const r = await docketopsGet('getProposals', {}, session); setProposals(r?.proposals || []); }
    catch { /* the register still works; the sections just stay empty */ }
  }, [session]);
  const load = useCallback(async () => {
    if (!session) return;
    loadProposals();
    try { setData(await docketopsGet('getPlan', {}, session)); }
    catch (e) { setData({ error: planErrorText(e) }); }
  }, [session, showToast, loadProposals]);
  useEffect(() => { load(); }, [load]);
  const canAdmin = !!data?.can_admin;
  // The reached-targets queue: read once canAdmin is known, and again after a plan write from the panel
  // (a reading, Mark done, a re-date can change it) — not on every `data` change (each reorder re-read the
  // plan and fired this too). Newest answer only.
  const reachedTicket = useRef(0);
  const loadReached = useCallback(async () => {
    const mine = ++reachedTicket.current;
    if (!session || !canAdmin) { setReached([]); return; }
    try { const r = await docketopsGet('getReachedTargets', {}, session); if (mine === reachedTicket.current) setReached(Array.isArray(r?.items) ? r.items : []); }
    catch { if (mine === reachedTicket.current) setReached([]); }   // the register still works without the queue
  }, [session, canAdmin]);
  useEffect(() => { loadReached(); }, [loadReached]);
  const onPlanChanged = useCallback(() => { load(); loadReached(); }, [load, loadReached]);
  useEffect(() => {
    if (!session) return;
    docketopsGet('getEmployees', {}, session).then(e => setEmployees(Array.isArray(e) ? e : [])).catch(() => {});
  }, [session]);

  const items = data?.items || [];
  const isSuper = !!data?.can_admin;
  // R6c: a Founders' Associate (level R) reads the whole register — read-only, never targets / restricted.
  const isRegister = isSuper || isReviewRegister(items, isSuper);
  const me = data?.employee_id || null;
  const tree = useMemo(() => buildPlanTree(items), [items]);
  const mine = useMemo(() => myMilestoneGroups(items, me), [items, me]);
  const metrics = data?.metrics || [];
  const themes = useMemo(() => tree.themes.filter(t => t.state === 'agreed'), [tree]);

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

  const rowProps = { onOpen: open, isSuper, me, moving, metrics, items };
  const propose = () => setTarget({ mode: 'propose' });
  const openProposal = (p) => setTarget({ mode: 'proposal', proposal: p });

  return (
    <div className="pl">
      <div className="pl-head">
        <div className="pl-head-tx">
          <h1 className="pl-title">{isRegister ? 'Plan register' : 'My milestones'}</h1>
          <p className="pl-lede">{!isSuper && isRegister
            ? 'Every theme, milestone and result, read-only. Click a row for its details.'
            : isSuper
            ? 'Themes → milestones → results. Click any row to edit it, agree it, re-date it or close it.'
            : 'The milestones you own, under their theme, with the results you’ve committed to.'}</p>
        </div>
        <div className="pl-head-acts">
          <Button variant="neutral" icon={CalendarRange} onClick={() => router.push('/plan/weeks')}>Three weeks</Button>
          <Button variant={isSuper ? 'neutral' : 'primary'} icon={Lightbulb} onClick={propose}>Propose</Button>
          {isSuper && <Button variant="primary" icon={Plus} onClick={() => add('theme')}>Theme</Button>}
        </div>
      </div>

      {isSuper && reached.length > 0 && (
        <section className="pl-theme pl-reachq" aria-label="Targets reached">
          <div className="pl-theme-t"><CheckCircle2 size={13} aria-hidden /> Target reached — confirm done<span className="pl-count">{reached.length}</span></div>
          {reached.map(r => (
            <div key={r.id} className="pl-row pl-prop">
              <div className="pl-row-main">
                <div className="pl-row-l1"><span className="pl-code">{r.code}</span><span className="pl-row-t">{r.title}</span></div>
                <div className="pl-row-sub">{fmtMeasureValue(r.reading, metricUnit(metrics, { label: r.metric_label }))} {r.metric_label ? `· ${r.metric_label} ` : ''}· target {r.target || '—'}</div>
              </div>
              <span className="pl-owner">{r.owner_name || ''}</span>
              <span className="pl-due">{r.effective_due ? fmtPlanDate(r.effective_due) : ''}</span>
              <span className="pl-row-acts">
                <Button size="sm" variant="primary" icon={Check} onClick={() => setTarget({ mode: 'view', id: r.id, op: 'done', evidence: reachedEvidence(r, metrics) })}>Mark done</Button>
              </span>
            </div>
          ))}
        </section>
      )}

      <ProposalSections proposals={proposals} isSuper={isSuper} onOpen={openProposal} />

      {isRegister ? (
        tree.themes.length === 0
          ? <EmptyState icon={Target} title="No themes yet" body="Start the register with the first theme."
              action={<Button variant="primary" icon={Plus} onClick={() => add('theme')}>Theme</Button>} />
          : tree.themes.map(t => (
            <section key={t.id} className={'pl-theme' + (t.state === 'dropped' ? ' pl-dim' : '')}>
              <PlanRow item={t} {...rowProps} siblings={tree.themes} onMove={move}
                extra={isSuper && t.state === 'agreed' && <Button size="sm" variant="ghost" icon={Plus} onClick={() => add('milestone', t)}>Milestone</Button>} />
              {t.target_text && <div className="pl-target"><Flag size={12} aria-hidden /> {t.target_text}</div>}
              <MilestoneList milestones={t.children} rowProps={rowProps} onMove={move} onAdd={add} />
              {t.children.length === 0 && <div className="pl-none">No milestones yet.</div>}
            </section>
          ))
      ) : (
        mine.groups.length === 0 && mine.otherResults.length === 0
          ? <EmptyState icon={Target} title="You don’t own any milestones yet"
              body="When the founders give you a milestone, it appears here with its results. Something missing from the plan? Propose it."
              action={<Button variant="primary" icon={Lightbulb} onClick={propose}>Propose</Button>} />
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
          metrics={metrics} themes={themes} session={session} onClose={close} onChanged={onPlanChanged} onOpen={open} />
      )}
    </div>
  );
}

function MilestoneList({ milestones, rowProps, onMove, onAdd }) {
  return milestones.map(m => (
    <div key={m.id} className={'pl-ms' + (m.state === 'dropped' || m.state === 'split' ? ' pl-dim' : '')}>
      <PlanRow item={m} depth={1} {...rowProps} siblings={milestones} onMove={onMove}
        extra={canAddResult(m, { isSuper: rowProps.isSuper, employeeId: rowProps.me })
          && <Button size="sm" variant="ghost" icon={Plus} onClick={() => onAdd('result', m)}>Result</Button>} />
      {m.children.map(r => <PlanRow key={r.id} item={r} depth={2} {...rowProps} siblings={m.children} onMove={onMove} />)}
    </div>
  ));
}

function PlanRow({ item, depth = 0, onOpen, isSuper, siblings, onMove, moving, extra, metrics, items }) {
  const chip = chipState(item);
  const splitInto = splitIntoCodes(item, items);
  const due = effectiveDue(item);
  const sub = item.kind !== 'theme' ? oneLine(item.done_when) : '';
  const go = () => onOpen(item.id);
  return (
    <div className={`pl-row pl-${item.kind}` + (item.state === 'split' ? ' pl-dim' : '')} style={{ paddingLeft: 10 + depth * 22 }} role="button" tabIndex={0}
      onClick={go} onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) { e.preventDefault(); go(); } }}>
      <div className="pl-row-main">
        <div className="pl-row-l1">
          <span className="pl-code">{item.code}</span>
          <span className="pl-row-t">{item.title}</span>
          {item.restricted && <Lock size={12} className="pl-lock" aria-label="Restricted" />}
          {noDataSource(item, metrics) && <NoSourceChip />}
          <ReadingChip measure={item.measure} metrics={metrics} />
        </div>
        {item.state === 'split'
          ? <div className="pl-row-sub">Split{splitInto.length ? ` → ${splitInto.join(', ')}` : ''}</div>
          : sub && <div className="pl-row-sub">{sub}</div>}
      </div>
      <span className="pl-owner">{item.owner_name || (item.kind === 'theme' && (item.level === 'F' || item.level === 'R') ? 'Both founders' : '')}</span>
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
