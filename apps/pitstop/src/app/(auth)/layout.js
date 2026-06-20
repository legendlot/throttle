'use client';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { RequireAuth, useAuth } from '@throttle/auth';
import { Spinner, AppLauncher, useSearchShortcut } from '@throttle/ui';
import { PitstopSidebar, PitstopTopbar, CommandPalette } from '../../components/kit/index.js';
import { csopsGet } from '../../lib/csopsFetch.js';
import DeptSwitcher, { getActiveDept } from '../../components/DeptSwitcher.js';

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
  const { user, brandUser, role, perms, session, signOut, loading } = useAuth();
  const { refreshing, lastRefreshed } = useRefreshState();
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [badges, setBadges] = useState({ open: 0, missed: 0 });

  // Global "/" → focus the primary search input on the active page.
  useSearchShortcut();

  // Global ⌘K / Ctrl+K → command palette · Esc → close.
  useEffect(() => {
    const h = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setCmdkOpen(o => !o); }
      else if (e.key === 'Escape') setCmdkOpen(false);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // Live sidebar badges (Queue=open · Calls=awaiting-callback). 30s refresh.
  useEffect(() => {
    if (!session) return undefined;
    let alive = true;
    const load = async () => {
      try {
        const dept = getActiveDept(perms, brandUser?.cs_department_slug) || undefined;
        const params = dept ? { department: dept } : {};
        const [counts, calls] = await Promise.all([
          csopsGet('getQueueCounts', params, session).catch(() => null),
          csopsGet('getCallsKpis', params, session).catch(() => null),
        ]);
        if (!alive) return;
        setBadges({
          open: counts?.open || 0,
          missed: calls?.unanswered_awaiting_callback || 0,
        });
      } catch { /* badges are best-effort */ }
    };
    load();
    const iv = setInterval(load, 30000);
    const onDept = () => load();
    window.addEventListener('pitstop:dept-changed', onDept);
    return () => { alive = false; clearInterval(iv); window.removeEventListener('pitstop:dept-changed', onDept); };
  }, [session, perms, brandUser?.cs_department_slug]);

  if (loading && !user) return <Spinner />;

  const displayName = user?.full_name || brandUser?.full_name || user?.email || '';
  const roleLabel = ({ cs_agent: 'Agent', cs_lead: 'Team Lead', admin: 'CS Admin', super_admin: 'Super Admin' }[role]) || role || '';

  return (
    <div style={{ display: 'flex', height: '100dvh', overflow: 'hidden' }}>
      <PitstopSidebar
        perms={perms || {}}
        badges={badges}
        userLabel={displayName}
        userRole={roleLabel}
        onCmdK={() => setCmdkOpen(true)}
        onLogout={signOut}
      />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <PitstopTopbar refreshing={refreshing} lastRefreshed={lastRefreshed}>
          <DeptSwitcher />
          <AppLauncher current="pitstop" />
        </PitstopTopbar>
        <main style={{ flex: 1, overflowY: 'auto', padding: 'var(--pad)' }}>
          {children}
        </main>
      </div>
      <CommandPalette open={cmdkOpen} onClose={() => setCmdkOpen(false)} perms={perms || {}} session={session} />
    </div>
  );
}
