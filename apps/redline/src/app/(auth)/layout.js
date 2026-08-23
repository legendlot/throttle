'use client';
import { createContext, useContext, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { RequireAuth, useAuth, hasPermission } from '@throttle/auth';
import { Spinner, useSearchShortcut } from '@throttle/ui';
import { Menu, X, LogOut } from 'lucide-react';
import { usePendingCounts } from '../../hooks/usePendingCounts.js';
import { RedlineSidebar, RedlineTopbar, CommandPalette } from '../../components/kit/index.js';
import { NAV_PRIMARY, NAV_SETUP, NAV_MANUAL } from '../../lib/nav.js';

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
  const { user, session, role, perms, signOut, loading } = useAuth();
  const { refreshing, lastRefreshed } = useRefreshState();
  const { alertCount, returnCount }   = usePendingCounts(session);
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const pathname = usePathname();
  const router   = useRouter();

  // ── mobile "More" bottom sheet (≤767px chrome; closes itself on navigation) ─
  const [sheetOpen, setSheetOpen] = useState(false);
  useEffect(() => { setSheetOpen(false); }, [pathname]);

  // Global "/" → focus the primary search input on the active page.
  useSearchShortcut();

  // Global ⌘K / Ctrl+K → command palette.
  useEffect(() => {
    const h = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdkOpen(o => !o);
      } else if (e.key === 'Escape') {
        setCmdkOpen(false);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  if (loading && !user) return <Spinner />;

  const displayName = user?.full_name || user?.email || '';

  return (
    <div style={{ display: 'flex', height: '100dvh', overflow: 'hidden', background: 'var(--bg)',
      fontFamily: 'var(--font-ui)', position: 'relative' }}>
      <RedlineSidebar
        onCmdK={() => setCmdkOpen(true)}
        badges={{ alerts: alertCount, returns: returnCount }}
        userLabel={displayName}
        userRole={role || ''}
        perms={perms}
        onLogout={signOut}
      />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <RedlineTopbar refreshing={refreshing} lastRefreshed={lastRefreshed} />
        <main className="rl-main" style={{ flex: 1, overflowY: 'auto', padding: '22px 26px' }}>
          {children}
        </main>
      </div>
      <CommandPalette open={cmdkOpen} onClose={() => setCmdkOpen(false)} />

      {/* ── mobile app chrome (≤767px — CSS decides; desktop never shows it) ── */}
      <MobileTabBar perms={perms} pathname={pathname} moreOpen={sheetOpen}
        onGo={(r) => { setSheetOpen(false); router.push(r); }} onMore={() => setSheetOpen((s) => !s)} />
      {sheetOpen && (
        <MobileSheet perms={perms} pathname={pathname} onGo={(r) => router.push(r)} onClose={() => setSheetOpen(false)}
          userLabel={displayName} userRole={role || ''} onLogout={signOut} />
      )}
    </div>
  );
}

// ── mobile nav helpers — mirror RedlineSidebar's gating exactly (null perms = show all) ──
const groupVisible = (g, perms) => !g.perm || !perms || hasPermission(perms, g.perm);
const onRoute = (route, pathname) => !!route && (pathname === route || pathname.startsWith(route + '/'));

// Four primary destinations + More. A tab renders only if its OWNING nav group
// passes the same perm gate the rail applies.
const MOBILE_TABS = [
  { route: '/exec',   label: 'Overview', groupId: 'overview' },
  { route: '/lines',  label: 'Lines',    groupId: 'floor'    },
  { route: '/hourly', label: 'Hourly',   groupId: 'floor'    },
  { route: '/qc',     label: 'QC',       groupId: 'quality'  },
];

function MobileTabBar({ perms, pathname, moreOpen, onGo, onMore }) {
  const tabs = MOBILE_TABS.map((t) => {
    const g = NAV_PRIMARY.find((x) => x.id === t.groupId);
    if (!g || !groupVisible(g, perms)) return null;
    const it = g.route ? g : (g.children || []).find((c) => c.route === t.route);
    return it ? { ...t, icon: it.icon } : null;
  }).filter(Boolean);
  return (
    <nav className="rl-tabbar">
      {tabs.map((t) => {
        const Icon = t.icon;
        const on = !moreOpen && onRoute(t.route, pathname);
        return (
          <button key={t.route} className={`rl-tab${on ? ' active' : ''}`} onClick={() => onGo(t.route)}>
            <Icon size={19} strokeWidth={on ? 2 : 1.75} style={{ flexShrink: 0 }} />
            <span>{t.label}</span>
          </button>
        );
      })}
      <button className={`rl-tab${moreOpen ? ' active' : ''}`} onClick={onMore}>
        <Menu size={19} strokeWidth={moreOpen ? 2 : 1.75} style={{ flexShrink: 0 }} />
        <span>More</span>
      </button>
    </nav>
  );
}

// ── mobile "More" sheet — the full nav, grouped like the rail ────────────────
function MobileSheet({ perms, pathname, onGo, onClose, userLabel, userRole, onLogout }) {
  const groups = [];
  const singles = NAV_PRIMARY.filter((g) => g.route && groupVisible(g, perms));
  if (singles.length) groups.push({ label: 'Overview', items: singles });
  for (const g of NAV_PRIMARY) {
    if (g.route || !groupVisible(g, perms)) continue;
    groups.push({ label: g.label, items: g.children || [] });
  }
  const setup = NAV_SETUP.filter((s) => groupVisible(s, perms));
  groups.push({ label: 'Setup & Help', items: [...setup, NAV_MANUAL] });
  return (
    <div className="rl-sheetwrap" onMouseDown={onClose}>
      <div className="rl-sheet" onMouseDown={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 14 }}>
          <div style={{ width: 36, height: 36, flexShrink: 0, borderRadius: 'var(--r-sm)', background: 'var(--yellow)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'var(--font-display)', fontWeight: 700, color: '#17140a', fontSize: 15 }}>
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
            <div className="label" style={{ fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase',
              letterSpacing: '0.1em', padding: '0 2px 7px' }}>{g.label}</div>
            <div className="rl-sheet-grid">
              {g.items.map((it) => {
                const Icon = it.icon;
                const on = onRoute(it.route, pathname);
                return (
                  <button key={it.route} className={`rl-sheet-item${on ? ' active' : ''}`} onClick={() => onGo(it.route)}>
                    {Icon && <Icon size={17} strokeWidth={1.75} style={{ flexShrink: 0 }} />}
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</span>
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
