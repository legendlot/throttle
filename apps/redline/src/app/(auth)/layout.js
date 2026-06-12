'use client';
import { createContext, useContext, useEffect, useState } from 'react';
import { RequireAuth, useAuth } from '@throttle/auth';
import { Spinner, useSearchShortcut } from '@throttle/ui';
import { usePendingCounts } from '../../hooks/usePendingCounts.js';
import { RedlineSidebar, RedlineTopbar, CommandPalette } from '../../components/kit/index.js';

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
  const { user, session, role, signOut, loading } = useAuth();
  const { refreshing, lastRefreshed } = useRefreshState();
  const { alertCount, returnCount }   = usePendingCounts(session);
  const [cmdkOpen, setCmdkOpen] = useState(false);

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
      <RedlineSidebar
        onCmdK={() => setCmdkOpen(true)}
        badges={{ alerts: alertCount, returns: returnCount }}
        userLabel={displayName}
        userRole={role || ''}
        onLogout={signOut}
      />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <RedlineTopbar refreshing={refreshing} lastRefreshed={lastRefreshed} />
        <main style={{ flex: 1, overflowY: 'auto', padding: '22px 26px' }}>
          {children}
        </main>
      </div>
      <CommandPalette open={cmdkOpen} onClose={() => setCmdkOpen(false)} />
    </div>
  );
}
