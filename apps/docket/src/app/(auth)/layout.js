'use client';
// Docket app shell (ClickUp redesign P1): a full-width 40px top bar; below it the
// 64px icon rail | the 240px context sidebar (collapsible) | the page.
// ≤767px: no rail — a bottom tab bar instead, and the sidebar becomes a slide-over.
import { useMemo, useState, useEffect, useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { RequireAuth, useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { docketopsGet } from '../../lib/docketopsFetch.js';
import { ChromeContext } from '../../lib/chrome.js';
import { routeModel, focusWhenReady, atRoute } from '../../lib/nav.js';
import { DocketRail } from '../../components/DocketRail.js';
import { DocketSidebar } from '../../components/DocketSidebar.js';
import { DocketTopbar } from '../../components/DocketTopbar.js';
import { DocketTabBar } from '../../components/DocketTabBar.js';
import { ShortcutsSheet } from '../../components/ShortcutsSheet.js';
import { SpaceSettings } from '../../components/SpaceSettings.js';
import { NewProgramModal } from '../../components/NewProgramModal.js';
import { CommandBar } from '../../components/CommandBar.js';
import { modPressed } from '../../lib/platform.js';

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
  const [myEmployeeId, setMyEmployeeId] = useState(null);   // getMe.employee_id (F2 capture toast)
  const [helpOpen, setHelpOpen] = useState(false);
  const [count, setCount] = useState(null);   // board task count, published by the tasks page
  const [settingsSpace, setSettingsSpace] = useState(null);   // sidebar ⋯ → SpaceSettings
  const [employees, setEmployees] = useState(null);           // lazy, only for SpaceSettings
  const [programModal, setProgramModal] = useState(false);     // + New → New program
  const [cmdOpen, setCmdOpen] = useState(false);               // ⌘K command bar (P6)
  // Programs created this session: getMe lists only programs with visible tasks, so a
  // brand-new one would otherwise breadcrumb as "Program". Breadcrumb lookup only.
  const [createdPrograms, setCreatedPrograms] = useState([]);

  // Mobile slide-over sidebar; closes itself on navigation. Keyed on the FULL route
  // (path + query) — /tasks?space=… → /tasks?program=… is a navigation even though
  // pathname never changes.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const searchKey = search.toString();
  useEffect(() => { setMobileNavOpen(false); }, [pathname, searchKey]);

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
      setMyEmployeeId(me?.employee_id || null);
      const can = !!me?.can_view_dashboard;
      setCanViewDashboard(can);
      // Remembered so the next load's mobile tab bar / rail don't flip Scratchpad → Dashboard.
      try { if (user?.id) localStorage.setItem(`docket.canViewDashboard.${user.id}`, can ? '1' : '0'); } catch { /* ignore */ }
    }).catch(() => {});
  }, [session, user?.id]);
  // Last-known value per user, read before getMe answers (getMe still decides).
  useEffect(() => {
    if (!user?.id) return;
    try { if (localStorage.getItem(`docket.canViewDashboard.${user.id}`) === '1') setCanViewDashboard(true); } catch { /* ignore */ }
  }, [user?.id]);
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
  const route = useMemo(() => routeModel(pathname, search, { spaces, programs: [...programs, ...createdPrograms] }), [pathname, search, spaces, programs, createdPrograms]);
  const onTasksBoard = route.path === '/tasks';

  const go = useCallback((r) => router.push(r), [router]);
  // + New → New task: on a program board, stay and focus its ProgramCapture (it
  // auto-tags the program); otherwise as the old sidebar button — the current space's
  // board (or General) — and focus its un-prefilled top "New task" capture
  // ([data-create-primary]; focusing reveals it) once that route has landed.
  const newTask = useCallback(() => {
    const programId = onTasksBoard ? (search.get('program') || '') : '';
    const target = programId ? `/tasks?program=${programId}` : route.spaceId ? `/tasks?space=${route.spaceId}` : '/tasks';
    if (!atRoute(target)) router.push(target);
    focusWhenReady('[data-create-primary]', { route: target });
  }, [router, route.spaceId, onTasksBoard, search]);
  const newSpace = useCallback(() => router.push('/tasks?space=new'), [router]);
  const newProgram = useCallback(() => { setMobileNavOpen(false); setProgramModal(true); }, []);
  // ⌘K command bar (P6): the top-bar search trigger, ⌘K / Ctrl+K anywhere, and `/` on a
  // page without its own search. Not over another shell modal, a page modal (.backdrop)
  // or an open picker / menu (.ui-pop, .pop) — Esc order stays one layer at a time. It
  // may open over TaskView (no picker open); TaskView's keys are off while it's up.
  const canOpenCmd = useCallback(() => !(settingsSpace || programModal || helpOpen)
    && !document.querySelector('.ui-pop, .pop, .backdrop, [data-modal]'), [settingsSpace, programModal, helpOpen]);
  const openSearch = useCallback(() => { if (canOpenCmd()) { setMobileNavOpen(false); setCmdOpen(true); } }, [canOpenCmd]);

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
      // ⌘K (Apple) / Ctrl+K (elsewhere): works from inside a field too (the convention
      // for a command bar). Ctrl+K on a Mac stays the text fields' kill-line.
      if (modPressed(e) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        if (!cmdOpen) openSearch();
        return;
      }
      // The bar owns the keyboard while it's open (it handles its own Esc).
      if (cmdOpen) return;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key === '\\') { e.preventDefault(); toggleSidebar(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const ae = document.activeElement;
      const typing = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable);
      if (e.key === 'Escape' && helpOpen) { setHelpOpen(false); return; }
      if (e.key === 'Escape' && mobileNavOpen) { setMobileNavOpen(false); return; }
      if (typing) return;
      // A shell modal (space settings / new program) owns the keyboard; `?` still closes help.
      if (settingsSpace || programModal) return;
      // So does a page-owned modal marked [data-modal] (F3 Grid triage): no `?` / `[` / `/`
      // underneath it. ⌘K is already gated on the same selector (canOpenCmd).
      if (!helpOpen && document.querySelector('[data-modal]')) return;
      if (e.key === '?') { e.preventDefault(); setHelpOpen(o => !o); return; }
      if (helpOpen) return;
      if (e.key === '[') { e.preventDefault(); toggleSidebar(); }
      else if (e.key === '/') {
        // `/` = the page's own search where it has one (the /tasks toolbar, P2/P3);
        // the command bar everywhere else.
        e.preventDefault();
        const t = document.querySelector('[data-search-primary]');
        if (t) { try { t.focus(); t.select?.(); } catch { /* ignore */ } } else openSearch();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [helpOpen, mobileNavOpen, settingsSpace, programModal, toggleSidebar, openSearch, cmdOpen]);

  if (loading && !user) return <Spinner />;

  const displayName = user?.full_name || user?.email || '';
  const isAdmin = !!perms?.docket_admin;
  const isPlanAdmin = !!perms?.docket_plan_admin;   // F9 R6b: the founders' catch-up nav entry
  // shellModalOpen: a layout-owned modal is up; pages fold it into their hotkey guards.
  const ctxValue = { collapsed, setCollapsed, helpOpen, setHelpOpen, setCount, myEmployeeId, shellModalOpen: !!settingsSpace || helpOpen || programModal || cmdOpen };

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
          onNewProgram={newProgram}
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
            isPlanAdmin={isPlanAdmin}
            collapsed={collapsed}
            mobileOpen={mobileNavOpen}
            onSelect={go}
            onNewSpace={newSpace}
            onNewProgram={newProgram}
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
        {/* Mounted per open: fresh state, sources read synchronously (no stale frame). */}
        {cmdOpen && <CommandBar userId={user?.id} session={session} onClose={() => setCmdOpen(false)} router={router}
          spaces={spaces} programs={[...programs, ...createdPrograms.filter(c => !programs.some(p => p.id === c.id))]}
          canViewDashboard={canViewDashboard} isAdmin={isAdmin} isPlanAdmin={isPlanAdmin}
          onNewTask={newTask} onNewSpace={newSpace} onNewProgram={newProgram}
          onToggleSidebar={toggleSidebar} onHelp={() => setHelpOpen(true)} />}
        {helpOpen && <ShortcutsSheet onClose={() => setHelpOpen(false)} />}
        {programModal && (
          <NewProgramModal session={session} onClose={() => setProgramModal(false)}
            onCreated={(prog) => {
              setProgramModal(false);
              setCreatedPrograms(ps => ps.some(p => p.id === prog.id) ? ps : [...ps, prog]);
              router.push('/tasks?program=' + prog.id);
            }} />
        )}
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
