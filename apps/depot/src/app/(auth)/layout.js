'use client';
import { createContext, useContext, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { RequireAuth, useAuth } from '@throttle/auth';
import { Spinner, useSearchShortcut } from '@throttle/ui';
import { Menu, X, LogOut } from 'lucide-react';
import { DepotSidebar, DepotTopbar, CommandPalette } from '../../components/kit/index.js';
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
  const { user, role, signOut, loading } = useAuth();
  const { refreshing, lastRefreshed } = useRefreshState();
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
      <DepotSidebar
        onCmdK={() => setCmdkOpen(true)}
        userLabel={displayName}
        userRole={role || ''}
        onLogout={signOut}
      />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <DepotTopbar refreshing={refreshing} lastRefreshed={lastRefreshed} />
        <main className="dp-main" style={{ flex: 1, overflowY: 'auto', padding: '22px 26px' }}>
          {children}
        </main>
      </div>
      <CommandPalette open={cmdkOpen} onClose={() => setCmdkOpen(false)} />

      {/* ── mobile app chrome (≤767px — CSS decides; desktop never shows it) ── */}
      <MobileTabBar pathname={pathname} moreOpen={sheetOpen}
        onGo={(r) => { setSheetOpen(false); router.push(r); }} onMore={() => setSheetOpen((s) => !s)} />
      {sheetOpen && (
        <MobileSheet pathname={pathname} onGo={(r) => router.push(r)} onClose={() => setSheetOpen(false)}
          userLabel={displayName} userRole={role || ''} onLogout={signOut} />
      )}
    </div>
  );
}

const onRoute = (route, pathname) => !!route && (pathname === route || pathname.startsWith(route + '/'));

// ── mobile bottom tab bar — four primary destinations + More.
// Depot's nav carries no perm gates (the rail shows everything), so neither does this.
const MOBILE_TABS = [
  { route: '/dashboard',          label: 'Overview'  },
  { route: '/dispatch-pipeline',  label: 'Pipeline'  },
  { route: '/dispatch-shipments', label: 'Shipments' },
  { route: '/dispatch',           label: 'Floor'     },
];

function findNavItem(route) {
  for (const g of NAV_PRIMARY) {
    if (g.route === route) return g;
    for (const c of g.children || []) if (c.route === route) return c;
  }
  return null;
}

function MobileTabBar({ pathname, moreOpen, onGo, onMore }) {
  const tabs = MOBILE_TABS.map((t) => ({ ...t, it: findNavItem(t.route) })).filter((t) => t.it);
  return (
    <nav className="dp-tabbar">
      {tabs.map((t) => {
        const Icon = t.it.icon;
        // "/dispatch" is a prefix of the other dispatch-* routes only as a path
        // segment, so onRoute stays exact-or-deeper and Floor won't false-light.
        const on = !moreOpen && onRoute(t.route, pathname);
        return (
          <button key={t.route} className={`dp-tab${on ? ' active' : ''}`} onClick={() => onGo(t.route)}>
            <Icon size={19} strokeWidth={on ? 2 : 1.75} style={{ flexShrink: 0 }} />
            <span>{t.label}</span>
          </button>
        );
      })}
      <button className={`dp-tab${moreOpen ? ' active' : ''}`} onClick={onMore}>
        <Menu size={19} strokeWidth={moreOpen ? 2 : 1.75} style={{ flexShrink: 0 }} />
        <span>More</span>
      </button>
    </nav>
  );
}

// ── mobile "More" sheet — the full nav, grouped like the rail ────────────────
function MobileSheet({ pathname, onGo, onClose, userLabel, userRole, onLogout }) {
  const groups = [];
  const singles = NAV_PRIMARY.filter((g) => g.route);
  if (singles.length) groups.push({ label: 'Overview', items: singles });
  for (const g of NAV_PRIMARY) {
    if (g.route) continue;
    groups.push({ label: g.label, items: g.children || [] });
  }
  groups.push({ label: 'Setup & Help', items: [...NAV_SETUP, NAV_MANUAL] });
  return (
    <div className="dp-sheetwrap" onMouseDown={onClose}>
      <div className="dp-sheet" onMouseDown={(e) => e.stopPropagation()}>
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
            <div className="dp-sheet-grid">
              {g.items.map((it) => {
                const Icon = it.icon;
                const on = onRoute(it.route, pathname);
                return (
                  <button key={it.route} className={`dp-sheet-item${on ? ' active' : ''}`} onClick={() => onGo(it.route)}>
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
