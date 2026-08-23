'use client';
import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { RequireAuth, useAuth } from '@throttle/auth';
import { Spinner, QuickCreate, useSearchShortcut } from '@throttle/ui';
import { useGarageNav, DEFAULT_PINS, allNavItems, matchRoute } from '../../lib/nav.js';
import { GarageSidebar } from '../../components/shell/GarageSidebar.js';
import { GarageTopbar } from '../../components/shell/GarageTopbar.js';
import { GarageCommandPalette } from '../../components/shell/GarageCommandPalette.js';
import { useGarageAlerts } from '../../hooks/useGarageAlerts.js';
import { Workflow, Inbox, Menu, X, LogOut } from 'lucide-react';

const RefreshContext = createContext({ refreshing: false, setRefreshing: () => {} });

export function RefreshProvider({ children }) {
  const [refreshing, setRefreshing] = useState(false);
  return (
    <RefreshContext.Provider value={{ refreshing, setRefreshing }}>
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
  const { user, session, role, signOut, perms, loading } = useAuth();
  const pathname = usePathname();
  const router   = useRouter();
  const nav = useGarageNav(perms || {});
  const { alertCount } = useGarageAlerts(session);
  const { refreshing } = useRefreshState();

  // Global "/" → focus the primary search input on the active page.
  useSearchShortcut();

  // ── Collapsible rail (persist g-a-collapsed) ──────────────────────────
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => { setCollapsed(localStorage.getItem('g-a-collapsed') === '1'); }, []);
  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => { const next = !c; localStorage.setItem('g-a-collapsed', next ? '1' : '0'); return next; });
  }, []);

  // ── User-managed pins (persist g-pins) ────────────────────────────────
  const [pins, setPins] = useState(DEFAULT_PINS);
  useEffect(() => {
    try { const v = JSON.parse(localStorage.getItem('g-pins')); if (Array.isArray(v)) setPins(v); } catch (_) {}
  }, []);
  const togglePin = useCallback((route) => {
    setPins((prev) => {
      const next = prev.includes(route) ? prev.filter((r) => r !== route) : [...prev, route];
      localStorage.setItem('g-pins', JSON.stringify(next));
      return next;
    });
  }, []);

  // ── ⌘K command palette ────────────────────────────────────────────────
  const [paletteOpen, setPaletteOpen] = useState(false);

  // ── mobile "More" bottom sheet (≤767px chrome; closes itself on navigation) ─
  const [sheetOpen, setSheetOpen] = useState(false);
  useEffect(() => { setSheetOpen(false); }, [pathname]);
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen((p) => !p); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const navigate = useCallback((route) => { if (route) router.push(route); }, [router]);
  const onRefresh = useCallback(() => { window.dispatchEvent(new Event('garage:refresh')); }, []);

  const quickCreateGroups = [
    {
      label: 'Production',
      actions: [
        { label: 'Line Flush', icon: Workflow, onClick: () => router.push('/line-flush') },
      ],
    },
    {
      label: 'Inventory',
      actions: [
        { label: 'New GRN', icon: Inbox, onClick: () => router.push('/grn') },
      ],
    },
  ];

  if (loading && !user) return <Spinner />;

  const displayName = user?.full_name || user?.email || '';
  const initial     = displayName ? displayName[0].toUpperCase() : '?';

  return (
    <div style={{ display: 'flex', height: '100dvh', overflow: 'hidden' }}>
      <GarageSidebar
        nav={nav}
        pathname={pathname}
        onNavigate={navigate}
        pins={pins}
        onTogglePin={togglePin}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        onOpenPalette={() => setPaletteOpen(true)}
        userLabel={displayName}
        userInitial={initial}
        userRole={role || ''}
        onLogout={signOut}
        alertCount={alertCount}
      />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <GarageTopbar
          nav={nav}
          pathname={pathname}
          onOpenPalette={() => setPaletteOpen(true)}
          pins={pins}
          onTogglePin={togglePin}
          onRefresh={onRefresh}
          refreshing={refreshing}
        />
        <main className="g-main" style={{ flex: 1, overflowY: 'auto', padding: '20px 26px' }}>
          {children}
        </main>
      </div>
      <QuickCreate groups={quickCreateGroups} />
      <GarageCommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} nav={nav} onNavigate={navigate} />

      {/* ── mobile app chrome (≤767px — CSS decides; desktop never shows it) ── */}
      <MobileTabBar nav={nav} pathname={pathname} moreOpen={sheetOpen}
        onGo={(r) => { setSheetOpen(false); navigate(r); }} onMore={() => setSheetOpen((s) => !s)} />
      {sheetOpen && (
        <MobileSheet nav={nav} pathname={pathname} onGo={navigate} onClose={() => setSheetOpen(false)}
          userLabel={displayName} userInitial={initial} userRole={role || ''} onLogout={signOut} />
      )}
    </div>
  );
}

// ── mobile bottom tab bar ────────────────────────────────────────────────────
// Four primary destinations + More. A tab renders only if the perm-filtered nav
// contains its route, so gating stays identical to the rail.
const MOBILE_TABS = [
  { route: '/dashboard',   label: 'Overview' },
  { route: '/issue-queue', label: 'Issues'   },
  { route: '/stock',       label: 'Stock'    },
  { route: '/grn',         label: 'GRN'      },
];

function MobileTabBar({ nav, pathname, moreOpen, onGo, onMore }) {
  const flat = allNavItems(nav);
  const tabs = MOBILE_TABS.map((t) => ({ ...t, it: flat.find((i) => i.route === t.route) })).filter((t) => t.it);
  return (
    <nav className="g-tabbar">
      {tabs.map((t) => {
        const Icon = t.it.icon;
        const on = !moreOpen && matchRoute(t.route, pathname);
        return (
          <button key={t.route} className={`g-tab${on ? ' active' : ''}`} onClick={() => onGo(t.route)}>
            <Icon size={19} strokeWidth={on ? 2 : 1.75} style={{ flexShrink: 0 }} />
            <span>{t.label}</span>
          </button>
        );
      })}
      <button className={`g-tab${moreOpen ? ' active' : ''}`} onClick={onMore}>
        <Menu size={19} strokeWidth={moreOpen ? 2 : 1.75} style={{ flexShrink: 0 }} />
        <span>More</span>
      </button>
    </nav>
  );
}

// ── mobile "More" sheet — the full nav, grouped like the rail ────────────────
function MobileSheet({ nav, pathname, onGo, onClose, userLabel, userInitial, userRole, onLogout }) {
  const groups = [];
  const singles = nav.primary.filter((g) => g.single);
  if (singles.length) groups.push({ label: 'Overview', items: singles.map((g) => ({ ...g, route: g.route })) });
  for (const g of nav.primary) if (!g.single) groups.push({ label: g.label, items: g.items });
  if (nav.drawer.items.length) groups.push({ label: nav.drawer.label, items: nav.drawer.items });
  return (
    <div className="g-sheetwrap" onMouseDown={onClose}>
      <div className="g-sheet" onMouseDown={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 14 }}>
          <div style={{ width: 36, height: 36, flexShrink: 0, borderRadius: 'var(--r-sm)', background: 'var(--yellow)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'var(--font-display)', fontWeight: 700, color: '#17140a', fontSize: 15 }}>
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

        {groups.map((g) => (
          <div key={g.label} style={{ marginBottom: 14 }}>
            <div className="eyebrow" style={{ padding: '0 2px 7px' }}>{g.label}</div>
            <div className="g-sheet-grid">
              {g.items.map((it) => {
                const Icon = it.icon;
                const on = matchRoute(it.route, pathname);
                return (
                  <button key={it.route} className={`g-sheet-item${on ? ' active' : ''}`} onClick={() => onGo(it.route)}>
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
