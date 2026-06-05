'use client';
import { useMemo, useState, useEffect, useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { RequireAuth, useAuth } from '@throttle/auth';
import { Sidebar, Spinner, Topbar, useSearchShortcut } from '@throttle/ui';
import { buildNavGroups } from '../../lib/nav.js';
import { docketopsGet } from '../../lib/docketopsFetch.js';

export default function AuthLayout({ children }) {
  return (
    <RequireAuth>
      <AuthLayoutInner>{children}</AuthLayoutInner>
    </RequireAuth>
  );
}

function AuthLayoutInner({ children }) {
  const { user, role, perms, session, signOut, loading } = useAuth();
  const pathname  = usePathname();
  const search    = useSearchParams();
  const router    = useRouter();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [spaces, setSpaces] = useState([]);

  useSearchShortcut();

  // Accessible spaces drive the sidebar (General + owned/member private spaces).
  const loadSpaces = useCallback(() => {
    if (!session) return;
    docketopsGet('getMe', {}, session).then(me => setSpaces(me?.spaces || [])).catch(() => {});
  }, [session]);
  useEffect(() => { loadSpaces(); }, [loadSpaces]);
  // Re-fetch when a space is created/renamed/archived (signalled via a window event).
  useEffect(() => {
    const h = () => loadSpaces();
    window.addEventListener('docket:spaces-changed', h);
    return () => window.removeEventListener('docket:spaces-changed', h);
  }, [loadSpaces]);

  const navGroups = useMemo(() => buildNavGroups(perms || {}, spaces), [perms, spaces]);

  // The Sidebar matches active by route string. Space items carry the ?space= query,
  // so the active key must include it when we're on the Tasks list inside a space.
  const spaceParam = search.get('space');
  const activeKey = pathname === '/tasks' && spaceParam && spaceParam !== 'new'
    ? `/tasks?space=${spaceParam}` : pathname;

  if (loading && !user) return <Spinner />;

  const displayName = user?.full_name || user?.email || '';
  const initial     = displayName ? displayName[0].toUpperCase() : '?';

  return (
    <div style={{ display:'flex', height:'100dvh', overflow:'hidden' }}>
      <Sidebar
        groups={navGroups}
        activeTab={activeKey}
        onTabSelect={(item) => router.push(item.route)}
        userLabel={displayName}
        userInitial={initial}
        userRole={role || ''}
        onLogout={signOut}
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed(c => !c)}
        appLabel="DOCKET"
        appShortLabel="DK"
        appIcon={<img src="/favicon.svg" alt="Docket" style={{ height: 20, width: 'auto', display: 'block' }} />}
      />
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
        <Topbar
          navGroups={navGroups}
          pathname={pathname}
          onTabSelect={(item) => router.push(item.route)}
        />
        <main style={{ flex:1, overflowY:'auto', padding:'16px 24px' }}>
          {children}
        </main>
      </div>
    </div>
  );
}
