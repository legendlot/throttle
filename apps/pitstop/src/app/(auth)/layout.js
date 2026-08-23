'use client';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { RequireAuth, useAuth } from '@throttle/auth';
import { Spinner, AppLauncher, useSearchShortcut } from '@throttle/ui';
import { PitstopSidebar, PitstopTopbar, CommandPalette, Icon } from '../../components/kit/index.js';
import { Menu, X, LogOut } from 'lucide-react';
import { csopsGet } from '../../lib/csopsFetch.js';
import { routeMatch, NAV_PRIMARY, NAV_SETUP, NAV_MANUAL, filterNavByPerms } from '../../lib/nav.js';
import DeptSwitcher, { getActiveDept } from '../../components/DeptSwitcher.js';
import PresenceToggle from '../../components/PresenceToggle.js';
import CallPop from '../../components/CallPop.js';

// Routes that own their own gutters and their own scrolling. The inbox runs two independent
// scroll areas (thread list + message list) edge to edge, so `main` must neither pad it nor
// add a third (page-level) scrollbar. Every other route keeps var(--pad) + overflow auto.
const FLUSH_ROUTES = ['/inbox'];

const RefreshContext = createContext({
  refreshing: false,    setRefreshing:    () => {},
  lastRefreshed: null,  setLastRefreshed: () => {},
  topbarBadge: null,    setTopbarBadge:   () => {},
});

export function RefreshProvider({ children }) {
  const [refreshing,    setRefreshing]    = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  // A page may publish ONE status pill into the topbar (plain data, never JSX — the topbar
  // owns its styling). Pages clear it on unmount, so it can never outlive its route.
  const [topbarBadge,   setTopbarBadge]   = useState(null);
  const value = useMemo(
    () => ({ refreshing, setRefreshing, lastRefreshed, setLastRefreshed, topbarBadge, setTopbarBadge }),
    [refreshing, lastRefreshed, topbarBadge],
  );
  return (
    <RefreshContext.Provider value={value}>
      {children}
    </RefreshContext.Provider>
  );
}

export function useRefreshState() {
  return useContext(RefreshContext);
}

export default function AuthLayout({ children }) {
  return (
    <RequireAuth>
      <RefreshProvider>
        <AuthLayoutInner>{children}</AuthLayoutInner>
      </RefreshProvider>
    </RequireAuth>
  );
}

function AuthLayoutInner({ children }) {
  const { user, brandUser, role, perms, session, signOut, loading } = useAuth();
  const { refreshing, lastRefreshed, topbarBadge } = useRefreshState();
  const pathname = usePathname();
  const router = useRouter();
  const flush = FLUSH_ROUTES.some(r => routeMatch(pathname, r));
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [badges, setBadges] = useState({ open: 0, missed: 0 });

  // ── mobile "More" bottom sheet (≤767px chrome; closes itself on navigation) ─
  const [sheetOpen, setSheetOpen] = useState(false);
  useEffect(() => { setSheetOpen(false); }, [pathname]);

  // Global "/" → focus the primary search input on the active page.
  useSearchShortcut();

  // Global ⌘K / Ctrl+K → command palette · Esc → close.
  useEffect(() => {
    const h = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setCmdkOpen(o => !o); }
      else if (e.key === 'Escape') setCmdkOpen(false);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // Live sidebar badges (Queue=open · Calls=awaiting-callback). 30s refresh.
  useEffect(() => {
    if (!session) return undefined;
    let alive = true;
    const load = async () => {
      try {
        const dept = getActiveDept(perms, brandUser?.cs_department_slug) || undefined;
        const params = dept ? { department: dept } : {};
        const [counts, calls] = await Promise.all([
          csopsGet('getQueueCounts', params, session).catch(() => null),
          csopsGet('getCallsKpis', params, session).catch(() => null),
        ]);
        if (!alive) return;
        setBadges({
          open: counts?.open || 0,
          missed: calls?.unanswered_awaiting_callback || 0,
        });
      } catch { /* badges are best-effort */ }
    };
    load();
    const iv = setInterval(load, 30000);
    const onDept = () => load();
    window.addEventListener('pitstop:dept-changed', onDept);
    return () => { alive = false; clearInterval(iv); window.removeEventListener('pitstop:dept-changed', onDept); };
  }, [session, perms, brandUser?.cs_department_slug]);

  if (loading && !user) return <Spinner />;

  const displayName = user?.full_name || brandUser?.full_name || user?.email || '';
  const roleLabel = ({ cs_agent: 'Agent', cs_lead: 'Team Lead', admin: 'CS Admin', super_admin: 'Super Admin' }[role]) || role || '';

  return (
    <div style={{ display: 'flex', height: '100dvh', overflow: 'hidden' }}>
      <PitstopSidebar
        perms={perms || {}}
        badges={badges}
        userLabel={displayName}
        userRole={roleLabel}
        onCmdK={() => setCmdkOpen(true)}
        onLogout={signOut}
      />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <PitstopTopbar refreshing={refreshing} lastRefreshed={lastRefreshed} badge={topbarBadge}>
          <PresenceToggle session={session} />
          <DeptSwitcher />
          <AppLauncher current="pitstop" />
        </PitstopTopbar>
        {/* `minHeight: 0` is what lets a flush route's flex child actually shrink instead of
            growing past the viewport; `overflow: hidden` keeps the page itself from scrolling
            behind the route's own scroll areas. */}
        <main className={`pt-main${flush ? ' flush' : ''}`} style={{ flex: 1, minHeight: 0,
          overflow: flush ? 'hidden' : 'auto',
          padding: flush ? 0 : 'var(--pad)' }}>
          {children}
        </main>
      </div>
      <CommandPalette open={cmdkOpen} onClose={() => setCmdkOpen(false)} perms={perms || {}} session={session} />
      {/* Mounted in the LAYOUT, not a page: a call can arrive while the agent is
          anywhere in Pitstop, and a page-mounted pop would unmount on navigation
          mid-call. Renders nothing unless the agent has a live call. */}
      <CallPop />

      {/* ── mobile app chrome (≤767px — CSS decides; desktop never shows it) ── */}
      <MobileTabBar perms={perms || {}} badges={badges} pathname={pathname} moreOpen={sheetOpen}
        onGo={(r) => { setSheetOpen(false); router.push(r); }} onMore={() => setSheetOpen(s => !s)} />
      {sheetOpen && (
        <MobileSheet perms={perms || {}} badges={badges} pathname={pathname} onGo={(r) => router.push(r)} onClose={() => setSheetOpen(false)}
          userLabel={displayName} userRole={roleLabel} onLogout={signOut} />
      )}
    </div>
  );
}

const onRoute = (route, pathname) => !!route &&
  (route === '/' ? pathname === '/' : (pathname === route || pathname.startsWith(route + '/')));

// ── mobile bottom tab bar — four primary destinations + More ────────────────
const MOBILE_TABS = [
  { route: '/',      label: 'Home',  badgeKey: null     },
  { route: '/queue', label: 'Queue', badgeKey: 'open'   },
  { route: '/inbox', label: 'Inbox', badgeKey: null     },
  { route: '/calls', label: 'Calls', badgeKey: 'missed' },
];

function MobileTabBar({ perms, badges, pathname, moreOpen, onGo, onMore }) {
  const visible = filterNavByPerms(NAV_PRIMARY, perms);
  const tabs = MOBILE_TABS.map((t) => ({ ...t, it: visible.find((i) => i.route === t.route) })).filter((t) => t.it);
  return (
    <nav className="pt-tabbar">
      {tabs.map((t) => {
        const on = !moreOpen && onRoute(t.route, pathname);
        const n = t.badgeKey ? badges?.[t.badgeKey] : 0;
        return (
          <button key={t.route} className={`pt-tab${on ? ' active' : ''}`} onClick={() => onGo(t.route)}>
            <span style={{ position: 'relative', display: 'flex' }}>
              <Icon name={t.it.icon} size={19} stroke={on ? 2 : 1.75} />
              {n > 0 && <span className="pt-tab-badge">{n > 99 ? '99+' : n}</span>}
            </span>
            <span>{t.label}</span>
          </button>
        );
      })}
      <button className={`pt-tab${moreOpen ? ' active' : ''}`} onClick={onMore}>
        <Menu size={19} strokeWidth={moreOpen ? 2 : 1.75} style={{ flexShrink: 0 }} />
        <span>More</span>
      </button>
    </nav>
  );
}

// ── mobile "More" sheet — the full nav, grouped like the rail ────────────────
function MobileSheet({ perms, badges, pathname, onGo, onClose, userLabel, userRole, onLogout }) {
  const work = filterNavByPerms(NAV_PRIMARY, perms);
  const setup = filterNavByPerms(NAV_SETUP, perms);
  const groups = [
    { label: 'Work', items: work },
    { label: 'Setup · Help', items: [...setup, NAV_MANUAL] },
  ].filter((g) => g.items.length);
  const go = (r) => { onClose(); onGo(r); };
  return (
    <div className="pt-sheetwrap" onMouseDown={onClose}>
      <div className="pt-sheet" onMouseDown={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 14 }}>
          <div style={{ width: 36, height: 36, flexShrink: 0, borderRadius: 9, background: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 700, color: 'var(--accent-fg)', fontSize: 15 }}>
            {(userLabel || '?').trim().charAt(0).toUpperCase()}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {userLabel}
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--t3)' }}>{userRole}</div>
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

        {groups.map((g) => (
          <div key={g.label} style={{ marginBottom: 14 }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase',
              letterSpacing: '0.1em', padding: '0 2px 7px' }}>{g.label}</div>
            <div className="pt-sheet-grid">
              {g.items.map((it) => {
                const n = it.badgeKey ? badges?.[it.badgeKey] : 0;
                return (
                  <button key={it.route} className={`pt-sheet-item${onRoute(it.route, pathname) ? ' active' : ''}`} onClick={() => go(it.route)}>
                    <Icon name={it.icon} size={17} stroke={1.75} />
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</span>
                    {n > 0 && <span className="pt-tab-badge inline">{n > 99 ? '99+' : n}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
