'use client';
// Docket top bar (ClickUp redesign P1): 40px, full width above the rail + sidebar.
// Left: sidebar toggle ( [ / ⌘\ ) + the route breadcrumb + the board count pill.
// Centre: the search trigger (focuses the page's [data-search-primary]; ⌘K is P6).
// Right: + New split (task / space / program), "?" shortcuts, Live dot, AppLauncher.
// ≤767px: menu button (slide-over sidebar) · last crumb · + (new task) · AppLauncher.
import { Fragment, useRef, useState } from 'react';
import { PanelLeft, Menu as MenuIcon, Lock, Search, Plus, FolderPlus, SquarePen, Flag } from 'lucide-react';
import { AppLauncher } from '@throttle/ui';
import { IconButton, SplitButton, Menu, MenuItem, Kbd } from './ui/index.js';

export function DocketTopbar({ crumbs = [], count, onCrumb, onToggleSidebar, onOpenMobileNav, onSearch, onNewTask, onNewSpace, onNewProgram, onHelp }) {
  const newRef = useRef(null);
  const [newOpen, setNewOpen] = useState(false);
  const last = crumbs[crumbs.length - 1];
  return (
    <header className="dkt">
      <div className="dkt-left">
        <span className="dkt-desk"><IconButton icon={PanelLeft} label="Toggle sidebar" shortcut={['[']} onClick={onToggleSidebar} /></span>
        <span className="dkt-mob"><IconButton icon={MenuIcon} label="Open navigation" onClick={onOpenMobileNav} /></span>
        <nav className="dkt-crumbs" aria-label="Breadcrumb">
          {crumbs.map((c, i) => {
            const isLast = i === crumbs.length - 1;
            return (
              <Fragment key={i}>
                {i > 0 && <span className="dkt-sep" aria-hidden>/</span>}
                {isLast
                  ? <span className="dkt-crumb current" aria-current="page">
                      {c.lock && <Lock size={12} strokeWidth={2} aria-label="Private space" />}
                      <span className="dkt-crumb-tx">{c.label}</span>
                    </span>
                  : c.href
                    ? <button type="button" className="dkt-crumb link" onClick={() => onCrumb?.(c.href)}>{c.label}</button>
                    : <span className="dkt-crumb">{c.label}</span>}
              </Fragment>
            );
          })}
        </nav>
        <span className="dkt-crumb-mob" aria-hidden>
          {last?.lock && <Lock size={12} strokeWidth={2} />}{last?.label}
        </span>
        {count != null && <span className="dkt-count">{count}</span>}
      </div>

      <button type="button" className="dkt-search" onClick={onSearch} aria-label="Search tasks">
        <Search size={14} strokeWidth={2} aria-hidden />
        <span className="dkt-search-ph">Search tasks…</span>
        <Kbd>/</Kbd>
      </button>

      <div className="dkt-right">
        <span className="dkt-desk">
          <SplitButton variant="primary" size="sm" icon={Plus} onMain={onNewTask}
            onMenu={() => setNewOpen(o => !o)} menuRef={newRef} menuLabel="More create options">New</SplitButton>
          <IconButton icon={<span className="dkt-q">?</span>} label="Keyboard shortcuts" shortcut="?" onClick={onHelp} />
          <span className="dkt-live"><span className="pulse" />Live</span>
        </span>
        <span className="dkt-mob"><IconButton icon={Plus} variant="primary" label="New task" onClick={onNewTask} /></span>
        <Menu anchorRef={newRef} open={newOpen} onClose={() => setNewOpen(false)} align="right" width={180} label="Create">
          <MenuItem icon={SquarePen} shortcut="c" onClick={onNewTask}>New task</MenuItem>
          <MenuItem icon={FolderPlus} onClick={onNewSpace}>New space</MenuItem>
          <MenuItem icon={Flag} onClick={onNewProgram}>New program</MenuItem>
        </Menu>
        <AppLauncher current="docket" />
      </div>
    </header>
  );
}

export default DocketTopbar;
