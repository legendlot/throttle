'use client';
import { createContext, useContext, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { RequireAuth, useAuth } from '@throttle/auth';
import { TopNav, Spinner } from '@throttle/ui';
import { useNavGroups } from '../../lib/nav.js';

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
  const pathname = usePathname();
  const router = useRouter();
  const { refreshing } = useRefreshState();
  const navGroups = useNavGroups(perms || {});

  if (loading) return <Spinner />;

  return (
    <>
      <TopNav
        groups={navGroups}
        activeTab={pathname}
        onTabSelect={(item) => router.push(item.route)}
        rightSlot={<span style={{ color: '#888', fontSize: 12 }}>{user?.full_name || user?.email} · {role}</span>}
        onLogout={signOut}
        refreshing={refreshing}
      />
      <main style={{ padding: '16px 24px' }}>{children}</main>
    </>
  );
}
