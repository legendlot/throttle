'use client';
// Plan tree (F9 R9a — spec docs/superpowers/specs/2026-11-11-docket-plan-layer.md §7.3). Theme → milestone →
// result → task, every row through the worker's projection (getPlanTree: level F everything; otherwise the
// caller's R / O / T rows). Each item carries its SUBTREE rollup — open · done · overdue, on-time % — and, for
// level F only, "+N hidden" (tasks in spaces the caller can't open). Task leaves are the tasks linked directly
// to the item (25 max, "+N more" → /tasks?plan=<id>); a click opens the task drawer like any list.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { ChevronRight, Network, Target, ChevronsDown, ChevronsUp, CalendarRange } from 'lucide-react';
import { docketopsGet } from '../../../../lib/docketopsFetch.js';
import { Button, EmptyState, Pill } from '../../../../components/ui/index.js';
import { NoSourceChip } from '../../../../components/plan/MeasureFields.js';
import { TaskView } from '../../../../components/task/TaskView.js';
import { chipState, fmtPlanDate } from '../../../../lib/plan.js';
import { STATUS_MAP } from '../../../../lib/tasks.js';
import { tsDay } from '../../../../lib/review.js';
import { treeErrorText, flattenTree, defaultExpanded, expandAll, toggle, countParts, onTimeText, hiddenText, themeOptions, KIND_SHORT } from '../../../../lib/tree.js';

export default function PlanTreePage() {
  const { session } = useAuth();
  const router = useRouter();
  const [theme, setTheme] = useState('');
  const [mine, setMine] = useState(false);
  const [closed, setClosed] = useState(false);
  const [data, setData] = useState(null);
  const [expanded, setExpanded] = useState(new Set());
  const [themes, setThemes] = useState([{ value: '', label: 'All themes' }]);
  const [drawerId, setDrawerId] = useState(null);
  const [people, setPeople] = useState({ departments: [], employees: [] });

  // Only the newest request lands (toggling filters fast).
  const ticket = useRef(0);
  const shaped = useRef('');   // the filter set the expand state was seeded for
  const load = useCallback(async () => {
    if (!session) return;
    const mineT = ++ticket.current;
    const key = `${theme}|${mine}|${closed}`;
    try {
      const d = await docketopsGet('getPlanTree', { theme, mine: mine ? '1' : '', closed: closed ? '1' : '' }, session);
      if (mineT !== ticket.current) return;
      setData(d);
      if (!theme) setThemes(themeOptions(d?.items));
      if (shaped.current !== key) { shaped.current = key; setExpanded(defaultExpanded(d?.items)); }
    } catch (e) { if (mineT === ticket.current) setData({ error: treeErrorText(e) }); }
  }, [session, theme, mine, closed]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => () => { ticket.current++; }, []);
  useEffect(() => {
    if (!session) return;
    Promise.all([
      docketopsGet('getDepartments', {}, session).catch(() => []),
      docketopsGet('getEmployees', {}, session).catch(() => []),
    ]).then(([departments, employees]) => setPeople({ departments: departments || [], employees: employees || [] }));
  }, [session]);

  const items = data?.items || [];
  const tasks = data?.tasks || {};
  const rows = useMemo(() => flattenTree(items, tasks, expanded), [items, tasks, expanded]);

  if (!data) return <div className="pl"><Spinner /></div>;
  if (data.error) return <div className="pl"><EmptyState icon={Network} title="Couldn’t load the tree" body={data.error}
    action={<Button size="sm" onClick={() => { setData(null); load(); }}>Retry</Button>} /></div>;

  return (
    <div className="pl ptr">
      <div className="pl-head">
        <div className="pl-head-tx">
          <h1 className="pl-title">Plan tree</h1>
          <p className="pl-lede">Theme → milestone → result → task, with what’s open, done and overdue under each — and how much landed on time.</p>
        </div>
        <div className="pl-head-acts">
          <Button variant="neutral" icon={Target} onClick={() => router.push('/plan')}>Plan</Button>
          <Button variant="neutral" icon={CalendarRange} onClick={() => router.push('/plan/weeks')}>Three weeks</Button>
        </div>
      </div>

      <div className="pw-bar ptr-bar">
        <label className="pw-team">
          <span className="pl-lbl">Theme</span>
          <select className="tk-fp-sel" value={theme} onChange={e => setTheme(e.target.value)} aria-label="Theme">
            {themes.map(o => <option key={o.value || 'all'} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <div className="ptr-toggles">
          <label className="pl-check"><input type="checkbox" checked={mine} onChange={e => setMine(e.target.checked)} /> Mine only</label>
          <label className="pl-check"><input type="checkbox" checked={closed} onChange={e => setClosed(e.target.checked)} /> Show closed</label>
          <Button size="sm" variant="ghost" icon={ChevronsDown} onClick={() => setExpanded(expandAll(items, tasks))}>Expand all</Button>
          <Button size="sm" variant="ghost" icon={ChevronsUp} onClick={() => setExpanded(new Set())}>Collapse all</Button>
        </div>
      </div>

      {Number(data.hidden_total) > 0 && <p className="rv-hidden ptr-hidden">+{data.hidden_total} tasks in spaces you’re not in are counted as hidden.</p>}

      {rows.length === 0 ? (
        <EmptyState icon={Network} title={mine ? 'Nothing of yours in the plan' : 'Nothing in the plan to show'}
          body={mine ? 'Items you own — and the path to them — appear here.' : closed ? 'No themes, milestones or results are visible to you.' : 'No open themes, milestones or results are visible to you. Show closed to include done and dropped ones.'}
          action={(mine || theme) ? <Button size="sm" variant="neutral" onClick={() => { setMine(false); setTheme(''); }}>Show everything</Button> : null} />
      ) : (
        <div className="ptr-list" role="tree" aria-label="Plan tree">
          {rows.map(r => r.type === 'item'
            ? <ItemRow key={'i' + r.item.id} row={r} onToggle={() => setExpanded(s => toggle(s, r.item.id))} />
            : r.type === 'task'
            ? <TaskLeaf key={'t' + r.itemId + r.task.id} row={r} onOpen={() => setDrawerId(r.task.id)} />
            : <div key={'m' + r.itemId} className="ptr-more" style={{ paddingLeft: indent(r.depth) }}>
                <button type="button" className="pw-link ptr-more-b" onClick={() => router.push('/tasks?plan=' + r.itemId)}>+{r.more} more</button>
              </div>)}
        </div>
      )}

      {drawerId && <TaskView id={drawerId} session={session} departments={people.departments} employees={people.employees}
        onClose={() => setDrawerId(null)} onOpen={setDrawerId} onMutated={load} />}
    </div>
  );
}

const indent = (depth) => 8 + depth * 20;

function ItemRow({ row, onToggle }) {
  const it = row.item;
  const chip = chipState(it);
  const due = it.effective_due || it.revised_due_date || it.due_date;
  const hid = hiddenText(it.counts);
  return (
    <div className={`ptr-row ptr-${it.kind}`} role="treeitem" aria-expanded={row.expandable ? row.open : undefined} aria-level={row.depth + 1}
      style={{ paddingLeft: indent(row.depth) }}>
      <button type="button" className={'ptr-chev' + (row.open ? ' open' : '')} onClick={onToggle} disabled={!row.expandable}
        aria-label={row.open ? 'Collapse' : 'Expand'}>{row.expandable ? <ChevronRight size={14} /> : null}</button>
      <div className="ptr-main" onClick={row.expandable ? onToggle : undefined}>
        <div className="ptr-l1">
          <span className="ptr-kind">{KIND_SHORT[it.kind] || it.kind}</span>
          {it.code && <span className="pl-code">{it.code}</span>}
          <span className="ptr-t">{it.title}</span>
          {it.no_data_source && <NoSourceChip />}
        </div>
        <div className="ptr-l2">
          {it.owner_name && <span className="ptr-meta">{it.owner_name}</span>}
          {it.kind !== 'theme' && due && <span className="ptr-meta">{fmtPlanDate(due)}</span>}
          {it.redated && <Pill className="pl-redated">Re-dated</Pill>}
          {it.state && <Pill tone="status" color={chip.color}>{chip.label}</Pill>}
          <span className="ptr-counts">
            {countParts(it.counts).map(p => <span key={p.key} className={'ptr-c' + (p.key === 'overdue' ? ' over' : '')}>{p.text}</span>)}
            <span className="ptr-c ptr-ot">{onTimeText(it.on_time)}</span>
            {hid && <span className="ptr-c ptr-hid" title="Tasks in spaces you’re not in">{hid}</span>}
          </span>
        </div>
      </div>
    </div>
  );
}

function TaskLeaf({ row, onOpen }) {
  const t = row.task;
  const st = STATUS_MAP[t.status];
  return (
    <button type="button" className={'ptr-row ptr-task dk-press' + (t.status === 'done' ? ' done' : '')} style={{ paddingLeft: indent(row.depth) + 22 }}
      onClick={onOpen} title={`${t.task_no || ''} ${t.title}`.trim()}>
      <span className="pw-st" style={{ background: st?.color }} aria-hidden />
      <span className="pl-code">{t.task_no}</span>
      <span className="ptr-t">{t.title}</span>
      <span className="ptr-l2 ptr-task-meta">
        <span className="ptr-meta">{t.owner_name || 'Unassigned'}</span>
        <span className={'ptr-meta' + (t.overdue ? ' over' : '')}>{t.effective_deadline ? tsDay(t.effective_deadline) : 'No date'}</span>
        <span className="ptr-meta">{st?.label || t.status}</span>
      </span>
    </button>
  );
}
