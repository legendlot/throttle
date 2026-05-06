'use client';
import { createContext, useContext, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { RequireAuth, useAuth } from '@throttle/auth';
import { TopNav, Spinner } from '@throttle/ui';
import { NAV_GROUPS } from '../../lib/nav.js';
import { usePendingCounts } from '../../hooks/usePendingCounts.js';

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

// ── Badge span helpers ────────────────────────────────────────
function NavBadge({ count, color }) {
  if (!count || count < 1) return null;
  const bg = color === 'red' ? '#de2a2a' : '#f97316';
  const fg = color === 'red' ? '#fff'    : '#000';
  return (
    <span style={{
      display: 'inline-block',
      background: bg, color: fg,
      fontSize: 9, fontWeight: 700,
      padding: '1px 5px',
      borderRadius: 8,
      marginLeft: 5,
      verticalAlign: 'middle',
      fontFamily: 'var(--mono)',
      letterSpacing: '0.04em',
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

  // Inject live badge elements into a copy of NAV_GROUPS
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

  // Show spinner only on first mount — not on background token refreshes
  if (loading && !user) return <Spinner />;

  return (
    <>
      <TopNav
        groups={navGroupsWithBadges}
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
