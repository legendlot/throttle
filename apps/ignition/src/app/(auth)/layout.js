'use client';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { RequireAuth, useAuth } from '@throttle/auth';
import { Sidebar, Spinner, Topbar, useSearchShortcut, AppLauncher } from '@throttle/ui';
import { Menu, X, LogOut } from 'lucide-react';
import { NAV_GROUPS, filterNavByPerms } from '../../lib/nav.js';

const RefreshContext = createContext({
  refreshing: false,    setRefreshing:    () => {},
  lastRefreshed: null,  setLastRefreshed: () => {},
});

export function RefreshProvider({ children }) {
  const [refreshing,    setRefreshing]    = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  return (
    <RefreshContext.Provider value={{ refreshing, setRefreshing, lastRefreshed, setLastRefreshed }}>
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
  const { user, role, perms, signOut, loading } = useAuth();
  const pathname  = usePathname();
  const router    = useRouter();
  const { refreshing, lastRefreshed } = useRefreshState();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);

  // ── mobile "More" bottom sheet (≤767px chrome; closes itself on navigation) ─
  const [sheetOpen, setSheetOpen] = useState(false);
  useEffect(() => { setSheetOpen(false); }, [pathname]);

  useSearchShortcut();

  const navGroups = useMemo(
    () => filterNavByPerms(NAV_GROUPS, perms || {}),
    [perms]
  );

  if (loading && !user) return <Spinner />;

  const displayName = user?.full_name || user?.email || '';
  const initial     = displayName ? displayName[0].toUpperCase() : '?';

  return (
    <div style={{ display:'flex', height:'100dvh', overflow:'hidden' }}>
      <Sidebar
        groups={navGroups}
        activeTab={pathname}
        onTabSelect={(item) => router.push(item.route)}
        userLabel={displayName}
        userInitial={initial}
        userRole={role || ''}
        onLogout={signOut}
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed(c => !c)}
        appLabel="IGNITION"
        appShortLabel="IG"
        appIcon={<img src="/favicon.svg" alt="Ignition" style={{ height: 20, width: 'auto', display: 'block' }} />}
      />
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
        <Topbar
          navGroups={navGroups}
          pathname={pathname}
          onTabSelect={(item) => router.push(item.route)}
          refreshing={refreshing}
          lastRefreshed={lastRefreshed}
        >
          <AppLauncher current="ignition" />
        </Topbar>
        <main className="ig-main" style={{ flex:1, overflowY:'auto', padding:'16px 24px' }}>
          {children}
        </main>
      </div>

      {/* ── mobile app chrome (≤767px — CSS decides; desktop never shows it) ── */}
      <MobileTabBar navGroups={navGroups} pathname={pathname} moreOpen={sheetOpen}
        onGo={(r) => { setSheetOpen(false); router.push(r); }} onMore={() => setSheetOpen((s) => !s)} />
      {sheetOpen && (
        <MobileSheet navGroups={navGroups} pathname={pathname} onGo={(r) => router.push(r)} onClose={() => setSheetOpen(false)}
          userLabel={displayName} userInitial={initial} userRole={role || ''} onLogout={signOut} />
      )}
    </div>
  );
}

const onRoute = (route, pathname) => !!route && (pathname === route || pathname.startsWith(route + '/'));

// Flatten the perm-filtered nav (flat groups become single items) — tab bar + sheet
// both read this, so gating stays identical to the rail.
function flatNav(navGroups) {
  const out = [];
  for (const g of navGroups) {
    if (g.flat) { out.push({ ...g }); continue; }
    for (const it of g.items || []) out.push(it);
  }
  return out;
}

// ── mobile bottom tab bar — four primary destinations + More ────────────────
const MOBILE_TABS = [
  { route: '/dashboard',   label: 'Home'    },
  { route: '/influencers', label: 'People'  },
  { route: '/engagements', label: 'Deals'   },
  { route: '/schedule',    label: 'Schedule' },
];

function MobileTabBar({ navGroups, pathname, moreOpen, onGo, onMore }) {
  const flat = flatNav(navGroups);
  const tabs = MOBILE_TABS.map((t) => ({ ...t, it: flat.find((i) => i.route === t.route) })).filter((t) => t.it);
  return (
    <nav className="ig-tabbar">
      {tabs.map((t) => {
        const Icon = t.it.icon;
        const on = !moreOpen && onRoute(t.route, pathname);
        return (
          <button key={t.route} className={`ig-tab${on ? ' active' : ''}`} onClick={() => onGo(t.route)}>
            <Icon size={19} strokeWidth={on ? 2 : 1.75} style={{ flexShrink: 0 }} />
            <span>{t.label}</span>
          </button>
        );
      })}
      <button className={`ig-tab${moreOpen ? ' active' : ''}`} onClick={onMore}>
        <Menu size={19} strokeWidth={moreOpen ? 2 : 1.75} style={{ flexShrink: 0 }} />
        <span>More</span>
      </button>
    </nav>
  );
}

// ── mobile "More" sheet — the full nav, grouped like the rail ────────────────
function MobileSheet({ navGroups, pathname, onGo, onClose, userLabel, userInitial, userRole, onLogout }) {
  const flats = navGroups.filter((g) => g.flat);
  const grouped = navGroups.filter((g) => !g.flat);
  return (
    <div className="ig-sheetwrap" onMouseDown={onClose}>
      <div className="ig-sheet" onMouseDown={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 14 }}>
          <div style={{ width: 36, height: 36, flexShrink: 0, borderRadius: 9, background: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 700, color: 'var(--accent-fg)', fontSize: 15 }}>
            {userInitial}
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

        {grouped.map((g) => (
          <div key={g.id} style={{ marginBottom: 14 }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase',
              letterSpacing: '0.1em', padding: '0 2px 7px' }}>{g.label}</div>
            <div className="ig-sheet-grid">
              {(g.items || []).map((it) => {
                const Icon = it.icon;
                return (
                  <button key={it.route} className={`ig-sheet-item${onRoute(it.route, pathname) ? ' active' : ''}`} onClick={() => onGo(it.route)}>
                    {Icon && <Icon size={17} strokeWidth={1.75} style={{ flexShrink: 0 }} />}
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        {flats.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase',
              letterSpacing: '0.1em', padding: '0 2px 7px' }}>Help</div>
            <div className="ig-sheet-grid">
              {flats.map((g) => {
                const Icon = g.icon;
                return (
                  <button key={g.route} className={`ig-sheet-item${onRoute(g.route, pathname) ? ' active' : ''}`} onClick={() => onGo(g.route)}>
                    {Icon && <Icon size={17} strokeWidth={1.75} style={{ flexShrink: 0 }} />}
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
