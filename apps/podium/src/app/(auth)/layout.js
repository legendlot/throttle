'use client';
import { createContext, useContext, useMemo, useState, useEffect, useCallback } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { RequireAuth, useAuth } from '@throttle/auth';
import { Spinner, useSearchShortcut } from '@throttle/ui';
import { Menu, X, LogOut } from 'lucide-react';
import { NAV_GROUPS, filterNavByPerms } from '../../lib/nav.js';
import { PodiumSidebar } from '../../components/PodiumSidebar.js';
import { PodiumTopbar } from '../../components/PodiumTopbar.js';

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

// Group eyebrow + screen title for the topbar, keyed by route.
const META = {
  '/dashboard':         { crumb: 'People',      title: 'Dashboard' },
  '/people':            { crumb: 'People',      title: 'Directory' },
  '/people/detail':     { crumb: 'People',      title: 'Profile' },
  '/people/new':        { crumb: 'People',      title: 'New Person' },
  '/org':               { crumb: 'People',      title: 'Org Chart' },
  '/me':                { crumb: 'Performance', title: 'My Performance' },
  '/team':              { crumb: 'Performance', title: 'Team' },
  '/appraisals':        { crumb: 'Performance', title: 'Appraisals' },
  '/appraisals/cycle':  { crumb: 'Performance', title: 'Appraisal Cycle' },
  '/appraisals/detail': { crumb: 'Performance', title: 'Appraisal' },
  '/appraisals/letter': { crumb: 'Performance', title: 'Appraisal Letter' },
  '/roles':             { crumb: 'Org Design',  title: 'Roles & KPIs' },
  '/roles/detail':      { crumb: 'Org Design',  title: 'Role' },
  '/departments':       { crumb: 'Org Design',  title: 'Departments' },
  '/manual':            { crumb: 'Org Design',  title: 'System Manual' },
  '/admin/roles':       { crumb: 'Admin',       title: 'Permissions' },
  '/admin/users':       { crumb: 'Admin',       title: 'Users' },
  '/admin/settings':    { crumb: 'Admin',       title: 'Settings' },
};
function chromeFor(pathname) {
  const clean = (pathname || '').replace(/\/$/, '') || '/';
  if (META[clean]) return META[clean];
  // longest-prefix fallback for nested routes
  let best = null, len = -1;
  for (const k of Object.keys(META)) {
    if ((clean === k || clean.startsWith(k + '/')) && k.length > len) { best = META[k]; len = k.length; }
  }
  return best || { crumb: '', title: 'Podium' };
}

function AuthLayoutInner({ children }) {
  const { user, role, perms, signOut, loading } = useAuth();
  const pathname  = usePathname();
  const router    = useRouter();
  const { lastRefreshed } = useRefreshState();
  const [collapsed, setCollapsed] = useState(false);   // default expanded (§4/§6)

  // ── mobile "More" bottom sheet (≤767px chrome; closes itself on navigation) ─
  const [sheetOpen, setSheetOpen] = useState(false);
  useEffect(() => { setSheetOpen(false); }, [pathname]);

  useSearchShortcut();

  // Sticky sidebar collapse — restore on load, persist on toggle.
  useEffect(() => {
    try { setCollapsed(localStorage.getItem('podium-sb-collapsed') === '1'); } catch { /* ignore */ }
  }, []);
  const toggle = useCallback(() => {
    setCollapsed(c => { const n = !c; try { localStorage.setItem('podium-sb-collapsed', n ? '1' : '0'); } catch { /* ignore */ } return n; });
  }, []);

  const navGroups = useMemo(() => filterNavByPerms(NAV_GROUPS, perms || {}), [perms]);

  if (loading && !user) return <Spinner />;

  const displayName = user?.full_name || user?.email || '';
  const chrome = chromeFor(pathname);

  function focusSearch() {
    try { document.querySelector('[data-search-primary]')?.focus(); } catch { /* ignore */ }
  }

  return (
    <div style={{ display: 'flex', height: '100dvh', overflow: 'hidden' }}>
      <PodiumSidebar
        groups={navGroups}
        pathname={pathname}
        onNavigate={(route) => router.push(route)}
        collapsed={collapsed}
        onToggle={toggle}
        userLabel={displayName}
        userRole={role || ''}
        onSearch={focusSearch}
        onSignOut={signOut}
      />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0, background: 'var(--bg)' }}>
        <PodiumTopbar crumb={chrome.crumb} title={chrome.title} lastRefreshed={lastRefreshed} userLabel={displayName} />
        <main className="pd-main" style={{ flex: 1, overflowY: 'auto', padding: '24px 28px 48px' }}>
          {children}
        </main>
      </div>

      {/* ── mobile app chrome (≤767px — CSS decides; desktop never shows it) ── */}
      <MobileTabBar navGroups={navGroups} pathname={pathname} moreOpen={sheetOpen}
        onGo={(r) => { setSheetOpen(false); router.push(r); }} onMore={() => setSheetOpen(s => !s)} />
      {sheetOpen && (
        <MobileSheet navGroups={navGroups} pathname={pathname} onGo={(r) => router.push(r)} onClose={() => setSheetOpen(false)}
          userLabel={displayName} userRole={role || ''} onLogout={signOut} />
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
  { route: '/dashboard', label: 'Home'      },
  { route: '/people',    label: 'Directory' },
  { route: '/me',        label: 'Me'        },
  { route: '/team',      label: 'Team'      },
];

function MobileTabBar({ navGroups, pathname, moreOpen, onGo, onMore }) {
  const flat = flatNav(navGroups);
  const tabs = MOBILE_TABS.map((t) => ({ ...t, it: flat.find((i) => i.route === t.route) })).filter((t) => t.it);
  return (
    <nav className="pd-tabbar">
      {tabs.map((t) => {
        const Icon = t.it.icon;
        const on = !moreOpen && onRoute(t.route, pathname);
        return (
          <button key={t.route} className={`pd-tab${on ? ' active' : ''}`} onClick={() => onGo(t.route)}>
            <Icon size={19} strokeWidth={on ? 2 : 1.75} style={{ flexShrink: 0 }} />
            <span>{t.label}</span>
          </button>
        );
      })}
      <button className={`pd-tab${moreOpen ? ' active' : ''}`} onClick={onMore}>
        <Menu size={19} strokeWidth={moreOpen ? 2 : 1.75} style={{ flexShrink: 0 }} />
        <span>More</span>
      </button>
    </nav>
  );
}

// ── mobile "More" sheet — the full nav, grouped like the rail ────────────────
function MobileSheet({ navGroups, pathname, onGo, onClose, userLabel, userRole, onLogout }) {
  const flats = navGroups.filter((g) => g.flat);
  const grouped = navGroups.filter((g) => !g.flat);
  return (
    <div className="pd-sheetwrap" onMouseDown={onClose}>
      <div className="pd-sheet" onMouseDown={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 14 }}>
          <div style={{ width: 36, height: 36, flexShrink: 0, borderRadius: 9, background: 'var(--yellow)',
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

        {grouped.map((g) => (
          <div key={g.id} style={{ marginBottom: 14 }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase',
              letterSpacing: '0.1em', padding: '0 2px 7px' }}>{g.label}</div>
            <div className="pd-sheet-grid">
              {(g.items || []).map((it) => {
                const Icon = it.icon;
                return (
                  <button key={it.route} className={`pd-sheet-item${onRoute(it.route, pathname) ? ' active' : ''}`} onClick={() => onGo(it.route)}>
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
            <div className="pd-sheet-grid">
              {flats.map((g) => {
                const Icon = g.icon;
                return (
                  <button key={g.route} className={`pd-sheet-item${onRoute(g.route, pathname) ? ' active' : ''}`} onClick={() => onGo(g.route)}>
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
