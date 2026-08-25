'use client';
import { useMemo, useState, useEffect, useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { RequireAuth, useAuth } from '@throttle/auth';
import { Spinner, useSearchShortcut } from '@throttle/ui';
import { docketopsGet } from '../../lib/docketopsFetch.js';
import { ChromeContext } from '../../lib/chrome.js';
import { DocketSidebar } from '../../components/DocketSidebar.js';
import { DocketTopbar } from '../../components/DocketTopbar.js';
import { ShortcutsSheet } from '../../components/ShortcutsSheet.js';
import { LayoutDashboard, ListChecks, ListTodo, NotebookPen, BookOpen, Settings, Menu, X, LogOut } from 'lucide-react';
import { personColor } from '../../components/primitives.js';

export default function AuthLayout({ children }) {
  return (
    <RequireAuth>
      <AuthLayoutInner>{children}</AuthLayoutInner>
    </RequireAuth>
  );
}

function AuthLayoutInner({ children }) {
  const { user, role, perms, session, signOut, loading } = useAuth();
  const pathname = usePathname();
  const search   = useSearchParams();
  const router   = useRouter();

  const [collapsed, setCollapsed] = useState(false);
  const [spaces, setSpaces] = useState([]);
  const [programs, setPrograms] = useState([]);
  const [canViewDashboard, setCanViewDashboard] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [count, setCount] = useState(null);   // board task count, published by the tasks page

  // ── mobile "More" bottom sheet (≤767px chrome; closes itself on navigation).
  // Keyed on the FULL activeKey (path + query) — /tasks?space=… → /tasks?program=…
  // is a navigation even though pathname never changes.
  const [sheetOpen, setSheetOpen] = useState(false);
  const searchKey = search.toString();
  useEffect(() => { setSheetOpen(false); }, [pathname, searchKey]);

  useSearchShortcut(); // `/` focuses [data-search-primary]

  // Sticky sidebar collapse.
  useEffect(() => {
    try { const v = localStorage.getItem('docket.sidebarCollapsed'); if (v != null) setCollapsed(v === '1'); } catch { /* ignore */ }
  }, []);
  const toggleSidebar = useCallback(() => {
    setCollapsed(c => { const n = !c; try { localStorage.setItem('docket.sidebarCollapsed', n ? '1' : '0'); } catch { /* ignore */ } return n; });
  }, []);

  // getMe drives the sidebar: accessible spaces, programs (cross-space, with counts), and
  // can_view_dashboard (RULE-DOCKET-006).
  const loadMe = useCallback(() => {
    if (!session) return;
    docketopsGet('getMe', {}, session).then(me => {
      setSpaces(me?.spaces || []);
      setPrograms(me?.programs || []);
      setCanViewDashboard(!!me?.can_view_dashboard);
    }).catch(() => {});
  }, [session]);
  useEffect(() => { loadMe(); }, [loadMe]);
  // `counts-changed` fires from docketopsPost on EVERY successful task write, so it
  // arrives in bursts (a bulk update, or the drawer saving several fields). Debounced
  // to one trailing getMe per burst — without it a 40-task bulk action would fire 40.
  // spaces/programs-changed share the debounce: they also just re-run getMe.
  useEffect(() => {
    let t = null;
    const h = () => { if (t) clearTimeout(t); t = setTimeout(loadMe, 400); };
    window.addEventListener('docket:spaces-changed', h);
    window.addEventListener('docket:programs-changed', h);
    window.addEventListener('docket:counts-changed', h);
    return () => {
      if (t) clearTimeout(t);
      window.removeEventListener('docket:spaces-changed', h);
      window.removeEventListener('docket:programs-changed', h);
      window.removeEventListener('docket:counts-changed', h);
    };
  }, [loadMe]);

  // App-chrome keyboard shortcuts: `[` toggles the sidebar, `?` toggles the help
  // sheet, Esc closes it. Ignored while typing (same guard as useHotkey).
  useEffect(() => {
    function onKey(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const ae = document.activeElement;
      const typing = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable);
      if (e.key === 'Escape' && helpOpen) { setHelpOpen(false); return; }
      if (typing) return;
      if (e.key === '[') { e.preventDefault(); toggleSidebar(); }
      else if (e.key === '?') { e.preventDefault(); setHelpOpen(o => !o); }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [helpOpen, toggleSidebar]);

  // Active sidebar key + topbar title/context, derived from the route.
  const spaceParam = search.get('space');
  const programParam = search.get('program');
  const lens = search.get('lens');
  const spaceId = spaceParam && spaceParam !== 'new' ? spaceParam : '';
  const programId = programParam || '';
  const activeKey = pathname === '/tasks'
    ? (programId ? `/tasks?program=${programId}`
      : spaceId ? `/tasks?space=${spaceId}`
      : lens === 'mine' ? '/tasks?lens=mine' : '/tasks')
    : pathname;

  const chrome = useMemo(() => {
    if (pathname === '/dashboard') return { title: 'Dashboard' };
    if (pathname === '/checklist') return { title: 'Checklist' };
    if (pathname === '/scratchpad') return { title: 'Scratchpad' };
    if (pathname === '/manual') return { title: 'Manual' };
    if (pathname.startsWith('/admin')) return { title: 'Admin' };
    if (pathname === '/tasks') {
      if (programId) {
        const p = programs.find(x => x.id === programId);
        return { title: p?.name || 'Program', context: 'program · all spaces', showCount: true };
      }
      if (spaceId) {
        const s = spaces.find(x => x.id === spaceId);
        return { title: s?.name || 'Space', context: 'private space', isSpace: true, showCount: true };
      }
      if (lens === 'mine') return { title: 'My Tasks', context: 'owned + collaborating', showCount: true };
      return { title: 'All Tasks', context: 'general', showCount: true };
    }
    if (pathname.startsWith('/tasks/detail')) return { title: 'Task' };
    if (pathname.startsWith('/tasks/new')) return { title: 'New Task' };
    return { title: 'Docket' };
  }, [pathname, spaceId, programId, lens, spaces, programs]);

  if (loading && !user) return <Spinner />;

  const displayName = user?.full_name || user?.email || '';
  const ctxValue = { collapsed, setCollapsed, helpOpen, setHelpOpen, setCount };

  return (
    <ChromeContext.Provider value={ctxValue}>
      <div className="dk-app">
        <DocketSidebar
          activeKey={activeKey}
          spaces={spaces}
          programs={programs}
          canViewDashboard={canViewDashboard}
          isAdmin={!!perms?.docket_admin}
          collapsed={collapsed}
          onToggle={toggleSidebar}
          onSelect={(route) => router.push(route)}
          onNewTask={() => { router.push(spaceId ? `/tasks?space=${spaceId}` : '/tasks'); setTimeout(() => { try { const el = document.querySelector('[data-create-primary]'); el?.focus(); } catch { /* ignore */ } }, 60); }}
          userLabel={displayName}
          userRole={role || ''}
          onSignOut={signOut}
        />
        <div className="dk-main">
          <DocketTopbar
            title={chrome.title}
            context={chrome.context}
            isSpace={chrome.isSpace}
            count={chrome.showCount ? count : null}
            onToggleSidebar={toggleSidebar}
            onHelp={() => setHelpOpen(true)}
          />
          <div className="dk-scroll">
            <div className="dk-canvas">{children}</div>
          </div>
        </div>
        {helpOpen && <ShortcutsSheet onClose={() => setHelpOpen(false)} />}

        {/* ── mobile app chrome (≤767px — CSS decides; desktop never shows it) ── */}
        <MobileTabBar activeKey={activeKey} canViewDashboard={canViewDashboard} moreOpen={sheetOpen}
          onGo={(r) => { setSheetOpen(false); router.push(r); }} onMore={() => setSheetOpen(s => !s)} />
        {sheetOpen && (
          <MobileSheet activeKey={activeKey} spaces={spaces} programs={programs}
            canViewDashboard={canViewDashboard} isAdmin={!!perms?.docket_admin}
            onGo={(r) => router.push(r)} onClose={() => setSheetOpen(false)}
            userLabel={displayName} userRole={role || ''} onLogout={signOut} />
        )}
      </div>
    </ChromeContext.Provider>
  );
}

// ── mobile chrome — mirrors DocketSidebar's structure (fixed items + dynamic
// programs/spaces), keyed on the same activeKey the rail uses.
const MOBILE_TABS = [
  { key: '/tasks?lens=mine', label: 'My Tasks',  icon: ListChecks },
  { key: '/tasks',           label: 'All Tasks', icon: ListTodo   },
  { key: '/checklist',       label: 'Checklist', icon: ListChecks },
];

function MobileTabBar({ activeKey, canViewDashboard, moreOpen, onGo, onMore }) {
  const tabs = [...MOBILE_TABS];
  if (canViewDashboard) tabs.unshift({ key: '/dashboard', label: 'Dash', icon: LayoutDashboard });
  else tabs.push({ key: '/scratchpad', label: 'Notes', icon: NotebookPen });
  return (
    <nav className="dkm-tabbar">
      {tabs.map((t) => {
        const Icon = t.icon;
        const on = !moreOpen && activeKey === t.key;
        return (
          <button key={t.key} className={`dkm-tab${on ? ' active' : ''}`} onClick={() => onGo(t.key)}>
            <Icon size={19} strokeWidth={on ? 2 : 1.75} style={{ flexShrink: 0 }} />
            <span>{t.label}</span>
          </button>
        );
      })}
      <button className={`dkm-tab${moreOpen ? ' active' : ''}`} onClick={onMore}>
        <Menu size={19} strokeWidth={moreOpen ? 2 : 1.75} style={{ flexShrink: 0 }} />
        <span>More</span>
      </button>
    </nav>
  );
}

function MobileSheet({ activeKey, spaces, programs, canViewDashboard, isAdmin, onGo, onClose, userLabel, userRole, onLogout }) {
  const privates = (spaces || []).filter((s) => s.is_private);
  const fixed = [
    ...(canViewDashboard ? [{ key: '/dashboard', label: 'Dashboard', icon: LayoutDashboard }] : []),
    { key: '/tasks?lens=mine', label: 'My Tasks', icon: ListChecks },
    { key: '/tasks', label: 'All Tasks', icon: ListTodo },
    { key: '/checklist', label: 'Checklist', icon: ListChecks },
    { key: '/scratchpad', label: 'Scratchpad', icon: NotebookPen },
    { key: '/manual', label: 'Manual', icon: BookOpen },
    ...(isAdmin ? [{ key: '/admin', label: 'Admin', icon: Settings }] : []),
  ];
  const section = (label, items) => items.length > 0 && (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase',
        letterSpacing: '0.1em', padding: '0 2px 7px' }}>{label}</div>
      <div className="dkm-sheet-grid">{items}</div>
    </div>
  );
  // `count` mirrors the rail's badge (S309). The sheet is the rail's mobile twin, so
  // a badge that exists on one and not the other is a divergence — Programs already
  // had counts on the rail and none here. Undefined/0 renders nothing, same rule as
  // the rail: the worker omits task_count for a space with no open work, and a "0"
  // badge reads as a broken counter rather than an empty space.
  const item = (key, label, Icon, dot, count) => (
    <button key={key} className={`dkm-sheet-item${activeKey === key ? ' active' : ''}`} onClick={() => onGo(key)}>
      {Icon ? <Icon size={17} strokeWidth={1.75} style={{ flexShrink: 0 }} />
        : <span style={{ width: 9, height: 9, borderRadius: '50%', flexShrink: 0, background: dot || 'var(--border-strong)' }} />}
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      {count ? <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 10.5, color: 'var(--t3)', flexShrink: 0 }}>{count}</span> : null}
    </button>
  );
  return (
    <div className="dkm-sheetwrap" onMouseDown={onClose}>
      <div className="dkm-sheet" onMouseDown={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 14 }}>
          <div style={{ width: 36, height: 36, flexShrink: 0, borderRadius: 9, background: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 700, color: '#17140a', fontSize: 15 }}>
            {(userLabel || '?').trim().charAt(0).toUpperCase()}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {userLabel}
            </div>
            <div style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 10, color: 'var(--t3)' }}>{userRole}</div>
          </div>
          <button onClick={onLogout} title="Sign out"
            style={{ display: 'flex', padding: 6, borderRadius: 8, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--t3)' }}>
            <LogOut size={18} strokeWidth={1.75} />
          </button>
          <button onClick={onClose} title="Close"
            style={{ display: 'flex', padding: 6, borderRadius: 8, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--t2)' }}>
            <X size={19} strokeWidth={1.75} />
          </button>
        </div>

        {section('Docket', fixed.map((f) => item(f.key, f.label, f.icon)))}
        {section('Programs', (programs || []).map((p) => item(`/tasks?program=${p.id}`, p.name, null, p.color || personColor(p.id), p.task_count)))}
        {section('Spaces', privates.map((s) => item(`/tasks?space=${s.id}`, s.name, null, personColor(s.id), s.task_count)))}
      </div>
    </div>
  );
}
