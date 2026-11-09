'use client';
// F4 "Clean up" (/tasks?lens=stale) — the stale-work sweep. Open tasks (sub-tasks
// included) overdue by 30+ days or untouched for 60+, from worker getStaleTasks. Each
// editable row: Done (changeStatus) · Revise (reviseDeadline: new date + REQUIRED reason;
// a task with no deadline gets its FIRST one via updateTask instead) · Abandon (reason).
// Bulk: Done all / Abandon all through the existing bulk actions. Pull-only — it sends
// nothing and nags no one (decisions §S309). view_all: Mine / Everyone + an owner filter,
// for a review meeting. ?scope=all&owner=<employee id> keep it linkable.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { Check, CalendarClock, Ban, MoreHorizontal, Sparkles, ChevronLeft, User, X, CornerDownRight } from 'lucide-react';
import { Button, IconButton, Popover, Menu, MenuItem, SegmentedTabs, EmptyState } from '../ui/index.js';
import { OptionList, fmtShortDate } from '../primitives.js';
import { DatePicker } from '../DatePicker.js';
import { contain } from './TaskCells.js';
import { TaskView } from '../task/TaskView.js';
import { docketopsGet, docketopsPost } from '../../lib/docketopsFetch.js';
import { parseQuickAdd, fmtDeadlineLabel } from '../../lib/quickAdd.js';
import { groupStale, staleAge, reviseError, effective } from '../../lib/stale.js';
import { useChrome } from '../../lib/chrome.js';
import { modPressed } from '../../lib/platform.js';

// The deadline alone from a quick-typed phrase — same trick as Grid triage.
function quickDeadline(text, now = new Date()) {
  const t = (text || '').trim();
  return t ? (parseQuickAdd(`_ ${t}`, { now }).deadline || null) : null;
}

export function StaleSweep() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const { setCount } = useChrome();
  const router = useRouter();
  const search = useSearchParams();
  const viewAll = !!(perms?.docket_view_all || perms?.docket_admin);
  const scope = viewAll && search.get('scope') === 'all' ? 'all' : 'mine';
  const owner = scope === 'all' ? (search.get('owner') || '') : '';

  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState({ total: 0, truncated: false });
  const [loading, setLoading] = useState(true);
  const [departments, setDepartments] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(() => new Set());       // row ids with a write in flight
  const [bulkBusy, setBulkBusy] = useState(false);
  const [drawerId, setDrawerId] = useState(null);

  // Only the latest request may land: a scope / owner switch (or perms arriving after the
  // session, flipping Mine → Everyone) must not be overwritten by a slower earlier read.
  const reqNo = useRef(0);
  const load = useCallback(async () => {
    if (!session) return;
    const n = ++reqNo.current;
    setLoading(true);
    try {
      const r = await docketopsGet('getStaleTasks', { scope: scope === 'all' ? 'all' : '', owner }, session);
      if (n !== reqNo.current) return;
      setRows(r?.tasks || []);
      setMeta({ total: r?.total || 0, truncated: !!r?.truncated });
    } catch (e) { if (n === reqNo.current) showToast(e.message || 'Failed to load stale tasks', 'error'); }
    finally { if (n === reqNo.current) setLoading(false); }
  }, [session, scope, owner, showToast]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setSelected(new Set()); }, [scope, owner]);
  useEffect(() => {
    if (!session) return;
    Promise.all([
      docketopsGet('getDepartments', {}, session).catch(() => []),
      docketopsGet('getEmployees', {}, session).catch(() => []),
    ]).then(([d, e]) => { setDepartments(d || []); setEmployees(e || []); });
  }, [session]);
  useEffect(() => { setCount?.(rows.length); return () => setCount?.(null); }, [rows.length, setCount]);

  const groups = useMemo(() => groupStale(rows, scope), [rows, scope]);
  const editableIds = useMemo(() => rows.filter(t => t._can_edit).map(t => t.id), [rows]);
  const ownerOpts = useMemo(() => [{ value: '', label: 'Everyone' }, ...employees.map(e => ({ value: e.id, label: e.full_name }))], [employees]);
  const ownerLabel = owner ? (employees.find(e => e.id === owner)?.full_name || 'One owner') : 'Everyone';

  function setQuery(next) {
    const p = new URLSearchParams({ lens: 'stale' });
    if (next.scope === 'all') { p.set('scope', 'all'); if (next.owner) p.set('owner', next.owner); }
    router.replace('/tasks?' + p.toString());
  }
  const remove = (ids) => {
    const gone = new Set(ids);
    setRows(rs => rs.filter(t => !gone.has(t.id)));
    setSelected(s => { const n = new Set(s); ids.forEach(id => n.delete(id)); return n; });
  };
  const mark = (id, on) => setBusy(b => { const n = new Set(b); if (on) n.add(id); else n.delete(id); return n; });

  // One write per row. The row leaves only once the worker confirms; on failure it stays + a toast.
  async function rowWrite(t, action, body, okText) {
    if (busy.has(t.id)) return false;
    mark(t.id, true);
    try {
      const res = await docketopsPost(action, { id: t.id, ...body }, session);
      // A first deadline the worker ignored (someone set one first) is not a success.
      if (action === 'updateTask' && body.deadline && !(res?.updated || []).includes('deadline')) {
        showToast(`${t.task_no}: a deadline was already set elsewhere — reloaded`, 'error');
        load();
        return false;
      }
      remove([t.id]);
      showToast(`${t.task_no} ${okText}`, 'success');
      return true;
    } catch (e) {
      showToast(`${t.task_no}: ${e.message || 'failed'}`, 'error');
      return false;
    } finally { mark(t.id, false); }
  }
  // changeStatus done on an ABANDONED task reactivates it — so re-read first: a task someone
  // abandoned after this list loaded is dropped from it, not brought back.
  async function done(t) {
    if (busy.has(t.id)) return false;
    mark(t.id, true);
    try {
      const cur = await docketopsGet('getTask', { id: t.id }, session);
      if (cur?.status === 'abandoned' || cur?.status === 'done') {
        remove([t.id]);
        showToast(`${t.task_no}: ${cur.status === 'done' ? 'already done' : 'abandoned elsewhere'} — skipped`, 'info');
        return false;
      }
    } catch { /* the write below reports its own error */ }
    finally { mark(t.id, false); }
    return rowWrite(t, 'changeStatus', { status: 'done' }, 'marked done');
  }
  const revise = (t, iso, reason) => (effective(t)
    ? rowWrite(t, 'reviseDeadline', { new_deadline: iso, reason: reason.trim() }, `revised to ${fmtDeadlineLabel(iso)}`)
    : rowWrite(t, 'updateTask', { deadline: iso }, `deadline set to ${fmtDeadlineLabel(iso)}`));
  const abandon = (t, reason) => rowWrite(t, 'abandonTask', { reason: reason.trim() }, 'abandoned');

  // Bulk: the existing actions skip abandoned + non-editable rows and say how many.
  // → true once the worker answered (even "0 updated"), false on a failed request — the
  // abandon bar keeps its reason open on false.
  async function runBulk(action, payload, verb) {
    const ids = [...selected];
    if (!ids.length || bulkBusy) return false;
    setBulkBusy(true);
    try {
      const res = await docketopsPost(action, { ids, ...payload }, session);
      const updated = res?.updated ?? 0, skipped = res?.skipped ?? 0;
      showToast(`${verb} ${updated}${skipped ? ` · skipped ${skipped} (not editable or already closed)` : ''}`, updated ? 'success' : 'info');
      setSelected(new Set());
      await load();                     // which ones were skipped isn't returned → re-read
      return true;
    } catch (e) { showToast(e.message || `${verb} failed`, 'error'); return false; }
    finally { setBulkBusy(false); }
  }
  const bulkDone = () => runBulk('bulkUpdateTasks', { field: 'status', value: 'done' }, 'Marked done');
  async function bulkAbandon(reason) {
    if (!window.confirm(`Abandon ${selected.size} task${selected.size === 1 ? '' : 's'}? This is terminal.`)) return false;
    return runBulk('bulkAbandonTasks', { reason: reason.trim() }, 'Abandoned');
  }
  const toggle = (id) => setSelected(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleGroup = (g) => {
    const ids = g.rows.filter(t => t._can_edit).map(t => t.id);
    setSelected(s => {
      const n = new Set(s);
      if (ids.length && ids.every(id => s.has(id))) ids.forEach(id => n.delete(id)); else ids.forEach(id => n.add(id));
      return n;
    });
  };
  const order = useCallback(() => groups.flatMap(g => g.rows.map(t => t.id)), [groups]);

  return (
    <div className="ss">
      <header className="ss-head">
        <Button variant="ghost" size="sm" icon={ChevronLeft} onClick={() => router.push('/tasks?lens=mine')}>My tasks</Button>
        <div className="ss-titles">
          <h2 className="ss-title-h">Clean up</h2>
          <p className="ss-sub">Open work overdue by 30+ days or untouched for 60+, sub-tasks included. Nothing here notifies anyone.</p>
        </div>
        {viewAll && (
          <div className="ss-scope">
            <SegmentedTabs label="Whose tasks" value={scope} onChange={v => setQuery({ scope: v, owner: '' })}
              tabs={[{ value: 'mine', label: 'Mine' }, { value: 'all', label: 'Everyone' }]} />
            {scope === 'all' && <OwnerFilter value={owner} label={ownerLabel} options={ownerOpts} onPick={v => setQuery({ scope: 'all', owner: v })} />}
          </div>
        )}
      </header>
      {meta.truncated && <p className="ss-note">Showing {rows.length} of {meta.total}{scope === 'all' ? ', filter by owner to see the rest' : ', oldest deadline first'}.</p>}

      {selected.size > 0 && <SweepBulkBar count={selected.size} busy={bulkBusy} onClear={() => setSelected(new Set())} onDone={bulkDone} onAbandon={bulkAbandon} />}

      {loading && rows.length === 0 ? <Spinner /> : groups.length === 0 ? (
        <div className="tl-emptywrap"><EmptyState icon={Sparkles} title="Nothing stale. Nice." body={scope === 'all' ? 'No open task is 30+ days overdue or 60+ days untouched here.' : 'None of your open tasks is 30+ days overdue or 60+ days untouched.'} /></div>
      ) : (
        <div className="ss-groups" style={{ opacity: loading ? 0.6 : 1 }}>
          {groups.map(g => {
            const ed = g.rows.filter(t => t._can_edit);
            const all = ed.length > 0 && ed.every(t => selected.has(t.id));
            return (
              <section key={g.key} className="ss-group" aria-label={g.label}>
                <h3 className="ss-ghead">
                  <input type="checkbox" className="ss-cb" aria-label={`Select all in ${g.label}`} disabled={!ed.length}
                    checked={all} onChange={() => toggleGroup(g)} />
                  <span>{g.label}</span><span className="ss-count">{g.rows.length}</span>
                </h3>
                {g.rows.map(t => (
                  <SweepRow key={t.id} t={t} showOwner={scope === 'all'} selected={selected.has(t.id)} busy={busy.has(t.id) || bulkBusy}
                    onToggle={() => toggle(t.id)} onOpen={() => setDrawerId(t.id)}
                    onDone={() => done(t)} onRevise={(iso, why) => revise(t, iso, why)} onAbandon={(why) => abandon(t, why)} />
                ))}
              </section>
            );
          })}
        </div>
      )}

      {drawerId && (
        <TaskView id={drawerId} session={session} departments={departments} employees={employees}
          onClose={() => setDrawerId(null)} onOpen={setDrawerId} getOrder={order} onMutated={load} refreshKey={rows} />
      )}
    </div>
  );
}

function OwnerFilter({ value, label, options, onPick }) {
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button ref={ref} variant="neutral" size="sm" icon={User} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(o => !o)}>{label}</Button>
      <Popover anchorRef={ref} open={open} onClose={() => setOpen(false)} width={240} {...contain}>
        <OptionList label="Owner" options={options} value={value} searchable onPick={v => { onPick(v || ''); setOpen(false); }} />
      </Popover>
    </>
  );
}

function SweepRow({ t, showOwner, selected, busy, onToggle, onOpen, onDone, onRevise, onAbandon }) {
  const age = staleAge(t);
  const reviseRef = useRef(null), abandonRef = useRef(null), moreRef = useRef(null);
  const [pop, setPop] = useState(null);          // { kind: 'revise'|'abandon', anchor: ref } | null
  const [menu, setMenu] = useState(false);
  const firstDeadline = !effective(t);
  return (
    <div className={'ss-row' + (selected ? ' is-selected' : '')}>
      {t._can_edit
        ? <input type="checkbox" className="ss-cb" checked={selected} onChange={onToggle} aria-label={`Select ${t.task_no}`} />
        : <span className="ss-cb-pad" aria-hidden />}
      <div className="ss-main">
        <button type="button" className="ss-title" onClick={onOpen}>{t.title}</button>
        <div className="ss-meta">
          <span className="ss-id">{t.task_no}</span>
          {t.parent && <span className="ss-crumb" title={t.parent.title}><CornerDownRight size={11} aria-hidden /> {t.parent.task_no} · {t.parent.title}</span>}
          {t.space_name && <span>{t.space_name}</span>}
          <span>{t.owner_name || 'No owner'}</span>
        </div>
      </div>
      <span className={'ss-age ' + age.kind} title={age.iso ? new Date(age.iso).toLocaleString('en-IN') : undefined}>
        {age.text}{age.kind === 'over' && <small>{fmtShortDate(age.iso)}</small>}
      </span>
      {t._can_edit ? (
        <div className="ss-acts">
          <div className="ss-acts-desk">
            <Button variant="ghost" size="sm" icon={Check} disabled={busy} onClick={onDone}>Done</Button>
            <Button ref={reviseRef} variant="ghost" size="sm" icon={CalendarClock} disabled={busy} onClick={() => setPop({ kind: 'revise', anchor: reviseRef })}>{firstDeadline ? 'Set date' : 'Revise'}</Button>
            <Button ref={abandonRef} variant="ghost" size="sm" icon={Ban} disabled={busy} onClick={() => setPop({ kind: 'abandon', anchor: abandonRef })}>Abandon</Button>
          </div>
          <IconButton ref={moreRef} className="ss-acts-more" icon={MoreHorizontal} size="sm" label={`Actions for ${t.task_no}`} disabled={busy} aria-haspopup="menu" onClick={() => setMenu(m => !m)} />
          <Menu anchorRef={moreRef} open={menu} onClose={() => setMenu(false)} align="right" width={180} label="Actions">
            <MenuItem icon={Check} onClick={onDone}>Done</MenuItem>
            <MenuItem icon={CalendarClock} onClick={() => setPop({ kind: 'revise', anchor: moreRef })}>{firstDeadline ? 'Set deadline…' : 'Revise…'}</MenuItem>
            <MenuItem icon={Ban} danger onClick={() => setPop({ kind: 'abandon', anchor: moreRef })}>Abandon…</MenuItem>
          </Menu>
          {pop && (
            <Popover anchorRef={pop.anchor} open onClose={() => setPop(null)} align="right" width={300} className="ss-pop" {...contain}>
              {pop.kind === 'revise'
                ? <ReviseForm task={t} busy={busy} onCancel={() => setPop(null)} onSubmit={async (iso, why) => { if (await onRevise(iso, why)) setPop(null); }} />
                : <AbandonForm busy={busy} onCancel={() => setPop(null)} onSubmit={async (why) => { if (await onAbandon(why)) setPop(null); }} />}
            </Popover>
          )}
        </div>
      ) : <span className="ss-ro">not yours to edit</span>}
    </div>
  );
}

function ReviseForm({ task, busy, onCancel, onSubmit }) {
  const first = !effective(task);
  const [iso, setIso] = useState(null);
  const [quick, setQuick] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const quickIso = useMemo(() => quickDeadline(quick), [quick]);
  function submit() {
    if (busy) return;
    if (quick.trim() && !quickIso) { setError(`“${quick.trim()}” isn’t a date I can read — try fri 5pm, tomorrow or 12 nov.`); return; }
    const when = quick.trim() ? quickIso : iso;
    const e = reviseError(task, when, reason, new Date());
    if (e) { setError(e); return; }
    setError('');
    onSubmit(when, reason);
  }
  const onKey = (e) => { if (e.key === 'Enter' && modPressed(e) && !e.repeat) { e.preventDefault(); submit(); } };
  return (
    <div className="ss-form" onKeyDown={onKey}>
      <div className="ss-form-h">{first ? 'Set a first deadline' : 'Revise deadline'}</div>
      {first
        ? <p className="ss-form-note">It becomes the original deadline — after this it can only be revised, with a reason.</p>
        : <p className="ss-form-note">Now {fmtDeadlineLabel(effective(task))}. The change and the reason go on the task’s history.</p>}
      <DatePicker value={iso} onChange={v => { setIso(v); setQuick(''); setError(''); }} />
      <input className="ss-input" value={quick} placeholder="or type: fri 5pm, tomorrow, 12 nov" aria-label="Type a date"
        onChange={e => { setQuick(e.target.value); setError(''); }}
        onKeyDown={e => { if (e.key === 'Enter' && !modPressed(e) && !e.nativeEvent.isComposing) { e.preventDefault(); if (!e.repeat && quickIso) { setIso(quickIso); setQuick(''); } } }} />
      {quick.trim() && <span className={'gt-quick-hint' + (quickIso ? '' : ' bad')}>{quickIso ? `↵ ${fmtDeadlineLabel(quickIso)}` : 'not a date'}</span>}
      {!first && <textarea className="ss-input" rows={2} value={reason} onChange={e => { setReason(e.target.value); setError(''); }} placeholder="Why is it moving? (required, logged)" aria-label="Reason" />}
      {error && <p className="gt-err" role="alert">{error}</p>}
      <div className="tl-pop-actions">
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" size="sm" loading={busy} onClick={submit}>{first ? 'Set deadline' : 'Revise'}</Button>
      </div>
    </div>
  );
}

function AbandonForm({ busy, onCancel, onSubmit }) {
  const [reason, setReason] = useState('');
  const go = () => { if (!busy && reason.trim()) onSubmit(reason); };
  return (
    <div className="ss-form">
      <div className="ss-form-h">Abandon task</div>
      <textarea autoFocus className="ss-input" rows={3} value={reason} onChange={e => setReason(e.target.value)} placeholder="Why is this being abandoned? (required, logged)" aria-label="Abandon reason"
        onKeyDown={e => { if (e.key === 'Enter' && modPressed(e) && !e.repeat) { e.preventDefault(); go(); } }} />
      <div className="tl-pop-actions">
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button variant="danger" size="sm" icon={Ban} disabled={!reason.trim()} loading={busy} onClick={go}>Abandon</Button>
      </div>
    </div>
  );
}

// A small bar of its own: BulkBar carries owner/priority/program/move/collaborator
// controls that aren't part of a sweep, and bulk revise is deliberately not offered.
function SweepBulkBar({ count, busy, onClear, onDone, onAbandon }) {
  const [abandoning, setAbandoning] = useState(false);
  const [reason, setReason] = useState('');
  useEffect(() => { if (!count) { setAbandoning(false); setReason(''); } }, [count]);
  return (
    <div className="ss-bulk" role="toolbar" aria-label="Bulk actions">
      <span className="ss-bulk-n">{count} selected</span>
      {abandoning ? (
        <>
          <input autoFocus className="ss-input ss-bulk-reason" value={reason} onChange={e => setReason(e.target.value)} placeholder="One reason for all (required, logged)" aria-label="Abandon reason"
            onKeyDown={e => { if (e.key === 'Enter' && !e.repeat && reason.trim()) { e.preventDefault(); onAbandon(reason).then(ok => { if (ok) { setAbandoning(false); setReason(''); } }); } if (e.key === 'Escape') setAbandoning(false); }} />
          <Button variant="danger" size="sm" icon={Ban} disabled={!reason.trim()} loading={busy}
            onClick={() => onAbandon(reason).then(ok => { if (ok) { setAbandoning(false); setReason(''); } })}>Abandon {count}</Button>
          <Button variant="ghost" size="sm" onClick={() => setAbandoning(false)}>Cancel</Button>
        </>
      ) : (
        <>
          <Button variant="neutral" size="sm" icon={Check} loading={busy} onClick={onDone}>Done all</Button>
          <Button variant="ghost" size="sm" icon={Ban} disabled={busy} onClick={() => setAbandoning(true)}>Abandon all…</Button>
        </>
      )}
      <span className="tk-spacer" />
      <IconButton icon={X} size="sm" label="Clear selection" onClick={onClear} />
    </div>
  );
}
