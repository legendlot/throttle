'use client';
// Floating bulk-action pill (ClickUp redesign P3): "N selected ×" · Owner · Status ·
// Priority · Deadline · Collaborators · Move · Abandon (Program retired, F9 R9b). Same writes as
// before: field edits ride bulkUpdateTasks (onApply); collaborators / move /
// abandon have their own handlers (S153). Same audit prompts: the deadline reason
// (required by the worker when any selected task already has one) and the abandon
// reason (always required).
import { useRef, useState } from 'react';
import { X, Users, Check, Flag, Calendar, UserPlus, FolderInput, Ban } from 'lucide-react';
import { OptionList } from '../primitives.js';
import { DatePicker } from '../DatePicker.js';
import { Popover, Button, SegmentedTabs } from '../ui/index.js';
import { SETTABLE_STATUSES } from '../../lib/tasks.js';

function BarButton({ id, icon: Icon, label, menu, toggle, refs, danger }) {
  return (
    <button ref={el => { refs.current[id] = el; }} type="button" className={'bb-btn' + (menu === id ? ' on' : '') + (danger ? ' danger' : '')}
      aria-haspopup="dialog" aria-expanded={menu === id} onClick={() => toggle(id)}>
      <Icon size={14} aria-hidden /><span className="bb-lbl">{label}</span>
    </button>
  );
}

export function BulkBar({ count, onClear, onApply, ownerOpts, prioOpts, empOpts = [], spaceOpts = [], onCollaborator, onMove, onAbandon }) {
  const [menu, setMenu] = useState(null);
  const [draft, setDraft] = useState(null);
  const [reason, setReason] = useState('');
  const refs = useRef({});
  const anchor = useRef(null);
  anchor.current = menu ? refs.current[menu] : null;
  function close() { setMenu(null); setDraft(null); setReason(''); }
  function go(field, value, r) { onApply(field, value, r); close(); }
  const toggle = (m) => { setDraft(null); setReason(''); setMenu(cur => (cur === m ? null : m)); };
  const b = { menu, toggle, refs };

  return (
    <div className="bulk-bar" role="toolbar" aria-label="Bulk actions">
      <span className="bb-count">{count} selected
        <button type="button" className="bb-x" aria-label="Clear selection" onClick={onClear}><X size={13} /></button>
      </span>
      <span className="bb-sep" />
      <BarButton id="owner" icon={Users} label="Owner" {...b} />
      <BarButton id="status" icon={Check} label="Status" {...b} />
      <BarButton id="priority" icon={Flag} label="Priority" {...b} />
      <BarButton id="deadline" icon={Calendar} label="Deadline" {...b} />
      <BarButton id="collab" icon={UserPlus} label="Collaborators" {...b} />
      <BarButton id="space" icon={FolderInput} label="Move" {...b} />
      <BarButton id="abandon" icon={Ban} label="Abandon" danger {...b} />

      <Popover key={menu || "none"} anchorRef={anchor} open={!!menu} onClose={close} width={menu === 'deadline' ? 264 : menu === 'abandon' || menu === 'collab' ? 260 : 220} className="bb-pop">
        {menu === 'owner' && <OptionList options={ownerOpts} searchable onPick={(v) => go('owner_employee_id', v)} />}
        {menu === 'status' && SETTABLE_STATUSES.map(s => (
          <button key={s.key} type="button" className="menu-item" onClick={() => go('status', s.key)}>
            <span className="si" style={{ background: s.color }} />{s.label}
          </button>
        ))}
        {menu === 'priority' && prioOpts.map(p => <button key={p.value} type="button" className="menu-item" onClick={() => go('priority', p.value)}>{p.label}</button>)}
        {menu === 'deadline' && (
          <div className="tl-pop-form">
            <DatePicker value={draft} onChange={setDraft} autoFocus />
            <input className="reason-input" placeholder="Reason (required if any already has a deadline)" value={reason} onChange={e => setReason(e.target.value)} />
            <div className="tl-pop-actions">
              <Button variant="ghost" size="sm" onClick={close}>Cancel</Button>
              <Button variant="primary" size="sm" icon={Check} disabled={!draft} onClick={() => go('deadline', draft, reason.trim() || undefined)}>Set</Button>
            </div>
          </div>
        )}
        {/* Collaborators: child table, so not onApply. Add vs remove is chosen explicitly —
            a single tap list would make "remove" unreachable. */}
        {menu === 'collab' && (
          <div className="tl-pop-form">
            <SegmentedTabs label="Add or remove" value={draft === 'remove' ? 'remove' : 'add'} onChange={setDraft}
              tabs={[{ value: 'add', label: 'Add' }, { value: 'remove', label: 'Remove' }]} />
            <OptionList options={empOpts} searchable onPick={(v) => { onCollaborator(v, draft === 'remove' ? 'remove' : 'add'); close(); }} />
          </div>
        )}
        {/* Move to space — sub-tasks follow their parent, handled worker-side. */}
        {menu === 'space' && <OptionList options={spaceOpts} searchable onPick={(v) => { onMove(v); close(); }} />}
        {/* Abandon: terminal, so a reason is mandatory exactly as on a single task.
            bulkUpdateTasks deliberately refuses status='abandoned'. */}
        {menu === 'abandon' && (
          <div className="tl-pop-form">
            <div className="tl-pop-sub">Terminal. The same reason is recorded on every selected task.</div>
            <input className="reason-input" placeholder="Reason (required)" value={reason} autoFocus onChange={e => setReason(e.target.value)} />
            <div className="tl-pop-actions">
              <Button variant="ghost" size="sm" onClick={close}>Cancel</Button>
              <Button variant="danger" size="sm" disabled={!reason.trim()} onClick={() => { const r = reason.trim(); close(); onAbandon(r); }}>Abandon</Button>
            </div>
          </div>
        )}
      </Popover>
    </div>
  );
}

export default BulkBar;
