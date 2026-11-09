'use client';
// The RecurrenceEditor in a ui-kit Popover (ClickUp redesign P7). Two uses:
//  · a draft field (create form, template editor): the trigger shows the summary,
//    edits apply live to the draft, "Done" closes;
//  · a direct write (`onSave`): edits stay local until Save, Cancel/Esc/outside
//    click discards them. The write itself is the caller's, unchanged.
import { useRef, useState } from 'react';
import { Repeat, Check } from 'lucide-react';
import { Popover, Button } from './ui/index.js';
import { RecurrenceEditor } from './RecurrenceEditor.js';
import { recurrenceSummary, templateRecurrenceSummary } from '../lib/recurrence.js';

export function RecurrencePopover({ value, onChange, onSave, hideTime = false, busy = false, valid = () => true, trigger, label = 'Schedule', align = 'left' }) {
  const anchor = useRef(null);
  const [open, setOpen] = useState(false);
  const [local, setLocal] = useState(null);
  const direct = !!onSave;
  const cur = direct ? (local || value) : value;
  const summary = (hideTime ? templateRecurrenceSummary : recurrenceSummary)(value);

  function show() { setLocal(value || null); setOpen(true); }
  function close() { setOpen(false); setLocal(null); }
  async function save() {
    const ok = await onSave(cur);
    if (ok !== false) close();
  }

  return (
    <>
      {trigger ? trigger({ ref: anchor, open, onClick: () => (open ? close() : show()) }) : (
        <button ref={anchor} type="button" className="cl-recbtn" aria-haspopup="dialog" aria-expanded={open} aria-label={`${label}: ${summary}`}
          onClick={() => (open ? close() : show())}>
          <Repeat size={13} aria-hidden /> <span>{summary}</span>
        </button>
      )}
      <Popover anchorRef={anchor} open={open} onClose={close} align={align} width={360} className="cl-recpop" role="dialog" aria-label={label}>
        <RecurrenceEditor value={cur} hideTime={hideTime} onChange={r => (direct ? setLocal(r) : onChange(r))} />
        <div className="cl-recpop-actions">
          {direct ? <>
            <Button variant="ghost" size="sm" onClick={close}>Cancel</Button>
            <Button variant="primary" size="sm" icon={Check} loading={busy} disabled={!valid(cur)} onClick={save}>Save</Button>
          </> : <Button variant="neutral" size="sm" onClick={close}>Done</Button>}
        </div>
      </Popover>
    </>
  );
}
export default RecurrencePopover;
