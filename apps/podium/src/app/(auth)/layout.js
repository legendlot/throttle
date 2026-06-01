'use client';
import { createContext, useContext, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { RequireAuth, useAuth } from '@throttle/auth';
import { Sidebar, Spinner, Topbar, useSearchShortcut } from '@throttle/ui';
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
        appLabel="PODIUM"
        appShortLabel="PD"
        appIcon={<img src="/favicon.svg" alt="Podium" style={{ height: 20, width: 'auto', display: 'block' }} />}
      />
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
        <Topbar
          navGroups={navGroups}
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
