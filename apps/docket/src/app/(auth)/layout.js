'use client';
// Docket app shell (ClickUp redesign P1): a full-width 40px top bar; below it the
// 64px icon rail | the 240px context sidebar (collapsible) | the page.
// ≤767px: no rail — a bottom tab bar instead, and the sidebar becomes a slide-over.
import { useMemo, useState, useEffect, useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { RequireAuth, useAuth } from '@throttle/auth';
import { Spinner, useSearchShortcut, useToast } from '@throttle/ui';
import { docketopsGet } from '../../lib/docketopsFetch.js';
import { ChromeContext } from '../../lib/chrome.js';
import { routeModel, focusWhenReady, atRoute } from '../../lib/nav.js';
import { DocketRail } from '../../components/DocketRail.js';
import { DocketSidebar } from '../../components/DocketSidebar.js';
import { DocketTopbar } from '../../components/DocketTopbar.js';
import { DocketTabBar } from '../../components/DocketTabBar.js';
import { ShortcutsSheet } from '../../components/ShortcutsSheet.js';
import { SpaceSettings } from '../../components/SpaceSettings.js';

export default function AuthLayout({ children }) {
  return (
    <RequireAuth>
      <AuthLayoutInner>{children}</AuthLayoutInner>
    </RequireAuth>
  );
}

function AuthLayoutInner({ children }) {
  const { user, role, perms, session, signOut, loading } = useAuth();
  const { showToast } = useToast();
  const pathname = usePathname();
  const search   = useSearchParams();
  const router   = useRouter();

  const [collapsed, setCollapsed] = useState(false);
  const [spaces, setSpaces] = useState([]);
  const [programs, setPrograms] = useState([]);
  const [canViewDashboard, setCanViewDashboard] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [count, setCount] = useState(null);   // board task count, published by the tasks page
  const [settingsSpace, setSettingsSpace] = useState(null);   // sidebar ⋯ → SpaceSettings
  const [employees, setEmployees] = useState(null);           // lazy, only for SpaceSettings

  // Mobile slide-over sidebar; closes itself on navigation. Keyed on the FULL route
  // (path + query) — /tasks?space=… → /tasks?program=… is a navigation even though
  // pathname never changes.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const searchKey = search.toString();
  useEffect(() => { setMobileNavOpen(false); }, [pathname, searchKey]);

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

  // Route → active rail item, active sidebar row, breadcrumb.
  const route = useMemo(() => routeModel(pathname, search, { spaces, programs }), [pathname, search, spaces, programs]);
  const onTasksBoard = route.path === '/tasks';

  const go = useCallback((r) => router.push(r), [router]);
  // + New → New task: on a program board, stay and focus its ProgramCapture (it
  // auto-tags the program); otherwise as the old sidebar button — the current space's
  // board (or General) — and focus its quick-capture once that route has landed.
  const newTask = useCallback(() => {
    const programId = onTasksBoard ? (search.get('program') || '') : '';
    const target = programId ? `/tasks?program=${programId}` : route.spaceId ? `/tasks?space=${route.spaceId}` : '/tasks';
    if (!atRoute(target)) router.push(target);
    focusWhenReady('[data-create-primary]', { route: target });
  }, [router, route.spaceId, onTasksBoard, search]);
  const newSpace = useCallback(() => router.push('/tasks?space=new'), [router]);
  // Search trigger: on a board, focus its search (same as `/`); elsewhere go to /tasks first.
  const openSearch = useCallback(() => {
    if (onTasksBoard) { focusWhenReady('[data-search-primary]', { select: true }); return; }
    router.push('/tasks');
    focusWhenReady('[data-search-primary]', { route: '/tasks', select: true });
  }, [router, onTasksBoard]);

  const openSpaceSettings = useCallback((s) => {
    setMobileNavOpen(false);
    setSettingsSpace(s);
    if (!employees && session) docketopsGet('getEmployees', {}, session).then(e => setEmployees(e || [])).catch(() => setEmployees([]));
  }, [employees, session]);
  const spacesChanged = () => { if (typeof window !== 'undefined') window.dispatchEvent(new Event('docket:spaces-changed')); };

  // App-chrome keyboard shortcuts: `[` / ⌘\ / Ctrl+\ toggle the sidebar, `?` toggles the
  // help sheet, Esc closes it (or the mobile slide-over), `/` off a board runs the
  // top-bar search trigger (a page with [data-search-primary] keeps useSearchShortcut's
  // own `/` — no double fire). Bare keys are ignored while typing (same guard as
  // useHotkey); ⌘\ works anywhere.
  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key === '\\') { e.preventDefault(); toggleSidebar(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const ae = document.activeElement;
      const typing = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable);
      if (e.key === 'Escape' && helpOpen) { setHelpOpen(false); return; }
      if (e.key === 'Escape' && mobileNavOpen) { setMobileNavOpen(false); return; }
      if (typing) return;
      if (e.key === '[') { e.preventDefault(); toggleSidebar(); }
      else if (e.key === '?') { e.preventDefault(); setHelpOpen(o => !o); }
      else if (e.key === '/' && !settingsSpace && !document.querySelector('[data-search-primary]')) { e.preventDefault(); openSearch(); }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [helpOpen, mobileNavOpen, settingsSpace, toggleSidebar, openSearch]);

  if (loading && !user) return <Spinner />;

  const displayName = user?.full_name || user?.email || '';
  const isAdmin = !!perms?.docket_admin;
  // shellModalOpen: a layout-owned modal is up; pages fold it into their hotkey guards.
  const ctxValue = { collapsed, setCollapsed, helpOpen, setHelpOpen, setCount, shellModalOpen: !!settingsSpace || helpOpen };

  return (
    <ChromeContext.Provider value={ctxValue}>
      <div className={'dk-app' + (collapsed ? ' sb-collapsed' : '')}>
        <DocketTopbar
          crumbs={route.crumbs}
          count={route.showCount ? count : null}
          onCrumb={go}
          onToggleSidebar={toggleSidebar}
          onOpenMobileNav={() => setMobileNavOpen(true)}
          onSearch={openSearch}
          onNewTask={newTask}
          onNewSpace={newSpace}
          onHelp={() => setHelpOpen(true)}
        />
        <div className="dk-body">
          <DocketRail
            railKey={route.railKey}
            canViewDashboard={canViewDashboard}
            isAdmin={isAdmin}
            userLabel={displayName}
            userRole={role || ''}
            userKey={user?.id || displayName}
            onGo={go}
            onShortcuts={() => setHelpOpen(true)}
            onSignOut={signOut}
          />
          <DocketSidebar
            activeKey={route.activeKey}
            path={route.path}
            spaces={spaces}
            programs={programs}
            isAdmin={isAdmin}
            collapsed={collapsed}
            mobileOpen={mobileNavOpen}
            onSelect={go}
            onNewSpace={newSpace}
            onSpaceSettings={openSpaceSettings}
          />
          {mobileNavOpen && <div className="dks-backdrop" onMouseDown={() => setMobileNavOpen(false)} />}
          <main className="dk-main">
            <div className="dk-scroll">
              <div className="dk-canvas">{children}</div>
            </div>
          </main>
        </div>
        <DocketTabBar
          railKey={route.railKey}
          canViewDashboard={canViewDashboard}
          isAdmin={isAdmin}
          userLabel={displayName}
          userRole={role || ''}
          onGo={go}
          onShortcuts={() => setHelpOpen(true)}
          onSignOut={signOut}
        />
        {helpOpen && <ShortcutsSheet onClose={() => setHelpOpen(false)} />}
        {settingsSpace && (
          <SpaceSettings space={settingsSpace} session={session} employees={employees || []} showToast={showToast}
            onClose={() => setSettingsSpace(null)}
            onChanged={spacesChanged}
            onArchived={() => {
              const wasHere = route.activeKey === '/tasks?space=' + settingsSpace.id;
              setSettingsSpace(null); spacesChanged();
              if (wasHere) router.push('/tasks');
            }} />
        )}
      </div>
    </ChromeContext.Provider>
  );
}
