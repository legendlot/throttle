'use client';
// Group header + group-foot capture for the /tasks list (ClickUp redesign P3).
// Header (36px): caret · pill (status-tinted when grouped by status, neutral + dot
// otherwise) · count · ⋯ · "+ Add task". The foot capture (`data-group-capture`)
// creates the task with that group's value prefilled; `c` on a focused row lands here.
// NewTaskCapture is the ONE un-prefilled capture (`data-create-primary`): + Task, the
// top-bar + New, and `c` with no row focused open it — so a new task never silently
// inherits a group's owner / team / program / status.
import { useRef, useState } from 'react';
import { cx } from '../ui/util.js';
import { ChevronDown, MoreHorizontal, Plus, ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import { Pill, Menu, MenuItem, MenuSeparator, Kbd, Button } from '../ui/index.js';

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
        <span className="tl-gcount">{group.rows.length}</span>
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

// Inline "+ Add task" at a group's foot. `create(title)` does the write (the page
// maps the group's value onto the createTask body) and returns a promise.
export function FootCapture({ create, placeholder = 'Add task', groupKey, children }) {
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const ref = useRef(null);
  const has = !!title.trim();
  async function add() {
    const t = title.trim();
    if (!t || saving) return;
    setSaving(true);
    try { const ok = await create(t); if (ok !== false) { setTitle(''); ref.current?.focus(); } }
    finally { setSaving(false); }
  }
  return (
    <div className="tl-foot" data-group-foot={groupKey}>
      <Plus className="tl-foot-plus" size={14} strokeWidth={2} aria-hidden />
      <input ref={ref} data-group-capture value={title} onChange={e => setTitle(e.target.value)} disabled={saving}
        onKeyDown={e => { if (e.key === 'Enter') add(); if (e.key === 'Escape') { setTitle(''); e.currentTarget.blur(); } }}
        placeholder={placeholder} aria-label={placeholder} />
      {!has && <Kbd className="tl-foot-kbd">c</Kbd>}
      {children}
      {(has || saving) && <Button variant={has ? 'primary' : 'neutral'} size="sm" onClick={add} disabled={!has} loading={saving}>Add</Button>}
    </div>
  );
}

// The un-prefilled "New task" row under the toolbar. Collapsed to nothing until it is
// focused (+ Task / + New / `c`) or holds text; Esc or blurring it empty hides it again
// (pure CSS: :focus-within / .has-text). `alwaysOpen` on an empty page. The input stays
// mounted in every state so focus survives the first create flipping empty → list.
export function NewTaskCapture({ create, placeholder = 'New task', alwaysOpen = false, children }) {
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const ref = useRef(null);
  const has = !!title.trim();
  async function add() {
    const t = title.trim();
    if (!t || saving) return;
    setSaving(true);
    try { const ok = await create(t); if (ok !== false) setTitle(''); }
    finally { setSaving(false); setTimeout(() => ref.current?.focus(), 0); }
  }
  return (
    <div className={cx('tl-new', (alwaysOpen || title) && 'open')}>
      <Plus className="tl-foot-plus" size={14} strokeWidth={2} aria-hidden />
      <input ref={ref} data-create-primary value={title} onChange={e => setTitle(e.target.value)} disabled={saving}
        tabIndex={alwaysOpen || title ? 0 : -1}
        onKeyDown={e => { if (e.key === 'Enter') add(); if (e.key === 'Escape') { setTitle(''); e.currentTarget.blur(); } }}
        placeholder={placeholder} aria-label={placeholder} />
      {children}
      <Button variant={has ? 'primary' : 'neutral'} size="sm" onClick={add} disabled={!has} loading={saving}>Add</Button>
    </div>
  );
}
