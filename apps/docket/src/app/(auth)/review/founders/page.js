'use client';
// /review/founders — the Saturday founders' catch-up (F9 R6b — spec
// docs/superpowers/specs/2026-11-11-docket-plan-layer.md §8.6; level F, plan admins only). ONE read
// (getFoundersReview): the cross-team asks (open tasks due this week or next that wait on another team's
// task) and each founder's top 5 for the week. The caller's own card is editable — five ranked slots, each
// a plan item, a task or a note (a ref and a note may sit together) — and Save replaces their whole list
// (setFounderFocus, one transaction). The other founder's card is read-only. ?week= lives in the URL.
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { Users, ChevronLeft, ChevronRight, Copy, ArrowLeft, Target, ListTodo, X, Lock } from 'lucide-react';
import { docketopsGet, docketopsPost } from '../../../../lib/docketopsFetch.js';
import { Button, IconButton, EmptyState, Pill, Popover } from '../../../../components/ui/index.js';
import { PlanPicker, usePlanItems } from '../../../../components/plan/PlanPicker.js';
import { DepSearch } from '../../../../components/task/Dependencies.js';
import { fmtPlanStamp, effectiveDue, planErrorText } from '../../../../lib/plan.js';
import { STATUS_MAP, effectiveDeadline } from '../../../../lib/tasks.js';
import {
  stepWeek, weekParam, reviewHref, reviewErrorText, tsDay, focusSlots, focusPayload, focusRefText, slotFilled,
  hiddenAsksText, foundersTitle, foundersHref, FOCUS_NOTE_MAX,
} from '../../../../lib/review.js';

const taskHref = (id) => '/tasks?task=' + id;

export default function FoundersPage() {
  return <Suspense fallback={<div className="pl"><Spinner /></div>}><FoundersInner /></Suspense>;
}

function FoundersInner() {
  const { session } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const week = useSearchParams().get('week') || 'this';
  const [data, setData] = useState(null);

  // Only the newest request may land (fast week stepping), as on /review.
  const ticket = useRef(0);
  const load = useCallback(async () => {
    if (!session) return;
    const mine = ++ticket.current;
    try { const d = await docketopsGet('getFoundersReview', { week }, session); if (mine === ticket.current) setData(d); }
    catch (e) { if (mine === ticket.current) setData({ error: reviewErrorText(e), code: e?.message }); }
  }, [session, week]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setData(null); }, [week]);
  useEffect(() => () => { ticket.current++; }, []);

  const go = (w) => router.replace(foundersHref({ week: w }));

  if (!data) return <div className="pl"><Spinner /></div>;
  if (data.code === 'forbidden') return <div className="pl"><EmptyState icon={Lock} title="Founders only"
    body="The Saturday catch-up is for the founders (plan admins)." action={<Button size="sm" variant="neutral" onClick={() => router.push('/review')}>Review</Button>} /></div>;
  if (data.error) return <div className="pl"><EmptyState icon={Users} title="Couldn’t load the catch-up" body={data.error}
    action={<Button size="sm" onClick={() => { setData(null); load(); }}>Retry</Button>} /></div>;

  const w = data.week || {};
  const isThis = weekParam(w.week_end) === 'this';
  const asks = (data.asks || []).filter(Boolean);
  const focus = (data.focus || []).filter(Boolean);

  async function copySlack() {
    if (!data.slack) { showToast('Nothing to copy', 'error'); return; }
    try { await navigator.clipboard.writeText(data.slack); showToast('Copied for Slack', 'success'); }
    catch { showToast('Could not copy', 'error'); }
  }
  const onSaved = (entry) => setData(d => ({ ...d, focus: (d.focus || []).map(f => (f.is_me ? { ...f, ...entry, is_me: true } : f)) }));

  return (
    <div className="pl rv">
      <div className="pl-head">
        <div className="pl-head-tx">
          <h1 className="pl-title">{foundersTitle(w.week_end)}</h1>
          <p className="pl-lede">Cross-team asks due this week or next, and each founder’s top 5 for the week.</p>
        </div>
        <div className="pl-head-acts">
          <Button variant="neutral" icon={ArrowLeft} onClick={() => router.push(reviewHref({ week: weekParam(w.week_end) }))}>Review</Button>
          <Button variant="neutral" icon={Copy} onClick={copySlack}>Copy for Slack</Button>
        </div>
      </div>

      <div className="pw-bar rv-bar">
        <div className="rv-step" role="group" aria-label="Week">
          <Button size="sm" variant="neutral" icon={ChevronLeft} aria-label="Previous week" onClick={() => go(weekParam(stepWeek(w.week_end, -1)))} />
          <Button size="sm" variant={isThis ? 'primary' : 'neutral'} onClick={() => go('this')}>This week</Button>
          <Button size="sm" variant="neutral" icon={ChevronRight} aria-label="Next week" onClick={() => go(weekParam(stepWeek(w.week_end, 1)))} />
        </div>
      </div>

      <div className="rv-body">
        <article className="rv-team">
          <h2 className="rv-team-h">Cross-team asks{asks.length > 0 && <span className="pl-count">{asks.length}</span>}</h2>
          {hiddenAsksText(data.hidden_asks) && <p className="rv-hidden">{hiddenAsksText(data.hidden_asks)}</p>}
          {asks.length === 0 ? <p className="rv-none">No cross-team blocks due this week or next</p> : asks.map(a => (
            <div key={a.link_id} className="rv-ask">
              <AskTask t={a.blocked} due />
              <div className="rv-ask-mid">↑ waiting on</div>
              <AskTask t={a.blocker} />
            </div>
          ))}
        </article>

        <div className="rv-focus">
          {focus.length === 0 && <p className="rv-none">No founders found.</p>}
          {focus.map(f => f.is_me
            ? <MyFocus key={f.founder_user_id} entry={f} week={w.week_end} session={session} onSaved={onSaved} />
            : <FocusCard key={f.founder_user_id} entry={f} />)}
        </div>
      </div>
    </div>
  );
}

function AskTask({ t, due = false }) {
  if (!t) return <div className="rv-row"><span className="rv-none">A task you can’t open</span></div>;
  const st = STATUS_MAP[t.status];
  return (
    <div className="rv-row rv-ask-t">
      <span className="pw-st" style={{ background: st?.color }} aria-label={st?.label} />
      <Link className="rv-task rv-t" href={taskHref(t.task_id)}><span className="pl-code">{t.task_no}</span> {t.title}</Link>
      <span className="rv-meta">{t.team_name || 'No team'} · {t.owner_name || 'Unassigned'} · {due ? 'due ' + tsDay(t.effective_deadline) : (st?.label || t.status)}</span>
    </div>
  );
}

function FocusCard({ entry }) {
  const items = [...(entry.items || [])].filter(Boolean).sort((a, b) => a.rank - b.rank);
  return (
    <article className="rv-team">
      <h2 className="rv-team-h">{entry.founder_name || 'Founder'}</h2>
      {entry.updated_at && <p className="rv-hidden">Updated {fmtPlanStamp(entry.updated_at)} IST</p>}
      {items.length === 0 ? <p className="rv-none">No top 5 set for this week</p> : (
        <ol className="rv-top">
          {items.map(it => (
            <li key={it.rank} className="rv-row">
              <span className="rv-rank">{it.rank}</span>
              <span className="rv-t">
                {focusRefText(it) && <span className="rv-ref">{focusRefText(it)}</span>}
                {it.note && <span className="rv-note">{it.note}</span>}
              </span>
              {it.ref?.due && <span className="rv-meta">due {tsDay(it.ref.due)}</span>}
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}

function MyFocus({ entry, week, session, onSaved }) {
  const { showToast } = useToast();
  const planItems = usePlanItems(session);
  const [slots, setSlots] = useState(() => focusSlots(entry.items));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setSlots(focusSlots(entry.items)); setDirty(false); }, [entry]);

  const set = (i, patch) => { setSlots(s => s.map((x, j) => (j === i ? { ...x, ...patch } : x))); setDirty(true); };
  async function save() {
    setSaving(true);
    try {
      const d = await docketopsPost('setFounderFocus', { week, items: focusPayload(slots) }, session);
      showToast('Saved', 'success');
      if (d?.focus) onSaved(d.focus);
      setDirty(false);
    } catch (e) { showToast(e?.message === 'week_closed' ? 'That week is closed.' : e?.message === 'not_found' ? reviewErrorText(e) : planErrorText(e), 'error'); }
    finally { setSaving(false); }
  }
  return (
    <article className="rv-team">
      <h2 className="rv-team-h">{entry.founder_name || 'You'} <Pill>you</Pill></h2>
      {entry.updated_at && <p className="rv-hidden">Updated {fmtPlanStamp(entry.updated_at)} IST</p>}
      <ol className="rv-top">
        {slots.map((s, i) => (
          <FocusSlot key={i} rank={i + 1} slot={s} session={session} planItems={planItems} disabled={saving}
            onChange={(p) => set(i, p)} />
        ))}
      </ol>
      <div className="pl-save rv-save">
        <span className="rv-hidden">{slots.filter(slotFilled).length} of 5 · empty slots are left out</span>
        <Button variant="primary" size="sm" onClick={save} loading={saving} disabled={!dirty}>Save</Button>
      </div>
    </article>
  );
}

function FocusSlot({ rank, slot, session, planItems, disabled, onChange }) {
  const planBtn = useRef(null), taskBtn = useRef(null);
  const [open, setOpen] = useState(null);   // 'plan' | 'task' | null
  const ref = focusRefText(slot);
  function pickPlan(id) {
    setOpen(null);
    if (!id) { onChange({ plan_item_id: null, ref: null }); return; }
    const it = (planItems || []).find(x => x.id === id);
    onChange({ plan_item_id: id, task_id: null, ref: it ? { kind: 'item', code: it.code, title: it.title, state: it.state, due: effectiveDue(it) } : null });
  }
  function pickTask(r) {
    setOpen(null);
    onChange({ task_id: r.id, plan_item_id: null, ref: { kind: 'task', task_no: r.task_no, title: r.title, status: r.status, due: effectiveDeadline(r) } });
  }
  return (
    <li className="rv-slot">
      <span className="rv-rank">{rank}</span>
      <div className="rv-slot-b">
        <div className="rv-slot-ref">
          {ref ? <span className="rv-ref">{ref}</span> : <span className="rv-none">No plan item or task</span>}
          {(slot.plan_item_id || slot.task_id) && <IconButton icon={X} size="sm" label="Clear the link" disabled={disabled}
            onClick={() => onChange({ plan_item_id: null, task_id: null, ref: null })} />}
          <span className="rv-slot-acts">
            <Button ref={planBtn} size="sm" variant="ghost" icon={Target} disabled={disabled} onClick={() => setOpen(o => (o === 'plan' ? null : 'plan'))}>Plan item</Button>
            <Button ref={taskBtn} size="sm" variant="ghost" icon={ListTodo} disabled={disabled} onClick={() => setOpen(o => (o === 'task' ? null : 'task'))}>Task</Button>
          </span>
        </div>
        <input className="pl-input rv-slot-note" value={slot.note || ''} maxLength={FOCUS_NOTE_MAX} disabled={disabled}
          placeholder="Note (or a free-text item)" aria-label={`Note for #${rank}`} onChange={e => onChange({ note: e.target.value })} />
      </div>
      <Popover anchorRef={planBtn} open={open === 'plan'} onClose={() => setOpen(null)} width={320} className="tv-pop">
        {open === 'plan' && <PlanPicker items={planItems} value={slot.plan_item_id} onPick={pickPlan} label={`#${rank} · plan item`} />}
      </Popover>
      <Popover anchorRef={taskBtn} open={open === 'task'} onClose={() => setOpen(null)} width={340} className="tv-pop dp-pick">
        {open === 'task' && <DepSearch session={session} hint={`#${rank} · task`} onPick={pickTask} />}
      </Popover>
    </li>
  );
}
