'use client';
// Group header + group-foot capture for the /tasks list (ClickUp redesign P3).
// Header (36px): caret · pill (status-tinted when grouped by status, neutral + dot
// otherwise) · count · ⋯ · "+ Add task". The foot capture (`data-group-capture`)
// creates the task with that group's value prefilled; `c` on a focused row lands here.
// NewTaskCapture is the ONE un-prefilled capture (`data-create-primary`): + Task, the
// top-bar + New, and `c` with no row focused open it — so a new task never silently
// inherits a group's owner / team / program / status.
import { useEffect, useRef, useState } from 'react';
import { cx } from '../ui/util.js';
import { ChevronDown, MoreHorizontal, Plus, ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import { Pill, Menu, MenuItem, MenuSeparator, Kbd, Button } from '../ui/index.js';
import { useQuickCapture, CaptureChips, withHint, keepFocus, isSubmitKey } from './QuickCapture.js';

export function GroupHeader({ group, collapsed, onToggle, onAdd, onCollapseAll, onExpandAll, variant }) {
  const menuRef = useRef(null);
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className={'tl-ghead' + (collapsed ? ' collapsed' : '') + (variant ? ' ' + variant : '')}>
      <button type="button" className="tl-ghead-toggle" aria-expanded={!collapsed} onClick={onToggle}>
        <ChevronDown className="tl-caret" size={14} strokeWidth={2} aria-hidden />
        {group.tone === 'status'
          ? <Pill tone="status" color={group.color} dot>{group.label}</Pill>
          : <Pill dot={!!group.color} color={group.color} icon={group.icon}>{group.label}</Pill>}
        <span className="tl-gcount">{group.count ?? group.rows.length}</span>
        {group.hint && <span className="tl-ghint">{group.hint}</span>}
      </button>
      {(onCollapseAll || onExpandAll) && <>
        <button ref={menuRef} type="button" className="tl-act tl-ghead-more" aria-label="Group actions" aria-haspopup="menu"
          onClick={() => setMenuOpen(o => !o)}><MoreHorizontal size={14} /></button>
        <Menu anchorRef={menuRef} open={menuOpen} onClose={() => setMenuOpen(false)} width={190} label="Group actions">
          <MenuItem icon={collapsed ? ChevronsUpDown : ChevronsDownUp} onClick={onToggle}>{collapsed ? 'Expand group' : 'Collapse group'}</MenuItem>
          <MenuSeparator />
          {onCollapseAll && <MenuItem icon={ChevronsDownUp} onClick={onCollapseAll}>Collapse all groups</MenuItem>}
          {onExpandAll && <MenuItem icon={ChevronsUpDown} onClick={onExpandAll}>Expand all groups</MenuItem>}
        </Menu>
      </>}
      {onAdd && (
        <button type="button" className="tl-ghead-add" onClick={onAdd}><Plus size={13} strokeWidth={2} aria-hidden />Add task</button>
      )}
    </div>
  );
}

// Inline "+ Add task" at a group's foot. `create(title, extras)` does the write (the page
// maps the group's value onto the createTask body, then extras {owner_employee_id, deadline,
// priority} from the quick-add tokens / chips over it) and returns a promise. F2: the chips
// show while the row is focused or holds something (QuickCapture.js).
export function FootCapture({ create, placeholder = 'Add task', groupKey, children }) {
  const qc = useQuickCapture();
  const [saving, setSaving] = useState(false);
  const ref = useRef(null);
  const has = !!qc.title.trim();
  async function add() {
    if (!has || saving) return;
    const { title, extras } = qc.result();
    setSaving(true);
    try { const ok = await create(title, extras); if (ok !== false) { qc.reset(); refocus.current = true; } }
    finally { setSaving(false); }
  }
  // Re-focus for the next one only once the input is enabled again (a disabled input drops focus).
  const refocus = useRef(false);
  useEffect(() => { if (!saving && refocus.current) { refocus.current = false; ref.current?.focus(); } }, [saving]);
  return (
    <div className={cx('tl-foot', 'qc-host', qc.active && 'qc-on')} data-group-foot={groupKey}>
      <Plus className="tl-foot-plus" size={14} strokeWidth={2} aria-hidden />
      <input ref={ref} data-group-capture value={qc.title} onChange={e => qc.setTitle(e.target.value)} disabled={saving}
        onKeyDown={e => { if (isSubmitKey(e)) add(); if (e.key === 'Escape') { qc.reset(); e.currentTarget.blur(); } }}
        placeholder={withHint(placeholder)} aria-label={placeholder} />
      {!has && !qc.active && <Kbd className="tl-foot-kbd">c</Kbd>}
      <CaptureChips qc={qc} disabled={saving} />
      {children}
      {(has || saving) && <Button variant={has ? 'primary' : 'neutral'} size="sm" onMouseDown={keepFocus} onClick={add} disabled={!has} loading={saving}>Add</Button>}
    </div>
  );
}

// The un-prefilled "New task" row under the toolbar. Collapsed to nothing until it is
// focused (+ Task / + New / `c`) or holds text; Esc or blurring it empty hides it again
// (pure CSS: :focus-within / .open). `alwaysOpen` on an empty page. The input stays
// mounted in every state so focus survives the first create flipping empty → list.
// F2: also held open while a chip is set or its picker is open (the picker portals, so
// :focus-within alone would collapse the row under it).
export function NewTaskCapture({ create, placeholder = 'New task', alwaysOpen = false, children }) {
  const qc = useQuickCapture();
  const [saving, setSaving] = useState(false);
  const ref = useRef(null);
  const has = !!qc.title.trim();
  async function add() {
    if (!has || saving) return;
    const { title, extras } = qc.result();
    setSaving(true);
    try { const ok = await create(title, extras); if (ok !== false) qc.reset(); }
    finally { setSaving(false); setTimeout(() => ref.current?.focus(), 0); }
  }
  const open = alwaysOpen || qc.active;
  return (
    <div className={cx('tl-new', 'qc-host', open && 'open', qc.active && 'qc-on')}>
      <Plus className="tl-foot-plus" size={14} strokeWidth={2} aria-hidden />
      <input ref={ref} data-create-primary value={qc.title} onChange={e => qc.setTitle(e.target.value)} disabled={saving}
        tabIndex={open ? 0 : -1}
        onKeyDown={e => { if (isSubmitKey(e)) add(); if (e.key === 'Escape') { qc.reset(); e.currentTarget.blur(); } }}
        placeholder={withHint(placeholder)} aria-label={placeholder} />
      <CaptureChips qc={qc} disabled={saving} />
      {children}
      <Button variant={has ? 'primary' : 'neutral'} size="sm" onMouseDown={keepFocus} onClick={add} disabled={!has} loading={saving}>Add</Button>
    </div>
  );
}
