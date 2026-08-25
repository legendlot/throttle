'use client';
// Docket-local sidebar. Replaces the shared @throttle/ui Sidebar for Docket ONLY
// (the shared one stays byte-for-byte for Garage/Redline). New visual language:
// 248/64px collapse, soft-pill active state, grouped nav, space colour-dots, a
// primary "New task" button, and a user footer with sign-out.
//
// Collapsible nav groups (S138): Programs / My spaces / By others fold from their
// header (chevron). Per-group open state is persisted per person in localStorage
// (`docket.nav.collapsed`); Programs defaults open, the two space groups default
// closed. Override: a group always renders open when it contains the active item.
import { useState, useEffect, useCallback } from 'react';
import { LayoutDashboard, ListChecks, ListTodo, Plus, NotebookPen, BookOpen, Settings, ChevronLeft, ChevronDown, LogOut } from 'lucide-react';
import { Avatar, personColor } from './primitives.js';

const DEFAULT_COLLAPSED = { programs: false, mySpaces: true, otherSpaces: true };

function NavItem({ icon: Ic, label, active, collapsed, onClick, sub, dot, dashed, count }) {
  return (
    <div className={'sb-item' + (active ? ' active' : '') + (sub ? ' sub' : '')}
      role="button" tabIndex={0} title={collapsed ? label : undefined} onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}>
      {sub
        ? <span className="dot" style={dashed ? { background: 'transparent', border: '1px dashed var(--border-strong)' } : { background: dot }} />
        : <Ic className="ic" size={17} strokeWidth={1.75} />}
      <span className="label">{label}</span>
      {count != null && <span className="count">{count}</span>}
    </div>
  );
}

// A collapsible group header. In the icon-rail (collapsed) sidebar it degrades to a
// plain centered label (no chevron, children always shown — there's no room to expand).
function GroupLabel({ label, open, collapsed, onToggle }) {
  if (collapsed) return <div className="sb-group-label">{label}</div>;
  return (
    <button type="button" className={'sb-group-label btn' + (open ? '' : ' closed')} onClick={onToggle}>
      <span>{label}</span>
      <ChevronDown className="chev" size={13} strokeWidth={2} />
    </button>
  );
}

export function DocketSidebar({
  activeKey = '', spaces = [], programs = [], canViewDashboard = false, isAdmin = false,
  collapsed, onToggle, onSelect, onNewTask, userLabel = '', userRole = '', onSignOut,
}) {
  const privates = (spaces || []).filter(s => s.is_private);
  const mySpaces = privates.filter(s => s.is_owner);
  const otherSpaces = privates.filter(s => !s.is_owner);
  // General is the non-private (default) space. It carries a badge like any other
  // (S309); the worker omits task_count entirely when a space has no open work, so
  // `count` stays undefined and NavItem renders nothing rather than a "0".
  const general = (spaces || []).find(s => !s.is_private);
  const go = (route) => () => onSelect(route);
  const isAdminActive = activeKey.startsWith('/admin');
  const startsWith = (p) => activeKey === p || activeKey.startsWith(p + '/');

  // Persisted per-group collapse state.
  const [navCollapsed, setNavCollapsed] = useState({});
  useEffect(() => {
    try { setNavCollapsed(JSON.parse(localStorage.getItem('docket.nav.collapsed') || '{}')); } catch { /* ignore */ }
  }, []);
  const isGroupCollapsed = (key) => (key in navCollapsed ? navCollapsed[key] : DEFAULT_COLLAPSED[key]);
  const toggleGroup = useCallback((key) => {
    setNavCollapsed(prev => {
      const cur = (key in prev ? prev[key] : DEFAULT_COLLAPSED[key]);
      const next = { ...prev, [key]: !cur };
      try { localStorage.setItem('docket.nav.collapsed', JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // A group renders open if it's (default/manually) open OR it holds the active item;
  // in the icon-rail there's no expand affordance, so always show children.
  const programActive = activeKey.startsWith('/tasks?program=');
  const mySpaceActive = mySpaces.some(s => activeKey === '/tasks?space=' + s.id);
  const otherSpaceActive = otherSpaces.some(s => activeKey === '/tasks?space=' + s.id);
  const groupOpen = (key, hasActive) => collapsed || !isGroupCollapsed(key) || hasActive;

  return (
    <aside className={'sb' + (collapsed ? ' collapsed' : '')}>
      <div className="sb-head">
        <img className="sb-mark" src="/favicon.svg" alt="Docket"
          title={collapsed ? 'Expand sidebar  ( [ )' : undefined}
          onClick={collapsed ? onToggle : undefined} style={{ cursor: collapsed ? 'pointer' : 'default' }} />
        <div className="sb-word"><b>DOCKET</b><small>Task OS</small></div>
        <button className="sb-collapse" onClick={onToggle} title="Collapse sidebar  ( [ )" aria-label="Collapse sidebar"><ChevronLeft size={15} /></button>
      </div>

      <button className="sb-new" onClick={onNewTask} title={collapsed ? 'New task' : undefined}>
        <Plus size={16} strokeWidth={2} /><span>New task</span>
      </button>

      <div className="sb-scroll">
        <div className="sb-group-label">Work</div>
        {canViewDashboard && <NavItem icon={LayoutDashboard} label="Dashboard" collapsed={collapsed} active={startsWith('/dashboard')} onClick={go('/dashboard')} />}
        <NavItem icon={ListChecks} label="My tasks" collapsed={collapsed} active={activeKey === '/tasks?lens=mine'} onClick={go('/tasks?lens=mine')} />

        {/* Programs (S138): cross-space jump-to — every task tagged to the program, in any
            space you can access. Only programs you have visible tasks in are listed (counts). */}
        {programs.length > 0 && <>
          <GroupLabel label="Programs" collapsed={collapsed} open={groupOpen('programs', programActive)} onToggle={() => toggleGroup('programs')} />
          {groupOpen('programs', programActive) && programs.map(p => (
            <NavItem key={p.id} sub dot={p.color || personColor(p.id)} label={p.name} count={p.task_count} collapsed={collapsed}
              active={activeKey === '/tasks?program=' + p.id} onClick={go('/tasks?program=' + p.id)} />
          ))}
        </>}

        {/* Spaces, grouped for clarity: Common (General = the org-wide all-tasks board,
            returned by the worker when no space_id is set), then the caller's own private
            spaces, then private spaces others added them to. */}
        <div className="sb-group-label">Common</div>
        <NavItem sub dot="var(--text-4)" label="General" count={general?.task_count} collapsed={collapsed} active={activeKey === '/tasks'} onClick={go('/tasks')} />

        <GroupLabel label="My spaces" collapsed={collapsed} open={groupOpen('mySpaces', mySpaceActive)} onToggle={() => toggleGroup('mySpaces')} />
        {groupOpen('mySpaces', mySpaceActive) && <>
          {mySpaces.map(s => (
            <NavItem key={s.id} sub dot={personColor(s.id)} label={s.name} count={s.task_count} collapsed={collapsed}
              active={activeKey === '/tasks?space=' + s.id} onClick={go('/tasks?space=' + s.id)} />
          ))}
          <NavItem sub dashed label="New space" collapsed={collapsed} active={false} onClick={go('/tasks?space=new')} />
        </>}

        {otherSpaces.length > 0 && <>
          <GroupLabel label="By others" collapsed={collapsed} open={groupOpen('otherSpaces', otherSpaceActive)} onToggle={() => toggleGroup('otherSpaces')} />
          {groupOpen('otherSpaces', otherSpaceActive) && otherSpaces.map(s => (
            <NavItem key={s.id} sub dot={personColor(s.id)} label={s.name} count={s.task_count} collapsed={collapsed}
              active={activeKey === '/tasks?space=' + s.id} onClick={go('/tasks?space=' + s.id)} />
          ))}
        </>}

        <div className="sb-group-label">Personal</div>
        <NavItem icon={ListTodo} label="Checklist" collapsed={collapsed} active={startsWith('/checklist')} onClick={go('/checklist')} />
        <NavItem icon={NotebookPen} label="Scratchpad" collapsed={collapsed} active={startsWith('/scratchpad')} onClick={go('/scratchpad')} />

        <div className="sb-group-label">System</div>
        <NavItem icon={BookOpen} label="Manual" collapsed={collapsed} active={startsWith('/manual')} onClick={go('/manual')} />
        {isAdmin && <NavItem icon={Settings} label="Admin" collapsed={collapsed} active={isAdminActive} onClick={go('/admin/roles')} />}
      </div>

      <div className="sb-foot">
        <Avatar name={userLabel || '?'} size={32} />
        <div className="who"><div className="nm">{userLabel}</div><div className="rl">{userRole}</div></div>
        {onSignOut && <button className="signout" title="Sign out" onClick={onSignOut}><LogOut size={16} /></button>}
      </div>
    </aside>
  );
}

export default DocketSidebar;
