'use client';
/* Shell — collapsible grouped sidebar, breadcrumb topbar, ⌘K command
   palette, brand mark. Ported from the prototype shell.jsx; navigation
   uses real Next routes instead of in-memory route state. */
import React, { useState, useEffect, useRef } from 'react';
import { Icon } from './Icon';
import { MANUAL, TASKS, taskTag } from '@/lib/throttleData';
import { AppLauncher } from '@throttle/ui';

export const ROUTE_OF = {
  dashboard: '/dashboard', requests: '/requests', board: '/board',
  sprints: '/sprints', social: '/social', performance: '/performance', manual: '/manual', settings: '/settings',
};
export const ROUTE_META = {
  dashboard: { group: 'Overview',   title: 'Command' },
  requests:  { group: 'Production', title: 'Requests' },
  board:     { group: 'Production', title: 'Board' },
  sprints:   { group: 'Production', title: 'Sprints' },
  social:    { group: 'Channels',   title: 'Social Calendar' },
  performance: { group: 'Channels', title: 'Social Performance' },
  manual:    { group: 'System',     title: 'Manual' },
  settings:  { group: 'System',     title: 'Settings' },
};

// Checkered-flag mark — the canonical Throttle logo (matches app/icon.svg + the
// favicon.png the cross-system launcher renders). Keep these in sync.
export function ThrottleMark({ size = 30 }) {
  const rows = [0, 1, 2, 3];
  return (
    <span style={{ width: size, height: size, borderRadius: 'var(--radius-mark)', overflow: 'hidden',
      display: 'grid', placeItems: 'center', flexShrink: 0, boxShadow: 'var(--mark-shadow)' }}>
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" style={{ display: 'block' }}>
        {rows.map(r => rows.map(c => (
          <rect key={`${r}-${c}`} x={c * 8} y={r * 8} width="8" height="8"
            fill={(r + c) % 2 === 0 ? '#F2CD1A' : '#151515'} />
        )))}
      </svg>
    </span>
  );
}

function NavRow({ item, active, collapsed, onClick }) {
  return (
    <button className="t-navrow" data-on={active ? 'true' : 'false'} onClick={onClick}
      title={collapsed ? item.label : undefined}
      style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, position: 'relative',
        padding: collapsed ? '10px 0' : '9px 13px', justifyContent: collapsed ? 'center' : 'flex-start',
        background: active ? 'var(--active-bg)' : 'transparent', border: 'none', cursor: 'pointer',
        borderRadius: 'var(--radius-nav)', margin: '1px 0',
        borderLeft: `2px solid ${active ? 'var(--active-bar)' : 'transparent'}`,
        color: active ? 'var(--active-fg)' : 'var(--t2)', transition: 'background .14s, color .14s',
        fontFamily: 'var(--font-ui)' }}>
      <span style={{ color: active ? 'var(--active-fg)' : 'var(--t3)', display: 'flex' }}>
        <Icon name={item.icon} size={collapsed ? 19 : 18} />
      </span>
      {!collapsed && <span style={{ flex: 1, textAlign: 'left', fontSize: 14, fontWeight: active ? 650 : 500,
        letterSpacing: '0.005em' }}>{item.label}</span>}
      {!collapsed && item.badge ? <span className="num" style={{ fontSize: 11, fontWeight: 700,
        background: 'var(--brand-red)', color: '#fff', borderRadius: 999, padding: '1px 7px', minWidth: 19, textAlign: 'center' }}>{item.badge}</span> : null}
      {collapsed && item.badge ? <span style={{ position: 'absolute', top: 7, right: 11, width: 6, height: 6,
        borderRadius: '50%', background: 'var(--brand-red)' }} /> : null}
    </button>
  );
}

export function Sidebar({ route, onNavigate, collapsed, onToggle, onPalette, user, onSignOut, badges = {} }) {
  const W = collapsed ? 64 : 248;
  const NAV = [
    { section: 'Overview',   items: [{ id: 'dashboard', label: 'Dashboard', icon: 'dashboard' }] },
    { section: 'Production', items: [
      { id: 'requests', label: 'Requests', icon: 'inbox', badge: badges.requests },
      { id: 'board',    label: 'Board',    icon: 'board', badge: badges.board },
      { id: 'sprints',  label: 'Sprints',  icon: 'target' },
    ] },
    { section: 'Channels',   items: [
      { id: 'social', label: 'Social', icon: 'calendar' },
      { id: 'performance', label: 'Performance', icon: 'trend' },
    ] },
  ];
  const BOTTOM = [
    { id: 'manual',   label: 'System Manual', icon: 'book' },
    { id: 'settings', label: 'Settings',      icon: 'settings' },
  ];
  return (
    <aside className="t-sidebar" style={{ width: W, flexShrink: 0, display: 'flex', flexDirection: 'column',
      background: 'var(--side-bg)', borderRight: '1px solid var(--border)', height: '100%', overflow: 'hidden',
      transition: 'width .22s var(--ease)' }}>
      <div onClick={onToggle} title={collapsed ? 'Expand' : 'Collapse'}
        style={{ display: 'flex', alignItems: 'center', justifyContent: collapsed ? 'center' : 'space-between',
          height: 60, padding: collapsed ? 0 : '0 16px', borderBottom: '1px solid var(--border)', cursor: 'pointer', flexShrink: 0 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
          <ThrottleMark />
          {!collapsed && <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1 }}>
            <span style={{ fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 800, letterSpacing: '0.18em', color: 'var(--t1)' }}>THROTTLE</span>
            <span style={{ fontFamily: 'var(--font-display)', fontSize: 8.5, fontWeight: 600, letterSpacing: '0.34em', color: 'var(--yellow)', marginTop: 4 }}>BRAND OS</span>
          </span>}
        </span>
        {!collapsed && <span style={{ color: 'var(--t4)', display: 'flex' }}><Icon name="chevronsLeft" size={16} /></span>}
      </div>

      <div style={{ padding: collapsed ? '12px 0 6px' : '14px 12px 8px', display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
        {collapsed ? (
          <button onClick={onPalette} title="Search · ⌘K" className="t-iconbtn" style={{ width: 38, height: 38 }}><Icon name="search" size={16} /></button>
        ) : (
          <button onClick={onPalette} className="t-search" style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 9,
            background: 'var(--bg-2)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-sm)', padding: '9px 12px', cursor: 'pointer', color: 'var(--t3)' }}>
            <Icon name="search" size={15} />
            <span style={{ flex: 1, textAlign: 'left', fontSize: 13.5, fontFamily: 'var(--font-ui)' }}>Search or jump…</span>
            <kbd className="t-kbd">⌘K</kbd>
          </button>
        )}
      </div>

      <nav style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '4px 10px' }}>
        {NAV.map(grp => (
          <div key={grp.section} style={{ marginBottom: 6 }}>
            {!collapsed && <div className="eyebrow" style={{ padding: '11px 13px 5px' }}>{grp.section}</div>}
            {collapsed && <div style={{ width: 26, height: 1, background: 'var(--border)', margin: '8px auto 6px' }} />}
            {grp.items.map(item => (
              <NavRow key={item.id} item={item} active={route === item.id} collapsed={collapsed} onClick={() => onNavigate(item.id)} />
            ))}
          </div>
        ))}
      </nav>

      <div style={{ borderTop: '1px solid var(--border)', padding: collapsed ? '6px 10px' : '8px 10px', flexShrink: 0 }}>
        {BOTTOM.map(item => (
          <NavRow key={item.id} item={item} active={route === item.id} collapsed={collapsed} onClick={() => onNavigate(item.id)} />
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: collapsed ? '12px 0' : '11px 16px',
        borderTop: '1px solid var(--border)', justifyContent: collapsed ? 'center' : 'flex-start', flexShrink: 0 }}>
        <span style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--yellow)', display: 'grid', placeItems: 'center',
          fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 12.5, color: '#15140b', flexShrink: 0 }}>{user.initial}</span>
        {!collapsed && <>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--t1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{user.name}</div>
            <div className="eyebrow" style={{ fontSize: 9, padding: 0, marginTop: 2 }}>{user.discipline}</div>
          </div>
          <span onClick={(e) => { e.stopPropagation(); onSignOut(); }} style={{ color: 'var(--t4)', display: 'flex', cursor: 'pointer' }} title="Sign out"><Icon name="logout" size={16} /></span>
        </>}
      </div>
    </aside>
  );
}

export function Topbar({ route, onPalette, sprint }) {
  const meta = ROUTE_META[route] || { group: '', title: route };
  return (
    <header style={{ height: 60, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 14, padding: '0 22px',
      borderBottom: '1px solid var(--border)', background: 'var(--topbar-bg)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, minWidth: 0 }}>
        <span className="eyebrow" style={{ whiteSpace: 'nowrap', padding: 0 }}>{meta.group}</span>
        <span style={{ color: 'var(--t4)', alignSelf: 'center', display: 'flex' }}><Icon name="chevronRight" size={12} /></span>
        <span className="t-title" style={{ fontSize: 17, whiteSpace: 'nowrap' }}>{meta.title}</span>
      </div>

      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, marginLeft: 6, padding: '5px 11px', whiteSpace: 'nowrap', flexShrink: 0,
        background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 999, fontSize: 12, color: 'var(--t2)' }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--yellow)' }} className="t-pulse" />
        <span style={{ fontFamily: 'var(--font-display)', fontSize: 10.5, fontWeight: 600, letterSpacing: '0.1em', color: 'var(--t3)' }}>SPRINT</span>
        <span style={{ fontWeight: 600, color: 'var(--t1)' }}>{sprint}</span>
      </span>

      <button onClick={onPalette} className="t-search" style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 9,
        width: 'min(280px, 28vw)', background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)',
        padding: '8px 12px', cursor: 'pointer', color: 'var(--t3)' }}>
        <Icon name="search" size={15} />
        <span style={{ flex: 1, textAlign: 'left', fontSize: 13, fontFamily: 'var(--font-ui)' }}>Search…</span>
        <kbd className="t-kbd">⌘K</kbd>
      </button>

      <button className="t-iconbtn" title="Notifications" style={{ position: 'relative' }}>
        <Icon name="bell" size={17} />
        <span style={{ position: 'absolute', top: 7, right: 8, width: 6, height: 6, borderRadius: '50%', background: 'var(--brand-red)' }} />
      </button>

      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-display)', fontSize: 10,
        fontWeight: 700, letterSpacing: '0.14em', color: 'var(--ok-fg)', textTransform: 'uppercase' }}>
        <span className="t-pulse" style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--ok-fg)' }} />Live
      </span>

      <AppLauncher current="throttle" />
    </header>
  );
}

export function CommandPalette({ open, onClose, onNavigate, tasks = TASKS }) {
  const [q, setQ] = useState('');
  const inputRef = useRef(null);
  useEffect(() => { if (open) { setQ(''); setTimeout(() => inputRef.current?.focus(), 30); } }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;

  const NAV_ITEMS = [
    { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
    { id: 'requests', label: 'Requests', icon: 'inbox' },
    { id: 'board', label: 'Board', icon: 'board' },
    { id: 'sprints', label: 'Sprints', icon: 'target' },
    { id: 'social', label: 'Social', icon: 'calendar' },
    { id: 'performance', label: 'Performance', icon: 'trend' },
    { id: 'manual', label: 'System Manual', icon: 'book' },
    { id: 'settings', label: 'Settings', icon: 'settings' },
  ].map(i => ({ ...i, kind: 'Go to' }));
  const quick = [
    { id: 'qr', label: 'New Request', icon: 'plus', kind: 'Create' },
    { id: 'qp', label: 'Schedule Social Post', icon: 'send', kind: 'Create' },
    { id: 'qs', label: 'Start Sprint Planning', icon: 'target', kind: 'Create' },
  ];
  const taskItems = (tasks || []).slice(0, 6).map(t => ({ id: t.id, label: t.title, icon: 'box', kind: 'Task', sub: taskTag(t.num) }));
  const help = (MANUAL || []).map(s => ({ id: s.id, label: s.label, icon: s.icon, kind: 'Manual' }));
  const all = [...quick, ...NAV_ITEMS, ...taskItems, ...help];
  const ql = q.trim().toLowerCase();
  const filtered = ql ? all.filter(i => i.label.toLowerCase().includes(ql) || (i.sub || '').toLowerCase().includes(ql)) : all;
  const groups = {};
  filtered.forEach(i => { (groups[i.kind] = groups[i.kind] || []).push(i); });

  const pick = (i) => {
    if (i.kind === 'Go to') onNavigate(i.id);
    else if (i.kind === 'Manual') { onNavigate('manual'); window.dispatchEvent(new CustomEvent('throttle:manual', { detail: i.id })); }
    else if (i.kind === 'Create' && i.id === 'qr') { window.dispatchEvent(new CustomEvent('throttle:newreq')); }
    else if (i.kind === 'Create' && i.id === 'qp') { onNavigate('social'); setTimeout(() => window.dispatchEvent(new CustomEvent('throttle:schedulepost')), 120); }
    else if (i.kind === 'Create' && i.id === 'qs') { onNavigate('sprints'); setTimeout(() => window.dispatchEvent(new CustomEvent('throttle:plansprint')), 120); }
    else if (i.kind === 'Task') { window.dispatchEvent(new CustomEvent('throttle:opentask', { detail: i.id })); }
    onClose();
  };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(8,8,10,0.62)', backdropFilter: 'blur(3px)',
      zIndex: 400, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '12vh' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(620px, 92vw)', background: 'var(--surface)',
        border: '1px solid var(--border-2)', borderRadius: 'var(--r-lg)', overflow: 'hidden', boxShadow: 'var(--shadow-pop)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '15px 18px', borderBottom: '1px solid var(--border)' }}>
          <Icon name="search" size={18} style={{ color: 'var(--t3)' }} />
          <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} placeholder="Search Throttle — requests, tasks, screens…"
            style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: 'var(--t1)', fontFamily: 'var(--font-ui)',
              fontSize: 15, caretColor: 'var(--yellow)' }} />
          <kbd className="t-kbd">ESC</kbd>
        </div>
        <div style={{ maxHeight: 380, overflowY: 'auto', padding: 8 }}>
          {Object.keys(groups).length === 0 && (
            <div style={{ padding: '32px 0', textAlign: 'center', color: 'var(--t3)', fontSize: 13 }}>No matches for “{q}”.</div>
          )}
          {Object.entries(groups).map(([kind, items]) => (
            <div key={kind} style={{ marginBottom: 6 }}>
              <div className="eyebrow" style={{ padding: '8px 10px 4px' }}>{kind}</div>
              {items.map(i => (
                <button key={kind + i.id} className="t-cmdrow" onClick={() => pick(i)}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '9px 11px', borderRadius: 'var(--r-sm)',
                    background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--t2)', textAlign: 'left', fontFamily: 'var(--font-ui)' }}>
                  <span style={{ color: 'var(--t3)', display: 'flex' }}><Icon name={i.icon} size={16} /></span>
                  <span style={{ flex: 1, fontSize: 13.5, color: 'var(--t1)' }}>{i.label}</span>
                  {i.sub && <span className="num" style={{ fontSize: 11, color: 'var(--t3)' }}>{i.sub}</span>}
                  <Icon name="chevronRight" size={13} style={{ color: 'var(--t4)' }} />
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
