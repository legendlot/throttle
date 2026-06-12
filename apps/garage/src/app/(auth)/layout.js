'use client';
import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { RequireAuth, useAuth } from '@throttle/auth';
import { Spinner, QuickCreate, useSearchShortcut } from '@throttle/ui';
import { useGarageNav, DEFAULT_PINS } from '../../lib/nav.js';
import { GarageSidebar } from '../../components/shell/GarageSidebar.js';
import { GarageTopbar } from '../../components/shell/GarageTopbar.js';
import { GarageCommandPalette } from '../../components/shell/GarageCommandPalette.js';
import { useGarageAlerts } from '../../hooks/useGarageAlerts.js';
import { Workflow, Inbox } from 'lucide-react';

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
        <main style={{ flex: 1, overflowY: 'auto', padding: '20px 26px' }}>
          {children}
        </main>
      </div>
      <QuickCreate groups={quickCreateGroups} />
      <GarageCommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} nav={nav} onNavigate={navigate} />
    </div>
  );
}
