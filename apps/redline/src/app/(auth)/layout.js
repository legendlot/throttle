'use client';
import { createContext, useContext, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { RequireAuth, useAuth } from '@throttle/auth';
import { TopNav, Spinner } from '@throttle/ui';
import { NAV_GROUPS } from '../../lib/nav.js';

// ── Refresh context ───────────────────────────────────────────
// Exposes refreshing + lastRefreshed so pages can drive the TopNav
// spinner and the "last updated" timestamp without prop-drilling.
const RefreshContext = createContext({
  refreshing:       false,
  setRefreshing:    () => {},
  lastRefreshed:    null,
  setLastRefreshed: () => {},
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

// ── Route group layout ────────────────────────────────────────
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
  const pathname  = usePathname();
  const router    = useRouter();
  const { refreshing, lastRefreshed } = useRefreshState();

  // Show spinner only on first mount — not on background token refreshes
  if (loading && !user) return <Spinner />;

  return (
    <>
      <TopNav
        groups={NAV_GROUPS}
        activeTab={pathname}
        onTabSelect={(item) => router.push(item.route)}
        rightSlot={
          <span style={{ color: 'var(--t3)', fontSize: 12, fontFamily: 'var(--mono)' }}>
            {user?.full_name || user?.email}&nbsp;·&nbsp;{role}
          </span>
        }
        onLogout={signOut}
        refreshing={refreshing}
        lastRefreshed={lastRefreshed}
      />
      <main style={{ padding: '16px 24px', position: 'relative', zIndex: 1 }}>
        {children}
      </main>
    </>
  );
}
