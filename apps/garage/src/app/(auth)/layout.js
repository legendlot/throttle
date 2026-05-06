'use client';
import { createContext, useContext, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { RequireAuth, useAuth } from '@throttle/auth';
import { Sidebar, Spinner } from '@throttle/ui';
import { useNavGroups } from '../../lib/nav.js';
import { GarageIcon } from '../../components/GarageIcon.js';

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
  const { user, role, signOut, perms, loading } = useAuth();
  const pathname  = usePathname();
  const router    = useRouter();
  const navGroups = useNavGroups(perms || {});
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  if (loading && !user) return <Spinner />;

  const displayName = user?.full_name || user?.email || '';
  const initial     = displayName ? displayName[0].toUpperCase() : '?';

  return (
    <div style={{ display: 'flex', height: '100dvh', overflow: 'hidden' }}>
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
        appLabel="GARAGE"
        appShortLabel="G"
        appIcon={<GarageIcon size={20} strokeWidth={2.5} />}
      />
      <main style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>
        {children}
      </main>
    </div>
  );
}
