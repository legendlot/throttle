'use client';
// Docket-local sidebar. Replaces the shared @throttle/ui Sidebar for Docket ONLY
// (the shared one stays byte-for-byte for Garage/Redline). New visual language:
// 248/64px collapse, soft-pill active state, grouped nav, space colour-dots, a
// primary "New task" button, and a user footer with sign-out.
import { LayoutDashboard, ListChecks, ListTodo, Plus, NotebookPen, BookOpen, Settings, ChevronLeft, LogOut } from 'lucide-react';
import { Avatar, personColor } from './primitives.js';

function NavItem({ icon: Ic, label, active, collapsed, onClick, sub, dot, dashed }) {
  return (
    <div className={'sb-item' + (active ? ' active' : '') + (sub ? ' sub' : '')}
      role="button" tabIndex={0} title={collapsed ? label : undefined} onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}>
      {sub
        ? <span className="dot" style={dashed ? { background: 'transparent', border: '1px dashed var(--border-strong)' } : { background: dot }} />
        : <Ic className="ic" size={17} strokeWidth={1.75} />}
      <span className="label">{label}</span>
    </div>
  );
}

export function DocketSidebar({
  activeKey = '', spaces = [], canViewDashboard = false, isAdmin = false,
  collapsed, onToggle, onSelect, onNewTask, userLabel = '', userRole = '', onSignOut,
}) {
  const privates = (spaces || []).filter(s => s.is_private);
  const mySpaces = privates.filter(s => s.is_owner);
  const otherSpaces = privates.filter(s => !s.is_owner);
  const go = (route) => () => onSelect(route);
  const isAdminActive = activeKey.startsWith('/admin');
  const startsWith = (p) => activeKey === p || activeKey.startsWith(p + '/');

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

        {/* Spaces, grouped for clarity: Common (General = the org-wide all-tasks board,
            returned by the worker when no space_id is set), then the caller's own private
            spaces, then private spaces others added them to. */}
        <div className="sb-group-label">Common</div>
        <NavItem sub dot="var(--text-4)" label="General" collapsed={collapsed} active={activeKey === '/tasks'} onClick={go('/tasks')} />

        <div className="sb-group-label">My spaces</div>
        {mySpaces.map(s => (
          <NavItem key={s.id} sub dot={personColor(s.id)} label={s.name} collapsed={collapsed}
            active={activeKey === '/tasks?space=' + s.id} onClick={go('/tasks?space=' + s.id)} />
        ))}
        <NavItem sub dashed label="New space" collapsed={collapsed} active={false} onClick={go('/tasks?space=new')} />

        {otherSpaces.length > 0 && <>
          <div className="sb-group-label">By others</div>
          {otherSpaces.map(s => (
            <NavItem key={s.id} sub dot={personColor(s.id)} label={s.name} collapsed={collapsed}
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
