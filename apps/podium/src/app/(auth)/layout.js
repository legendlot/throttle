'use client';
import { createContext, useContext, useMemo, useState, useEffect, useCallback } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { RequireAuth, useAuth } from '@throttle/auth';
import { Spinner, useSearchShortcut } from '@throttle/ui';
import { NAV_GROUPS, filterNavByPerms } from '../../lib/nav.js';
import { PodiumSidebar } from '../../components/PodiumSidebar.js';
import { PodiumTopbar } from '../../components/PodiumTopbar.js';

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

// Group eyebrow + screen title for the topbar, keyed by route.
const META = {
  '/dashboard':         { crumb: 'People',      title: 'Dashboard' },
  '/people':            { crumb: 'People',      title: 'Directory' },
  '/people/detail':     { crumb: 'People',      title: 'Profile' },
  '/people/new':        { crumb: 'People',      title: 'New Person' },
  '/org':               { crumb: 'People',      title: 'Org Chart' },
  '/me':                { crumb: 'Performance', title: 'My Performance' },
  '/team':              { crumb: 'Performance', title: 'Team' },
  '/appraisals':        { crumb: 'Performance', title: 'Appraisals' },
  '/appraisals/cycle':  { crumb: 'Performance', title: 'Appraisal Cycle' },
  '/appraisals/detail': { crumb: 'Performance', title: 'Appraisal' },
  '/appraisals/letter': { crumb: 'Performance', title: 'Appraisal Letter' },
  '/roles':             { crumb: 'Org Design',  title: 'Roles & KPIs' },
  '/roles/detail':      { crumb: 'Org Design',  title: 'Role' },
  '/departments':       { crumb: 'Org Design',  title: 'Departments' },
  '/manual':            { crumb: 'Org Design',  title: 'System Manual' },
  '/admin/roles':       { crumb: 'Admin',       title: 'Permissions' },
  '/admin/users':       { crumb: 'Admin',       title: 'Users' },
  '/admin/settings':    { crumb: 'Admin',       title: 'Settings' },
};
function chromeFor(pathname) {
  const clean = (pathname || '').replace(/\/$/, '') || '/';
  if (META[clean]) return META[clean];
  // longest-prefix fallback for nested routes
  let best = null, len = -1;
  for (const k of Object.keys(META)) {
    if ((clean === k || clean.startsWith(k + '/')) && k.length > len) { best = META[k]; len = k.length; }
  }
  return best || { crumb: '', title: 'Podium' };
}

function AuthLayoutInner({ children }) {
  const { user, role, perms, signOut, loading } = useAuth();
  const pathname  = usePathname();
  const router    = useRouter();
  const { lastRefreshed } = useRefreshState();
  const [collapsed, setCollapsed] = useState(false);   // default expanded (§4/§6)

  useSearchShortcut();

  // Sticky sidebar collapse — restore on load, persist on toggle.
  useEffect(() => {
    try { setCollapsed(localStorage.getItem('podium-sb-collapsed') === '1'); } catch { /* ignore */ }
  }, []);
  const toggle = useCallback(() => {
    setCollapsed(c => { const n = !c; try { localStorage.setItem('podium-sb-collapsed', n ? '1' : '0'); } catch { /* ignore */ } return n; });
  }, []);

  const navGroups = useMemo(() => filterNavByPerms(NAV_GROUPS, perms || {}), [perms]);

  if (loading && !user) return <Spinner />;

  const displayName = user?.full_name || user?.email || '';
  const chrome = chromeFor(pathname);

  function focusSearch() {
    try { document.querySelector('[data-search-primary]')?.focus(); } catch { /* ignore */ }
  }

  return (
    <div style={{ display: 'flex', height: '100dvh', overflow: 'hidden' }}>
      <PodiumSidebar
        groups={navGroups}
        pathname={pathname}
        onNavigate={(route) => router.push(route)}
        collapsed={collapsed}
        onToggle={toggle}
        userLabel={displayName}
        userRole={role || ''}
        onSearch={focusSearch}
        onSignOut={signOut}
      />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0, background: 'var(--bg)' }}>
        <PodiumTopbar crumb={chrome.crumb} title={chrome.title} lastRefreshed={lastRefreshed} userLabel={displayName} />
        <main style={{ flex: 1, overflowY: 'auto', padding: '24px 28px 48px' }}>
          {children}
        </main>
      </div>
    </div>
  );
}
