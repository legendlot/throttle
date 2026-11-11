'use client';
// Docket icon rail (ClickUp redesign P1, D2): the 64px global nav to the left of
// the context sidebar. 32×32 tiles, radius 8, 11px label under the icon; the active
// tile is the yellow-soft one. Bottom: Admin (docket_admin) + the avatar menu.
// Hidden ≤767px — the bottom tab bar (DocketTabBar) is its mobile twin.
import { useRef, useState } from 'react';
import { Target, ListTodo, UserCheck, ListChecks, NotebookPen, LayoutDashboard, BookOpen, Settings, Keyboard, LogOut } from 'lucide-react';
import { Tooltip, Menu, MenuItem, MenuLabel, MenuSeparator } from './ui/index.js';
import { personColor } from './primitives.js';

export const RAIL_ITEMS = [
  { key: 'plan',       label: 'Plan',       route: '/plan',            icon: Target },   // F9: everyone (register for super admins, own milestones otherwise)
  { key: 'tasks',      label: 'Tasks',      route: '/tasks',           icon: ListTodo },
  { key: 'mine',       label: 'My tasks',   route: '/tasks?lens=mine', icon: UserCheck },
  { key: 'checklist',  label: 'Checklist',  route: '/checklist',       icon: ListChecks },
  { key: 'scratchpad', label: 'Scratchpad', route: '/scratchpad',      icon: NotebookPen },
  { key: 'dashboard',  label: 'Dashboard',  route: '/dashboard',       icon: LayoutDashboard, requires: '_dashboard' },
  { key: 'manual',     label: 'Manual',     route: '/manual',          icon: BookOpen },
];

function RailTile({ item, active, onGo }) {
  const Icon = item.icon;
  return (
    <Tooltip content={item.label} side="bottom">
      <button type="button" className={'dkr-item' + (active ? ' active' : '')} aria-current={active ? 'page' : undefined}
        onClick={() => onGo(item.route)}>
        <span className="dkr-tile"><Icon size={17} strokeWidth={1.75} aria-hidden /></span>
        <span className="dkr-label">{item.label}</span>
      </button>
    </Tooltip>
  );
}

export function DocketRail({ railKey = '', canViewDashboard = false, isAdmin = false, userLabel = '', userRole = '', userKey = '', onGo, onShortcuts, onSignOut }) {
  const avRef = useRef(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const items = RAIL_ITEMS.filter(it => it.requires !== '_dashboard' || canViewDashboard);
  return (
    <nav className="dkr" aria-label="Docket">
      <a className="dkr-mark" href="/tasks/" onClick={(e) => { e.preventDefault(); onGo('/tasks'); }} aria-label="Docket — Tasks">
        <img src="/favicon.svg" alt="" width={28} height={28} />
      </a>
      <div className="dkr-items">
        {items.map(it => <RailTile key={it.key} item={it} active={railKey === it.key} onGo={onGo} />)}
      </div>
      <div className="dkr-foot">
        {isAdmin && <RailTile item={{ key: 'admin', label: 'Admin', route: '/admin/roles', icon: Settings }} active={railKey === 'admin'} onGo={onGo} />}
        <button ref={avRef} type="button" className="dkr-avatar" aria-label="Account" aria-haspopup="menu"
          onClick={() => setMenuOpen(o => !o)} style={{ background: personColor(userKey || userLabel) }}>
          {(userLabel || '?').trim().charAt(0).toUpperCase()}
        </button>
        <Menu anchorRef={avRef} open={menuOpen} onClose={() => setMenuOpen(false)} width={220} label="Account">
          <MenuLabel>
            <span className="dkr-menu-name">{userLabel}</span>
            {userRole && <span className="dkr-menu-role">{userRole}</span>}
          </MenuLabel>
          <MenuSeparator />
          <MenuItem icon={Keyboard} shortcut="?" onClick={onShortcuts}>Keyboard shortcuts</MenuItem>
          <MenuItem icon={LogOut} danger onClick={onSignOut}>Sign out</MenuItem>
        </Menu>
      </div>
    </nav>
  );
}

export default DocketRail;
