'use client';
// Inline-edit cells for the /tasks list (ClickUp redesign P3). Every picker portals
// (ui/Popover or AnchoredPopover) so a horizontally scrolling list can't clip it.
// React events bubble through portals, so every popover body stops click/keydown
// propagation — otherwise a pick would also hit the row's "open drawer" click.
//
// An empty, editable cell shows a GhostCell (faint icon) that opens the same picker.
import { useRef, useState } from 'react';
import { Check, Ban, AlertTriangle, Flag, CalendarPlus } from 'lucide-react';
import { StatusBadge } from '../StatusBadge.js';
import { DatePicker } from '../DatePicker.js';
import { AnchoredPopover, OptionList, deadlineState, relDeadline, fmtShortDate } from '../primitives.js';
import { Popover, GhostCell, Button } from '../ui/index.js';
import { SETTABLE_STATUSES, STATUS_MAP, PRIORITY_MAP, effectiveDeadline } from '../../lib/tasks.js';

export const stop = (e) => e.stopPropagation();
// Spread on a popover body: keeps picks / typing inside it from reaching the row.
export const contain = { onClick: stop, onMouseDown: stop, onKeyDown: stop };

/* ---------------- Generic select cell ---------------- */
export function EditableSelect({ editable, value, options, searchable, onPick, children, empty, ghostIcon, label, align = 'left', width = 210 }) {
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  if (!editable) return empty ? null : <span className="tl-static">{children}</span>;
  return (
    <>
      {empty
        ? <GhostCell ref={ref} icon={ghostIcon} label={label} className="tl-ghost" onClick={(e) => { stop(e); setOpen(o => !o); }} />
        : <button ref={ref} type="button" className="tl-edit" aria-label={label} onClick={(e) => { stop(e); setOpen(o => !o); }}>{children}</button>}
      <Popover anchorRef={ref} open={open} onClose={() => setOpen(false)} width={width} align={align} {...contain}>
        <OptionList options={options} value={value} searchable={searchable} onPick={(v, o) => { onPick(v, o); setOpen(false); }} />
      </Popover>
    </>
  );
}

/* ---------------- Status circle (title cell): one-click done toggle ---------------- */
export function StatusCircle({ task, editable, onToggle }) {
  const s = STATUS_MAP[task.status] || STATUS_MAP.not_started;
  const done = task.status === 'done';
  return (
    <button type="button" className={'tl-circle' + (done ? ' done' : '')} disabled={!editable}
      style={{ '--st': s.color }} aria-label={done ? 'Mark not done' : 'Mark done'} title={done ? 'Mark not done' : 'Mark done'}
      onClick={(e) => { stop(e); onToggle(); }}>
      {done && <Check size={10} strokeWidth={3} />}
    </button>
  );
}

/* ---------------- Status cell (settable + abandon with a required reason) ---------------- */
export function StatusCell({ task, editable, onSet, onAbandon }) {
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  const [abandon, setAbandon] = useState(false);
  const [reason, setReason] = useState('');
  if (!editable) return <StatusBadge status={task.status} />;
  const close = () => { setOpen(false); setAbandon(false); };
  const doAbandon = () => { if (!reason.trim()) return; onAbandon(reason.trim()); close(); };
  return (
    <>
      <button ref={ref} type="button" className="tl-edit" aria-label="Status" onClick={(e) => { stop(e); setOpen(o => !o); setAbandon(false); }}>
        <StatusBadge status={task.status} />
      </button>
      <Popover anchorRef={ref} open={open} onClose={close} width={abandon ? 240 : 190} {...contain}>
        {!abandon ? <>
          {SETTABLE_STATUSES.map(s => (
            <button key={s.key} type="button" className={'menu-item' + (task.status === s.key ? ' active' : '')} onClick={() => { onSet(s.key); close(); }}>
              <span className="si" style={{ background: s.color }} />{s.label}
              {task.status === s.key && <span className="ck"><Check size={14} /></span>}
            </button>
          ))}
          <div className="tl-pop-sep" />
          <button type="button" className="menu-item" style={{ color: 'var(--st-abandon)' }} onClick={() => { setAbandon(true); setReason(''); }}>
            <Ban size={14} /> Abandon…
          </button>
        </> : (
          <AbandonForm reason={reason} setReason={setReason} onCancel={() => setAbandon(false)} onSubmit={doAbandon} />
        )}
      </Popover>
    </>
  );
}

export function AbandonForm({ reason, setReason, onCancel, onSubmit }) {
  return (
    <div className="tl-pop-form">
      <div className="tl-pop-title">Abandon task</div>
      <input className="reason-input" style={{ marginTop: 0 }} placeholder="Reason (required, logged)" autoFocus value={reason}
        onChange={e => setReason(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') onSubmit(); }} />
      <div className="tl-pop-actions">
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button variant="danger" size="sm" disabled={!reason.trim()} onClick={onSubmit}>Abandon</Button>
      </div>
    </div>
  );
}

/* ---------------- Priority (flag) ---------------- */
export function PriorityFlag({ priority }) {
  const p = PRIORITY_MAP[priority] || { short: priority, color: 'var(--text-3)' };
  return (
    <span className="tl-pri" title={p.label} style={{ color: p.color }}>
      <Flag size={13} strokeWidth={2} fill={priority === 'P0' || priority === 'P1' ? 'currentColor' : 'none'} aria-hidden />
      {p.short || priority}
    </span>
  );
}

/* ---------------- Deadline (first set, or revise with a required reason) ---------------- */
export function DeadlineCell({ task, editable, onFirstSet, onRevise }) {
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(null);
  const [reason, setReason] = useState('');
  const eff = effectiveDeadline(task);
  const st = deadlineState(task);
  function start(e) { stop(e); setDraft(eff); setReason(''); setOpen(true); }
  async function commit() {
    if (!draft) return;
    if (task.deadline) { if (!reason.trim()) return; await onRevise(task, draft, reason.trim()); }
    else { await onFirstSet(draft); }
    setOpen(false);
  }
  // A closed task's deadline is history, not a countdown: show the date, not "153d overdue".
  const closed = task.status === 'done' || task.status === 'abandoned';
  const label = eff ? (closed ? fmtShortDate(eff) : relDeadline(eff)) : '';
  const body = eff ? (
    <span className={'tl-dl ' + st}>
      {st === 'over' && <AlertTriangle size={12} strokeWidth={2} aria-label="Overdue" />}
      <span className="tl-dl-tx">{label}</span>
      {task.revised_deadline && <span className="tl-rev" title="Deadline revised">REV</span>}
    </span>
  ) : null;
  if (!editable) return body;
  return (
    <span ref={ref} className="tl-dl-wrap">
      {eff
        ? <button type="button" className="tl-edit" aria-label={`Deadline ${label}`} onClick={start}>{body}</button>
        : <GhostCell icon={CalendarPlus} label="Set deadline" className="tl-ghost" onClick={start} />}
      <AnchoredPopover anchorRef={ref} open={open} onClose={() => setOpen(false)} align="right">
        <div {...contain}>
          <DatePicker value={draft} onChange={setDraft} autoFocus />
          {task.deadline && <input className="reason-input" placeholder="Reason (required, logged)" value={reason} onChange={e => setReason(e.target.value)} />}
          <div className="tl-pop-actions">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" size="sm" icon={Check} disabled={!draft || (!!task.deadline && !reason.trim())} onClick={commit}>{task.deadline ? 'Revise' : 'Set'}</Button>
          </div>
        </div>
      </AnchoredPopover>
    </span>
  );
}
