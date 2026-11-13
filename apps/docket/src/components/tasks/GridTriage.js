'use client';
// Triage The Grid (Docket F3): one Grid task at a time in a focused modal (a full-screen
// sheet ≤767px) — set owner + deadline (+ priority), abandon with a reason, or skip.
// Existing writes only: updateTask (changed fields only; a first deadline becomes the
// immutable original and logs deadline_set) and abandonTask. The queue is snapshotted at
// open; the page's list reloads once, on close, so rows don't jump mid-triage.
//
// Keys (only when focus is NOT in a field or a picker): Enter save & next · A abandon ·
// S / → skip · ← back · Esc close. ⌘/Ctrl+Enter saves from inside a field. With the abandon
// panel open only Enter (abandon, needs a reason) and Esc (close the panel) act. Held keys
// (e.repeat) never act; nothing moves or closes while a write is in flight.
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { User, CalendarPlus, X, ExternalLink, Ban, ChevronLeft, ChevronRight, Check, Inbox, Lock } from 'lucide-react';
import { Popover, Button, IconButton, Kbd } from '../ui/index.js';
import { OptionList, fmtShortDate } from '../primitives.js';
import { DatePicker } from '../DatePicker.js';
import { contain } from './TaskCells.js';
import { parseQuickAdd, fmtDeadlineLabel } from '../../lib/quickAdd.js';
import { PRIORITIES } from '../../lib/tasks.js';
import { docketopsPost } from '../../lib/docketopsFetch.js';
import { startTriage, triageReducer, progressLine, triageCounts, isLocked, buildTriagePatch, saveOutcome, relAgo, isGoneError } from '../../lib/triage.js';
import { modPressed } from '../../lib/platform.js';

const RESULT_LABEL = { set: 'Owner + deadline set', partial: 'Saved — still in the Grid', abandoned: 'Abandoned', skipped: 'Skipped', gone: 'Skipped — changed elsewhere' };
const inField = (el) => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
const inPicker = (el) => !!el?.closest?.('.ui-pop, .pop, [role="listbox"]');

// The deadline alone from a quick-typed phrase ("fri 5pm", "tomorrow", "12 nov"). The
// placeholder word keeps parseQuickAdd's "an all-token title stays raw" rule from firing.
function quickDeadline(text, now = new Date()) {
  const t = (text || '').trim();
  if (!t) return null;
  return parseQuickAdd(`_ ${t}`, { now }).deadline || null;
}

export function GridTriage({ queue, skippedCount = 0, tasksById, ownerOpts, empMap, session, showToast, onOpenTask, suspended, onClose }) {
  const [state, dispatch] = useReducer(triageReducer, queue, startTriage);
  // Snapshot at open; the live row (tasksById) wins when present, e.g. after "Open task".
  const snap = useRef(null);
  if (!snap.current) snap.current = Object.fromEntries(queue.map(id => [id, tasksById[id]]));
  const id = state.ids[state.i];
  const task = id ? (tasksById[id] || snap.current[id]) : null;
  const atEnd = state.i >= state.ids.length;
  const wrote = useRef(false);
  // In-flight write. The ref is the synchronous guard (two Enters in one frame), the state
  // drives the UI; while set, nothing moves: no skip/back/close, no second write.
  const busy = useRef(false);
  const [saving, setSavingState] = useState(false);
  const setSaving = (v) => { busy.current = v; setSavingState(v); };
  // The triage owner picker assigns someone — "— Unassigned —" isn't a choice here.
  const owners = useMemo(() => (ownerOpts || []).filter(o => o.value !== ''), [ownerOpts]);

  const rootRef = useRef(null);
  const focusRoot = () => rootRef.current?.focus({ preventScroll: true });
  // Focus in on open, back to the opener on close (TaskView's pattern) + keep Tab inside.
  useEffect(() => {
    const opener = document.activeElement;
    focusRoot();
    return () => { if (opener && document.contains(opener)) opener.focus?.({ preventScroll: true }); };
  }, []);
  useEffect(() => { if (!suspended) setTimeout(focusRoot, 0); }, [suspended]);
  useEffect(() => {
    if (suspended) return undefined;
    function onIn(e) {
      const r = rootRef.current;
      if (!r || r.contains(e.target) || e.target.closest?.('.ui-pop, .pop, .ui-tip, [role="listbox"]')) return;
      focusRoot();
    }
    function onOut(e) {
      if (e.relatedTarget) return;
      setTimeout(() => { if (document.activeElement === document.body || document.activeElement == null) focusRoot(); }, 0);
    }
    document.addEventListener('focusin', onIn);
    document.addEventListener('focusout', onOut);
    return () => { document.removeEventListener('focusin', onIn); document.removeEventListener('focusout', onOut); };
  }, [suspended]);

  // Never close mid-write: the result would land on a closed session and the list would
  // not reload.
  const close = () => { if (!busy.current) onClose({ wrote: wrote.current }); };
  // The current card registers its actions here during its render — `card.id` is the task
  // that card's draft belongs to. The card is keyed on the task id, so its draft is born
  // with the task; a key arriving while card.id ≠ the current id is dropped.
  const card = useRef(null);
  if (atEnd) card.current = null;
  const live = useRef({});
  live.current = { id, atEnd, close };

  // Keyboard. Bare letters/arrows only outside fields and pickers; the shell's own bare-key
  // shortcuts stand down while a [data-modal] is up (layout.js), ⌘K is gated the same way.
  useEffect(() => {
    if (suspended) return undefined;
    function onKey(e) {
      const L = live.current;
      const C = card.current && card.current.id === L.id ? card.current : null;
      const ae = document.activeElement;
      if (inPicker(e.target) || inPicker(ae)) return;            // the picker owns its keys (Esc closes it)
      if (e.key === 'Escape') {
        e.preventDefault();
        if (busy.current) return;
        if (C?.abandoning) C.cancelAbandon(); else L.close();
        return;
      }
      if (e.repeat) return;                                       // a held key never fires a second write
      if (e.key === 'Enter' && modPressed(e)) {
        e.preventDefault();
        if (C) { if (C.abandoning) C.abandon(); else C.save(); }
        return;
      }
      if (inField(ae) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Enter') {
        // A focused button takes its own Enter — except the priority choices, where Enter saves.
        if ((ae?.tagName === 'BUTTON' || ae?.tagName === 'A') && !ae.closest('.gt-prio')) return;
        e.preventDefault();
        if (L.atEnd) L.close();
        else if (C) { if (C.abandoning) C.abandon(); else C.save(); }
        return;
      }
      if (L.atEnd || !C || C.abandoning || busy.current) return;  // abandon panel open: only Enter / Esc
      if (e.key === 'a' || e.key === 'A') { if (!C.locked) { e.preventDefault(); C.openAbandon(); } }
      else if (e.key === 's' || e.key === 'S' || e.key === 'ArrowRight') { e.preventDefault(); dispatch({ type: 'skip' }); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); dispatch({ type: 'back' }); }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [suspended]);

  const counts = triageCounts(state);
  const titleId = 'gt-title';
  return (
    // data-modal only while visible: suspended (TaskView open on top) the shell's ?, [, / and
    // ⌘K must work again — TaskView carries its own modal suppression.
    <div className="gt-backdrop" data-modal={suspended ? undefined : ''} hidden={suspended} onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
      <div ref={rootRef} className="gt" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="gt-head">
          <Inbox size={15} className="gt-head-ic" aria-hidden />
          <h2 id={titleId} className="gt-title">Triage The Grid</h2>
          <span className="gt-progress" aria-live="polite">{progressLine(state)}</span>
          <IconButton icon={X} size="sm" label="Close triage" shortcut={['Esc']} disabled={saving} onClick={close} />
        </header>
        {skippedCount > 0 && <p className="gt-note">{skippedCount} you can’t edit {skippedCount === 1 ? 'was' : 'were'} skipped.</p>}

        {atEnd ? (
          <div className="gt-body gt-summary">
            <Check size={22} className="gt-sum-ic" aria-hidden />
            <h3>Triage done</h3>
            <ul className="gt-sum">
              <li><b>{counts.set}</b> set (owner + deadline)</li>
              {counts.partial > 0 && <li><b>{counts.partial}</b> saved but still in the Grid</li>}
              <li><b>{counts.abandoned}</b> abandoned</li>
              <li><b>{counts.skipped + counts.gone}</b> skipped{counts.gone ? ` (${counts.gone} changed elsewhere)` : ''}</li>
            </ul>
            <div className="gt-actions">
              <Button variant="ghost" icon={ChevronLeft} onClick={() => dispatch({ type: 'back' })}>Back</Button>
              <Button variant="primary" onClick={close} autoFocus>Close</Button>
            </div>
          </div>
        ) : task ? (
          <TriageCard key={id} task={task} result={state.results[id]} saved={state.saved[id]} canBack={state.i > 0}
            cardRef={card} dispatch={dispatch} saving={saving} setSaving={setSaving} busy={busy} wrote={wrote}
            owners={owners} empMap={empMap} session={session} showToast={showToast} onOpenTask={onOpenTask} focusRoot={focusRoot} />
        ) : null}
      </div>
    </div>
  );
}

const fieldsOf = (t) => ({ owner_employee_id: t.owner_employee_id || null, deadline: t.deadline || null, priority: t.priority || 'P2' });

// One card = one task. Keyed on the task id by the parent, so every bit of draft state here
// (draft, dirty, abandon panel, reason, quick text) is born with its task and dies with it.
function TriageCard({ task, result, saved, canBack, cardRef, dispatch, saving, setSaving, busy, wrote, owners, empMap, session, showToast, onOpenTask, focusRoot }) {
  const locked = isLocked(result);
  const [draft, setDraft] = useState(() => fieldsOf(task));
  // Fields the person changed on THIS card. Only these are ever sent; the rest follow the
  // live row (re-seeded below), so a change made in TaskView via "Open task" stands.
  const dirty = useRef(new Set());
  const edit = (f, v) => { dirty.current.add(f); setDraft(d => ({ ...d, [f]: v })); };
  const [error, setError] = useState('');
  const [abandoning, setAbandoning] = useState(false);
  const [reason, setReason] = useState('');
  const [quick, setQuick] = useState('');
  const liveKey = `${task.owner_employee_id || ''}|${task.deadline || ''}|${task.priority || ''}`;
  useEffect(() => {
    const now = fieldsOf(task);
    setDraft(d => {
      const next = { ...d };
      for (const f of Object.keys(now)) if (!dirty.current.has(f)) next[f] = now[f];
      return next;
    });
  }, [liveKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const quickIso = useMemo(() => quickDeadline(quick), [quick]);
  const canEditDeadline = !task.deadline;
  // A locked card you stepped back to shows what was written, not the pre-save row (the
  // list only reloads on close).
  const view = locked && saved ? { ...draft, ...saved } : draft;

  async function save() {
    if (locked || busy.current) return;
    // Text still sitting in the quick-type box counts (⌘Enter from inside it).
    let d = draft;
    let touched = dirty.current;
    if (canEditDeadline && quick.trim()) {
      if (!quickIso) { setError(`“${quick.trim()}” isn’t a date I can read — try fri 5pm, tomorrow or 12 nov.`); return; }
      d = { ...draft, deadline: quickIso };
      touched = new Set([...touched, 'deadline']);
    }
    const { patch, error: err, complete } = buildTriagePatch(task, d, new Date(), touched);
    if (err) { setError(err); return; }
    if (!patch) { dispatch({ type: 'skip' }); return; }          // nothing changed → next
    setSaving(true); setError('');
    try {
      const res = await docketopsPost('updateTask', { id: task.id, ...patch }, session);
      wrote.current = true;
      const out = saveOutcome(patch, res, complete);
      if (out.note) showToast(`${task.task_no}: ${out.note}`, out.result === 'skipped' ? 'info' : 'error');
      dispatch({ type: 'record', id: task.id, result: out.result, patch: out.patch });
    } catch (e) {
      if (isGoneError(e)) { showToast(`${task.task_no}: ${e.message} — skipped`, 'error'); dispatch({ type: 'record', id: task.id, result: 'gone' }); }
      else showToast(e.message || 'Save failed', 'error');
    } finally { setSaving(false); }
  }
  async function abandon() {
    const why = reason.trim();
    if (locked || busy.current || !why) return;
    setSaving(true);
    try {
      await docketopsPost('abandonTask', { id: task.id, reason: why }, session);
      wrote.current = true;
      dispatch({ type: 'record', id: task.id, result: 'abandoned' });
    } catch (e) {
      if (isGoneError(e)) { showToast(`${task.task_no}: ${e.message} — skipped`, 'error'); dispatch({ type: 'record', id: task.id, result: 'gone' }); }
      else showToast(e.message || 'Abandon failed', 'error');
    } finally { setSaving(false); }
  }
  const cancelAbandon = () => { setAbandoning(false); setReason(''); focusRoot(); };
  cardRef.current = { id: task.id, locked, abandoning, save, abandon, cancelAbandon, openAbandon: () => setAbandoning(true) };

  return (
    <div className="gt-body">
      <div className="gt-card">
        <div className="gt-meta">
          <span className="gt-id">{task.task_no}</span>
          {task.space_name && <span>{task.space_name}</span>}
          {task.program?.name && <span>· {task.program.name}</span>}
          {result && <span className={'gt-result ' + result}>{RESULT_LABEL[result]}</span>}
        </div>
        <h3 className="gt-task">{task.title}</h3>
        <div className="gt-sub">
          {task.creator_name ? `Raised by ${task.creator_name}` : 'Raised'}{task.created_at ? ` · ${relAgo(task.created_at)}` : ''}
          <button type="button" className="gt-open" disabled={saving} onClick={() => onOpenTask(task.id)}>
            <ExternalLink size={12} aria-hidden /> Open task
          </button>
        </div>
        {task.description && <p className="gt-desc">{String(task.description).slice(0, 280)}{String(task.description).length > 280 ? '…' : ''}</p>}
      </div>

      <fieldset className="gt-fields" disabled={locked || saving}>
        <div className="gt-field">
          <span className="gt-lbl">Owner{!view.owner_employee_id && <i className="gt-need">needed</i>}</span>
          <OwnerPicker value={view.owner_employee_id} options={owners} label={empMap[view.owner_employee_id] || ''}
            onPick={v => { if (v) edit('owner_employee_id', v); }} onDone={focusRoot} disabled={locked || saving} />
        </div>
        <div className="gt-field">
          <span className="gt-lbl">Deadline{!(task.deadline || view.deadline) && <i className="gt-need">needed</i>}</span>
          {canEditDeadline && !(locked && view.deadline) ? (
            <div className="gt-dl">
              <DeadlinePicker value={view.deadline} onPick={v => { edit('deadline', v); setError(''); }} onDone={focusRoot} disabled={locked || saving} />
              <input className="gt-quick" value={quick} placeholder="or type: fri 5pm, tomorrow, 12 nov" aria-label="Type a deadline"
                onChange={e => setQuick(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !modPressed(e) && !e.nativeEvent.isComposing) {
                    e.preventDefault(); e.stopPropagation();
                    if (e.repeat) return;
                    if (quickIso) { edit('deadline', quickIso); setQuick(''); setError(''); }
                  }
                }} />
              {quick.trim() && <span className={'gt-quick-hint' + (quickIso ? '' : ' bad')}>{quickIso ? `↵ ${fmtDeadlineLabel(quickIso)}` : 'not a date'}</span>}
            </div>
          ) : (
            <span className="gt-fixed"><Lock size={12} aria-hidden /> {fmtShortDate(task.deadline || view.deadline)} <small>set — revise from the task</small></span>
          )}
        </div>
        <div className="gt-field">
          <span className="gt-lbl">Priority</span>
          <div className="gt-prio" role="radiogroup" aria-label="Priority">
            {PRIORITIES.map(p => (
              <button key={p.key} type="button" role="radio" aria-checked={view.priority === p.key}
                className={'gt-prio-b' + (view.priority === p.key ? ' on' : '')} style={{ '--pc': p.color }}
                onClick={() => edit('priority', p.key)}>{p.short || p.key}</button>
            ))}
          </div>
        </div>
      </fieldset>
      {error && <p className="gt-err" role="alert">{error}</p>}

      {abandoning && !locked && (
        <div className="gt-abandon">
          <textarea autoFocus value={reason} onChange={e => setReason(e.target.value)} placeholder="Why is this being abandoned? (required, logged) — ↵ abandons, ⇧↵ new line" aria-label="Abandon reason"
            onKeyDown={e => {
              if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
              e.preventDefault(); e.stopPropagation();
              if (!e.repeat) abandon();
            }} />
          <div className="gt-actions">
            <Button variant="ghost" size="sm" disabled={saving} onClick={cancelAbandon}>Cancel</Button>
            <Button variant="danger" size="sm" icon={Ban} disabled={!reason.trim()} loading={saving} onClick={abandon}>Abandon task</Button>
          </div>
        </div>
      )}

      <div className="gt-actions gt-main-actions">
        <Button variant="ghost" size="sm" icon={ChevronLeft} disabled={!canBack || saving || abandoning} onClick={() => dispatch({ type: 'back' })}>Back <Kbd>←</Kbd></Button>
        {!locked && !abandoning && <Button variant="ghost" size="sm" icon={Ban} disabled={saving} onClick={() => setAbandoning(true)}>Abandon… <Kbd>A</Kbd></Button>}
        <span className="gt-spacer" />
        <Button variant="neutral" size="sm" disabled={saving || abandoning} onClick={() => dispatch({ type: 'skip' })}>{locked ? 'Next' : 'Skip'} <Kbd>S</Kbd></Button>
        {!locked && !abandoning && <Button variant="primary" size="sm" iconRight={ChevronRight} loading={saving} onClick={save}>Save &amp; next <Kbd>↵</Kbd></Button>}
      </div>
    </div>
  );
}

function OwnerPicker({ value, options, label, onPick, onDone, disabled }) {
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button ref={ref} type="button" className={'gt-pick' + (value ? ' set' : '')} disabled={disabled} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <User size={13} aria-hidden /><span>{value ? (label || 'Owner') : 'Pick an owner'}</span>
      </button>
      <Popover anchorRef={ref} open={open} onClose={() => setOpen(false)} width={240} className="gt-pop" {...contain}>
        <OptionList label="Owner" options={options} value={value || ''} searchable onPick={(v) => { onPick(v); setOpen(false); (onDone || (() => ref.current?.focus()))(); }} />
      </Popover>
    </>
  );
}

function DeadlinePicker({ value, onPick, onDone, disabled }) {
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(null);
  return (
    <>
      <button ref={ref} type="button" className={'gt-pick' + (value ? ' set' : '')} disabled={disabled} aria-haspopup="dialog" aria-expanded={open}
        onClick={() => { setDraft(value || null); setOpen(o => !o); }}>
        <CalendarPlus size={13} aria-hidden /><span>{value ? fmtDeadlineLabel(value) : 'Pick a deadline'}</span>
      </button>
      <Popover anchorRef={ref} open={open} onClose={() => setOpen(false)} width={280} className="gt-pop gt-pop-date" {...contain}>
        <DatePicker value={draft} onChange={setDraft} autoFocus />
        <div className="tl-pop-actions">
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="primary" size="sm" disabled={!draft} onClick={() => { onPick(draft); setOpen(false); (onDone || (() => ref.current?.focus()))(); }}>Set deadline</Button>
        </div>
      </Popover>
    </>
  );
}
