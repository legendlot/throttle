'use client';
// Mobile (≤767px) bottom tab bar — the icon rail's twin (ClickUp redesign P1).
// Tasks · My tasks · Checklist · Dashboard (or Scratchpad without the dashboard perm) ·
// More; More holds the rest of the rail (Plan first, then Scratchpad, Manual, Admin per perms) +
// Shortcuts + Sign out.
// Programs + Spaces live in the slide-over sidebar (top-bar menu button).
import { useRef, useState } from 'react';
import { Menu as MenuIcon, Target, NotebookPen, BookOpen, Settings, Keyboard, LogOut } from 'lucide-react';
import { Menu, MenuItem, MenuSeparator, MenuLabel } from './ui/index.js';
import { RAIL_ITEMS } from './DocketRail.js';


export function DocketTabBar({ railKey = '', canViewDashboard = false, isAdmin = false, userLabel = '', userRole = '', onGo, onShortcuts, onSignOut }) {
  const moreRef = useRef(null);
  const [moreOpen, setMoreOpen] = useState(false);
  // 4th tab: Dashboard for those who can see it (Scratchpad moves into More), else Scratchpad.
  const fourth = canViewDashboard ? 'dashboard' : 'scratchpad';
  const tabs = RAIL_ITEMS.filter(it => ['tasks', 'mine', 'checklist', fourth].includes(it.key));
  const moreActive = !tabs.some(t => t.key === railKey) && !!railKey;
  return (
    <nav className="dkm-tabbar" aria-label="Docket">
      {tabs.map((t) => {
        const Icon = t.icon;
        const on = railKey === t.key;
        return (
          <button key={t.key} type="button" className={`dkm-tab${on ? ' active' : ''}`} aria-current={on ? 'page' : undefined} onClick={() => onGo(t.route)}>
            <Icon size={19} strokeWidth={on ? 2 : 1.75} aria-hidden />
            <span>{t.label}</span>
          </button>
        );
      })}
      <button ref={moreRef} type="button" className={`dkm-tab${moreOpen || moreActive ? ' active' : ''}`} aria-haspopup="menu"
        onClick={() => setMoreOpen(o => !o)}>
        <MenuIcon size={19} strokeWidth={moreOpen ? 2 : 1.75} aria-hidden />
        <span>More</span>
      </button>
      <Menu anchorRef={moreRef} open={moreOpen} onClose={() => setMoreOpen(false)} align="right" width={220} label="More" className="dk-pop-top">
        {userLabel && <MenuLabel>{userLabel}{userRole ? ` · ${userRole}` : ''}</MenuLabel>}
        <MenuItem icon={Target} selected={railKey === 'plan'} onClick={() => onGo('/plan')}>Plan</MenuItem>
        {canViewDashboard && <MenuItem icon={NotebookPen} selected={railKey === 'scratchpad'} onClick={() => onGo('/scratchpad')}>Scratchpad</MenuItem>}
        <MenuItem icon={BookOpen} selected={railKey === 'manual'} onClick={() => onGo('/manual')}>Manual</MenuItem>
        {isAdmin && <MenuItem icon={Settings} selected={railKey === 'admin'} onClick={() => onGo('/admin/roles')}>Admin</MenuItem>}
        <MenuSeparator />
        <MenuItem icon={Keyboard} onClick={onShortcuts}>Keyboard shortcuts</MenuItem>
        <MenuItem icon={LogOut} danger onClick={onSignOut}>Sign out</MenuItem>
      </Menu>
    </nav>
  );
}

export default DocketTabBar;
