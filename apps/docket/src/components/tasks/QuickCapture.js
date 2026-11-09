'use client';
// Capture that lands complete (Docket F2). Every task capture row — the top
// [data-create-primary] row, each group foot, Board's column "+ Add task" — reads quick-add
// tokens from the title (lib/quickAdd.js: @name, !p1, fri 5pm …) and offers Owner ·
// Deadline · Priority chips. One chip per kind:
//   · a picked value (explicit) wins over a parsed token;
//   · a parsed token shows as a chip; × un-chips it — the word stays in the title as text;
//   · nothing yet → a ghost chip that opens the picker.
// The page passes the result to createInGroup(title, field, value, extras), so a chosen
// value also wins over the group's prefill.
import { createContext, useContext, useMemo, useRef, useState } from 'react';
import { User, CalendarPlus, Flag, X } from 'lucide-react';
import { Popover, Button } from '../ui/index.js';
import { OptionList } from '../primitives.js';
import { DatePicker } from '../DatePicker.js';
import { contain } from './TaskCells.js';
import { parseQuickAdd, fmtDeadlineLabel } from '../../lib/quickAdd.js';
import { PRIORITY_MAP } from '../../lib/tasks.js';

// people: the owner picker's employee list; ownerOpts / prioOpts: the cell pickers' options.
const CaptureContext = createContext({ people: [], ownerOpts: [], prioOpts: [] });
export const CaptureProvider = CaptureContext.Provider;

export const QUICK_ADD_HINT = 'try @name, fri 5pm, !p1';
// "New task — try @name, fri 5pm, !p1"; a placeholder that already explains itself gets " · hint".
// "…it's assigned to you" drops the @name part — it would contradict the placeholder.
export const withHint = (ph) => {
  const hint = /assigned to you/i.test(ph) ? 'try fri 5pm, !p1' : QUICK_ADD_HINT;
  return ph.includes('—') ? `${ph} · ${hint}` : `${ph} — ${hint}`;
};
// Chip / × / Add buttons: keep focus in the capture on mousedown. Safari/iOS don't focus a
// clicked button, so an empty capture would blur, hide its chips and swallow the click.
export const keepFocus = (e) => e.preventDefault();
// Enter submits — but not while an IME is composing (Hindi / Japanese keyboards).
export const isSubmitKey = (e) => e.key === 'Enter' && !e.nativeEvent?.isComposing;

const KIND_LIST = ['owner', 'deadline', 'priority'];
const FIELD = { owner: 'owner_employee_id', deadline: 'deadline', priority: 'priority' };

export function useQuickCapture() {
  const { people } = useContext(CaptureContext);
  const [title, setTitle] = useState('');
  const [picks, setPicks] = useState({});              // kind → value (explicit picker choice)
  const [ignore, setIgnore] = useState(() => new Set());
  const [openKind, setOpenKind] = useState(null);      // the chip whose picker is open
  // A picked kind is not parsed at all, so a token it replaced goes back into the title
  // ("Meet fri 5pm" + a picked Mon deadline → title "Meet fri 5pm", deadline Mon).
  const off = useMemo(() => new Set(KIND_LIST.filter(k => picks[k])), [picks]);
  const parse = (now, offKinds = off) => parseQuickAdd(title, { people, now, ignore, off: offKinds });
  // Live chips re-parse on each keystroke; submit re-parses with a fresh clock (result()).
  const parsed = useMemo(() => parse(new Date()), [title, people, ignore, off]); // eslint-disable-line react-hooks/exhaustive-deps
  const tokenOf = (kind, from = parsed) => from.tokens.find(t => t.kind === kind) || null;

  function valueOf(kind) {
    if (picks[kind]) return { value: picks[kind], source: 'pick' };
    const t = tokenOf(kind);
    return t ? { value: parsed[FIELD[kind]], source: 'parsed', token: t } : null;
  }
  // × on a chip: drop the pick AND stop parsing that kind's words (they stay in the title as
  // text) — including a token the pick had displaced, so it doesn't pop back as a chip.
  function clear(kind) {
    const t = tokenOf(kind, parse(new Date(), new Set()));
    setPicks(p => ({ ...p, [kind]: undefined }));
    if (t) setIgnore(s => { const n = new Set(s); t.raw.toLowerCase().split(/\s+/).forEach(w => n.add(w)); return n; });
  }
  function pick(kind, value) { setPicks(p => ({ ...p, [kind]: value || undefined })); }
  function reset() { setTitle(''); setPicks({}); setIgnore(new Set()); setOpenKind(null); }
  // The create payload: the cleaned title + whichever of owner / deadline / priority is set.
  // Re-parsed NOW (the live parse is from the last keystroke): a parsed deadline that has
  // since slipped into the past re-resolves ("5pm" → tomorrow) or, if it can't, is dropped.
  function result() {
    const fresh = parse(new Date());
    const extras = {};
    for (const k of KIND_LIST) {
      const v = picks[k] || fresh[FIELD[k]];
      if (v) extras[FIELD[k]] = v;
    }
    if (!picks.deadline && extras.deadline && new Date(extras.deadline) <= new Date()) delete extras.deadline;
    return { title: (fresh.title || '').trim(), extras };
  }
  function onTitle(v) { setTitle(v); if (!v) setIgnore(new Set()); }
  const hasExtras = KIND_LIST.some(k => valueOf(k));
  return { title, setTitle: onTitle, parsed, valueOf, pick, clear, reset, result, openKind, setOpenKind,
    active: !!title || hasExtras || !!openKind };
}

const KINDS = [
  { kind: 'owner', icon: User, empty: 'Owner' },
  { kind: 'deadline', icon: CalendarPlus, empty: 'Deadline' },
  { kind: 'priority', icon: Flag, empty: 'Priority' },
];

export function CaptureChips({ qc, disabled }) {
  return (
    <span className="qc-chips" role="group" aria-label="Task details">
      {KINDS.map(k => <Chip key={k.kind} qc={qc} {...k} disabled={disabled} />)}
    </span>
  );
}

function Chip({ qc, kind, icon: Icon, empty, disabled }) {
  const { people, ownerOpts, prioOpts } = useContext(CaptureContext);
  const ref = useRef(null);
  const v = qc.valueOf(kind);
  const open = qc.openKind === kind;
  const [draft, setDraft] = useState(null);           // deadline picker: the value being picked
  let label = empty;
  if (v) {
    if (kind === 'owner') label = (v.token && v.source === 'parsed') ? v.token.label : (people.find(p => p.id === v.value)?.full_name || 'Owner');
    else if (kind === 'deadline') label = fmtDeadlineLabel(v.value);
    else label = PRIORITY_MAP[v.value]?.short || v.value;
  }
  const close = () => qc.setOpenKind(null);
  function toggle() {
    if (open) { close(); return; }
    if (kind === 'deadline') setDraft(v?.value || null);
    qc.setOpenKind(kind);
  }
  return (
    <span className={'qc-chip' + (v ? ' set' : '') + (v?.source === 'parsed' ? ' parsed' : '')}>
      <button ref={ref} type="button" className="qc-chip-btn" disabled={disabled} aria-haspopup="dialog" aria-expanded={open} onMouseDown={keepFocus}
        aria-label={v ? `${empty}: ${label}${v.source === 'parsed' ? ' (from the title)' : ''}` : `Set ${empty.toLowerCase()}`}
        onClick={toggle}>
        <Icon size={12} strokeWidth={2} aria-hidden /><span className="qc-chip-l">{label}</span>
      </button>
      {v && <button type="button" className="qc-chip-x" disabled={disabled} onMouseDown={keepFocus} aria-label={`Remove ${empty.toLowerCase()}`} onClick={() => qc.clear(kind)}><X size={11} strokeWidth={2} aria-hidden /></button>}
      <Popover anchorRef={ref} open={open} onClose={close} width={kind === 'deadline' ? 280 : 220} className={'qc-pop' + (kind === 'deadline' ? ' qc-pop-date' : '')} {...contain}>
        {kind === 'owner' && <OptionList label="Owner" options={ownerOpts} value={v?.value || ''} searchable onPick={(val) => { qc.pick('owner', val); close(); ref.current?.focus(); }} />}
        {kind === 'priority' && <OptionList label="Priority" options={prioOpts} value={v?.value || ''} onPick={(val) => { qc.pick('priority', val); close(); ref.current?.focus(); }} />}
        {kind === 'deadline' && <>
          <DatePicker value={draft} onChange={setDraft} autoFocus />
          <div className="tl-pop-actions">
            {v && <Button variant="ghost" size="sm" onClick={() => { qc.clear('deadline'); close(); ref.current?.focus(); }}>Clear</Button>}
            <Button variant="primary" size="sm" disabled={!draft} onClick={() => { qc.pick('deadline', draft); close(); ref.current?.focus(); }}>Set deadline</Button>
          </div>
        </>}
      </Popover>
    </span>
  );
}
