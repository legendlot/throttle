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
  useEffect(() => {
    const h = () => loadMe();
    window.addEventListener('docket:spaces-changed', h);
    window.addEventListener('docket:programs-changed', h);
    return () => {
      window.removeEventListener('docket:spaces-changed', h);
      window.removeEventListener('docket:programs-changed', h);
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
      </div>
    </ChromeContext.Provider>
  );
}
