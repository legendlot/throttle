'use client';
import { createContext, useContext, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { RequireAuth, useAuth } from '@throttle/auth';
import { Sidebar, Spinner, Topbar } from '@throttle/ui';
import { NAV_GROUPS } from '../../lib/nav.js';
import { usePendingCounts } from '../../hooks/usePendingCounts.js';
import { RedlineIcon } from '../../components/RedlineIcon.js';

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

function NavBadge({ count, color }) {
  if (!count || count < 1) return null;
  const bg = color === 'red' ? 'var(--brand-red)' : 'var(--brand-orange)';
  const fg = color === 'red' ? '#fff' : 'var(--accent-fg)';
  return (
    <span style={{
      display: 'inline-block', background: bg, color: fg,
      fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700,
      letterSpacing: '0.04em',
      padding: '2px 7px', borderRadius: 9999, marginLeft: 6,
      minWidth: 18, textAlign: 'center', lineHeight: 1.2,
    }}>
      {count > 99 ? '99+' : count}
    </span>
  );
}

function AuthLayoutInner({ children }) {
  const { user, session, role, signOut, loading } = useAuth();
  const pathname  = usePathname();
  const router    = useRouter();
  const { refreshing, lastRefreshed } = useRefreshState();
  const { alertCount, returnCount }   = usePendingCounts(session);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);

  const navGroupsWithBadges = useMemo(() => {
    return NAV_GROUPS.map(group => ({
      ...group,
      items: (group.items || []).map(item => {
        if (item.id === 'alerts' && item.badgeColor) {
          return { ...item, badge: <NavBadge count={alertCount}  color={item.badgeColor} /> };
        }
        if (item.id === 'returns' && item.badgeColor) {
          return { ...item, badge: <NavBadge count={returnCount} color={item.badgeColor} /> };
        }
        return item;
      }),
    }));
  }, [alertCount, returnCount]);

  if (loading && !user) return <Spinner />;

  const displayName = user?.full_name || user?.email || '';
  const initial     = displayName ? displayName[0].toUpperCase() : '?';

  return (
    <div style={{ display:'flex', height:'100dvh', overflow:'hidden' }}>
      <Sidebar
        groups={navGroupsWithBadges}
        activeTab={pathname}
        onTabSelect={(item) => router.push(item.route)}
        userLabel={displayName}
        userInitial={initial}
        userRole={role || ''}
        onLogout={signOut}
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed(c => !c)}
        appLabel="REDLINE"
        appShortLabel="RL"
        appIcon={<RedlineIcon bar={2} gap={2} />}
      />
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
        <Topbar
          navGroups={navGroupsWithBadges}
          pathname={pathname}
          onTabSelect={(item) => router.push(item.route)}
          refreshing={refreshing}
          lastRefreshed={lastRefreshed}
        />
        <main style={{ flex:1, overflowY:'auto', padding:'16px 24px' }}>
          {children}
        </main>
      </div>
    </div>
  );
}
