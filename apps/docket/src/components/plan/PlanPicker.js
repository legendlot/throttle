'use client';
// F9 R2 — the plan on every task. One picker, one chip, one loader, shared by the task view, the create
// form, quick capture, the list's Plan column and Board cards.
//   usePlanItems(session) — getPlan (the caller's own F / O / T rows: super → everything; others → the
//     milestones/results they own + every unrestricted theme). One read per signed-in user, shared by
//     every mounted picker; a plan write (docketopsPost *PlanItem*) fires `docket:plan-changed` → re-read.
//   PlanPicker — searchable list: "Unplanned" (= clear) + live items as "Theme › M01 › M01.R2 · Title".
//   PlanChip   — a task's `plan` (the worker's projection): code + title on hover; L "Another owner's
//     milestone"; inherited (a sub-task) muted; nothing for no link.
import { useEffect, useMemo, useState } from 'react';
import { Target } from 'lucide-react';
import { docketopsGet } from '../../lib/docketopsFetch.js';
import { OptionList } from '../primitives.js';
import { planPickerOptions, planChip, buildPlanTree } from '../../lib/plan.js';

let cache = { key: null, at: 0, p: null };
const TTL = 60000;
function loadPlan(session) {
  const key = session?.user?.id || 'session';
  if (cache.key === key && cache.p && Date.now() - cache.at < TTL) return cache.p;
  const p = docketopsGet('getPlan', {}, session).then(d => (Array.isArray(d?.items) ? d.items : [])).catch(() => []);
  cache = { key, at: Date.now(), p };
  return p;
}

export function usePlanItems(session) {
  const [items, setItems] = useState([]);
  const userKey = session?.user?.id || (session ? 'session' : '');
  useEffect(() => {
    if (!session) return undefined;
    let live = true;
    const read = () => loadPlan(session).then(x => { if (live) setItems(x); });
    read();
    const onChange = () => { cache = { key: null, at: 0, p: null }; read(); };
    window.addEventListener('docket:plan-changed', onChange);
    return () => { live = false; window.removeEventListener('docket:plan-changed', onChange); };
  }, [userKey]); // eslint-disable-line react-hooks/exhaustive-deps
  return items;
}

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
