'use client';
// F9 R2 — the plan on every task. One picker, one chip, one loader, shared by the task view, the create
// form, quick capture, the list's Plan column and Board cards.
//   usePlanItems(session) — getPlan (the caller's own F / O / R / T rows: super → everything; a Founders'
//     Associate → every unrestricted item at R; others → the milestones/results they own + every
//     unrestricted theme). One read per signed-in user, shared by
//     every mounted picker; a plan write (docketopsPost *PlanItem*) fires `docket:plan-changed` → re-read.
//   PlanPicker — searchable list: "Unplanned" (= clear) + live items as "Theme › M01 › M01.R2 · Title".
//   PlanChip   — a task's `plan` (the worker's projection): code + title on hover; L "Another owner's
//     milestone"; inherited (a sub-task) muted; nothing for no link.
//   usePlanWeek(session) — R4: the org's week settings (getPlan `week`: week_end_dow, working_days,
//     holidays) off the same cached read; the defaults (Sunday) only until it lands.
import { useEffect, useMemo, useState } from 'react';
import { Target } from 'lucide-react';
import { docketopsGet } from '../../lib/docketopsFetch.js';
import { OptionList } from '../primitives.js';
import { planPickerOptions, planChip, buildPlanTree } from '../../lib/plan.js';
import { normalizeWeekSettings } from '../../lib/weeks.js';

let cache = { key: null, at: 0, p: null };
const TTL = 60000;
function loadPlan(session) {
  const key = session?.user?.id || 'session';
  if (cache.key === key && cache.p && Date.now() - cache.at < TTL) return cache.p;
  const p = docketopsGet('getPlan', {}, session)
    .then(d => ({ items: Array.isArray(d?.items) ? d.items : [], week: normalizeWeekSettings(d?.week) }))
    .catch(() => ({ items: [], week: normalizeWeekSettings(null) }));
  cache = { key, at: Date.now(), p };
  return p;
}
// ONE invalidation per plan write: this module-level listener is registered when the module loads — before
// any hook's own listener — so it clears the cache first and every reader's re-read shares one getPlan.
if (typeof window !== 'undefined') window.addEventListener('docket:plan-changed', () => { cache = { key: null, at: 0, p: null }; });

function usePlanRead(session, pick, initial) {
  const [val, setVal] = useState(initial);
  const userKey = session?.user?.id || (session ? 'session' : '');
  useEffect(() => {
    if (!session) return undefined;
    let live = true;
    const read = () => loadPlan(session).then(x => { if (live) setVal(pick(x)); });
    read();
    window.addEventListener('docket:plan-changed', read);
    return () => { live = false; window.removeEventListener('docket:plan-changed', read); };
  }, [userKey]); // eslint-disable-line react-hooks/exhaustive-deps
  return val;
}
const NO_ITEMS = [];
const DEFAULT_WEEK = normalizeWeekSettings(null);
export function usePlanItems(session) { return usePlanRead(session, x => x.items, NO_ITEMS); }
export function usePlanWeek(session) { return usePlanRead(session, x => x.week, DEFAULT_WEEK); }

// byId over the caller's plan rows (the Plan filter needs parents).
export function usePlanById(items) {
  return useMemo(() => buildPlanTree(items).byId, [items]);
}

export function PlanPicker({ items, value, onPick, label }) {
  const options = useMemo(() => planPickerOptions(items).map(o => (o.value ? {
    ...o, node: <span className="pl-opt" style={{ paddingLeft: (o.depth || 0) * 10 }}>{o.label}</span>,
  } : o)), [items]);
  return <OptionList label={label} options={options} value={value || ''} searchable onPick={(v) => onPick(v || null)} />;
}

export function PlanChip({ plan, className = '' }) {
  const c = planChip(plan);
  if (!c) return null;
  return (
    <span className={'pl-chip' + (c.muted ? ' muted' : '') + (c.redacted ? ' redacted' : '') + (className ? ' ' + className : '')} title={c.title}>
      <Target size={11} strokeWidth={2} aria-hidden /><span className="pl-chip-l">{c.label}</span>
    </span>
  );
}

export default PlanPicker;
