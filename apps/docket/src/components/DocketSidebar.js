'use client';
// Docket context sidebar (ClickUp redesign P1). Sits between the icon rail and the
// page; holds the hierarchy only — Plan, then Programs (a free cross-space label, kept alongside the
// plan link), then Spaces (General · My spaces · By others) — or, on an Admin route, the three admin pages.
//
// Collapsible sections (S138): per-section open state is persisted per person in
// localStorage (`docket.nav.collapsed`); Programs + Spaces default open, the two
// space sub-groups default closed. Override: a section always renders open when it
// holds the active row. "Customize sidebar" hides whole sections
// (`docket.nav.hidden`); a hidden section still shows while it holds the active row.
//
// ≤767px the same element becomes a slide-over (CSS: `.dks.mobile-open`).
import { useRef, useState, useEffect, useCallback } from 'react';
import { ChevronDown, Plus, Lock, MoreHorizontal, SlidersHorizontal, Check, Target } from 'lucide-react';
import { IconButton, Button, Menu, MenuItem, MenuLabel } from './ui/index.js';
import { personColor } from './primitives.js';
import { ADMIN_ITEMS } from '../lib/nav.js';

const DEFAULT_COLLAPSED = { programs: false, spaces: false, mySpaces: true, otherSpaces: true };
const HIDEABLE = [
  { key: 'programs',    label: 'Programs' },
  { key: 'mySpaces',    label: 'My spaces' },
  { key: 'otherSpaces', label: 'By others' },
];

function useStoredObject(key) {
  const [val, setVal] = useState({});
  useEffect(() => {
    try { setVal(JSON.parse(localStorage.getItem(key) || '{}') || {}); } catch { /* ignore */ }
  }, [key]);
  const update = useCallback((fn) => {
    setVal(prev => {
      const next = fn(prev);
      try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, [key]);
  return [val, update];
}

function Row({ label, active, onClick, depth = 0, lead, count, actions }) {
  return (
    <div className={'dks-row' + (active ? ' active' : '')} style={{ paddingLeft: 8 + depth * 12 }}
      role="link" tabIndex={0} aria-current={active ? 'page' : undefined} onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}>
      {lead && <span className="dks-lead">{lead}</span>}
      <span className="dks-label">{label}</span>
      {actions && <span className="dks-actions" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>{actions}</span>}
      {count ? <span className="dks-count">{count}</span> : null}
    </div>
  );
}

function SectionHead({ label, open, onToggle, depth = 0, onAdd, addLabel }) {
  return (
    <div className="dks-head" style={{ paddingLeft: 8 + depth * 12 }}>
      <button type="button" className="dks-head-btn" aria-expanded={open} onClick={onToggle}>
        <span>{label}</span>
        <ChevronDown className={'dks-caret' + (open ? '' : ' closed')} size={12} strokeWidth={2} aria-hidden />
      </button>
      {onAdd && <IconButton className="dks-add" icon={Plus} size="sm" label={addLabel} onClick={onAdd} />}
    </div>
  );
}

const dot = (color) => <span className="dks-dot" style={{ background: color }} />;

export function DocketSidebar({
  activeKey = '', path = '', spaces = [], programs = [], isAdmin = false, isPlanAdmin = false, showTemplates = false,
  collapsed = false, mobileOpen = false, onSelect, onNewSpace, onNewProgram, onSpaceSettings,
}) {
  const privates = (spaces || []).filter(s => s.is_private);
  const mySpaces = privates.filter(s => s.is_owner);
  const otherSpaces = privates.filter(s => !s.is_owner);
  // General is the non-private (default) space. It carries a badge like any other
  // (S309); the worker omits task_count entirely when a space has no open work, so
  // `count` stays undefined and Row renders nothing rather than a "0".
  const general = (spaces || []).find(s => !s.is_private);
  const go = (route) => () => onSelect(route);

  const [navCollapsed, setNavCollapsed] = useStoredObject('docket.nav.collapsed');
  const [hidden, setHidden] = useStoredObject('docket.nav.hidden');
  const isCollapsed = (key) => (key in navCollapsed ? navCollapsed[key] : DEFAULT_COLLAPSED[key]);
  const toggle = (key) => setNavCollapsed(prev => ({ ...prev, [key]: !(key in prev ? prev[key] : DEFAULT_COLLAPSED[key]) }));

  const programActive = activeKey.startsWith('/tasks?program=');
  const mySpaceActive = mySpaces.some(s => activeKey === '/tasks?space=' + s.id);
  const otherSpaceActive = otherSpaces.some(s => activeKey === '/tasks?space=' + s.id);
  const spacesActive = activeKey === '/tasks' || mySpaceActive || otherSpaceActive;
  const open = (key, hasActive) => !isCollapsed(key) || hasActive;
  const shown = (key, hasActive) => !hidden[key] || hasActive;

  const custRef = useRef(null);
  const [custOpen, setCustOpen] = useState(false);

  const spaceRow = (s) => (
    <Row key={s.id} depth={2} label={s.name} count={s.task_count}
      lead={<Lock size={12} strokeWidth={2} style={{ color: personColor(s.id) }} aria-label="Private" />}
      active={activeKey === '/tasks?space=' + s.id} onClick={go('/tasks?space=' + s.id)}
      actions={s.is_owner && onSpaceSettings
        ? <IconButton icon={MoreHorizontal} size="sm" label="Space settings" onClick={() => onSpaceSettings(s)} />
        : null} />
  );

  const cls = 'dks' + (collapsed ? ' collapsed' : '') + (mobileOpen ? ' mobile-open' : '');
  // Collapsed on desktop = width 0: take it out of the tab order + a11y tree too. The
  // mobile slide-over ignores the desktop collapse, so it's only inert while closed.
  const inert = collapsed && !mobileOpen ? '' : undefined;

  if (path.startsWith('/admin')) {
    return (
      <aside className={cls} inert={inert} aria-label="Admin">
        <div className="dks-title">Admin</div>
        <div className="dks-scroll">
          {isAdmin && ADMIN_ITEMS.map(a => (
            <Row key={a.key} label={a.label} active={path === a.key || path.startsWith(a.key + '/')} onClick={go(a.key)} />
          ))}
        </div>
      </aside>
    );
  }

  return (
    <aside className={cls} inert={inert} aria-label="Tasks">
      <div className="dks-title">Tasks</div>
      <div className="dks-scroll">
        {/* Plan (F9): the plan register / My milestones — top of the sidebar, for everyone. */}
        <Row label="Plan" lead={<Target size={13} strokeWidth={2} aria-hidden />} active={path === '/plan'} onClick={go('/plan')} />
        {/* F9 R4: the rolling three-week view (Overdue · this · next · the week after). */}
        <Row depth={1} label="Three weeks" active={path === '/plan/weeks'} onClick={go('/plan/weeks')} />
        {/* F9 R9a: theme → milestone → result → task, with rollups; and templates (only for people who may make or see one). */}
        <Row depth={1} label="Tree" active={path === '/plan/tree'} onClick={go('/plan/tree')} />
        {isPlanAdmin && <Row depth={1} label="Re-plan" active={path === '/plan/replan'} onClick={go('/plan/replan')} />}
        {showTemplates && <Row depth={1} label="Templates" active={path === '/plan/templates'} onClick={go('/plan/templates')} />}
        {/* F9 R6a: the weekly review pack — everyone (a lead sees their own team; plan admins any). */}
        <Row depth={1} label="Review" active={path === '/review'} onClick={go('/review')} />
        {/* F9 R6b: the Saturday founders' catch-up — plan admins only (the worker 403s anyone else). */}
        {isPlanAdmin && <Row depth={1} label="Founders’ catch-up" active={path === '/review/founders'} onClick={go('/review/founders')} />}
        {/* Programs (S138): cross-space jump-to — every task tagged to the program, in any
            space you can access. Only programs you have visible tasks in are listed (counts). */}
        {(programs.length > 0 || onNewProgram) && shown('programs', programActive) && <div className="dks-section">
          <SectionHead label="Programs" open={open('programs', programActive)} onToggle={() => toggle('programs')}
            onAdd={onNewProgram} addLabel="New program" />
          {open('programs', programActive) && programs.map(p => (
            <Row key={p.id} depth={1} lead={dot(p.color || personColor(p.id))} label={p.name} count={p.task_count}
              active={activeKey === '/tasks?program=' + p.id} onClick={go('/tasks?program=' + p.id)} />
          ))}
        </div>}

        {/* Spaces: General (the org-wide board — the worker's default when no space_id is
            set), then the caller's own private spaces, then private spaces others added them to. */}
        <div className="dks-section">
          <SectionHead label="Spaces" open={open('spaces', spacesActive)} onToggle={() => toggle('spaces')}
            onAdd={onNewSpace} addLabel="New space" />
          {open('spaces', spacesActive) && <>
            <Row depth={1} lead={dot('var(--text-4)')} label="General" count={general?.task_count}
              active={activeKey === '/tasks'} onClick={go('/tasks')} />

            {shown('mySpaces', mySpaceActive) && <>
              <SectionHead depth={1} label="My spaces" open={open('mySpaces', mySpaceActive)} onToggle={() => toggle('mySpaces')} />
              {open('mySpaces', mySpaceActive) && (mySpaces.length
                ? mySpaces.map(spaceRow)
                : <button type="button" className="dks-empty" style={{ paddingLeft: 32 }} onClick={onNewSpace}>+ New space</button>)}
            </>}

            {otherSpaces.length > 0 && shown('otherSpaces', otherSpaceActive) && <>
              <SectionHead depth={1} label="By others" open={open('otherSpaces', otherSpaceActive)} onToggle={() => toggle('otherSpaces')} />
              {open('otherSpaces', otherSpaceActive) && otherSpaces.map(spaceRow)}
            </>}
          </>}
        </div>
      </div>

      <div className="dks-foot">
        <Button ref={custRef} variant="ghost" size="sm" icon={SlidersHorizontal} aria-haspopup="menu"
          onClick={() => setCustOpen(o => !o)}>Customize sidebar</Button>
        <Menu anchorRef={custRef} open={custOpen} onClose={() => setCustOpen(false)} width={200} label="Customize sidebar" className="dk-pop-top">
          <MenuLabel>Show in sidebar</MenuLabel>
          {HIDEABLE.map(h => (
            <MenuItem key={h.key} keepOpen
              icon={<Check size={14} style={{ opacity: hidden[h.key] ? 0 : 1 }} aria-hidden />}
              onClick={() => setHidden(prev => ({ ...prev, [h.key]: !prev[h.key] }))}>
              {h.label}
            </MenuItem>
          ))}
        </Menu>
      </div>
    </aside>
  );
}

export default DocketSidebar;
