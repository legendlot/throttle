'use client';
import { useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { RequireAuth, useAuth } from '@throttle/auth';
import { Spinner, useSearchShortcut } from '@throttle/ui';
import { NAV_GROUPS, filterNavByPerms } from '../../lib/nav.js';
import { Sidebar } from '../../components/chrome/Sidebar.js';
import { ContextBar } from '../../components/chrome/ContextBar.js';

export default function AuthLayout({ children }) {
  return (
    <RequireAuth>
      <AuthLayoutInner>{children}</AuthLayoutInner>
    </RequireAuth>
  );
}

function AuthLayoutInner({ children }) {
  const { user, role, perms, signOut, loading } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [search, setSearch] = useState('');

  useSearchShortcut(); // "/" focuses the sidebar search ([data-search-primary])

  const navGroups = useMemo(() => filterNavByPerms(NAV_GROUPS, perms || {}), [perms]);

  if (loading && !user) return <Spinner />;

  const displayName = user?.full_name || user?.email || '';
  const initial = displayName ? displayName[0].toUpperCase() : '?';

  function onNav(route) {
    if (!route) return;
    setSearch('');
    router.push(route);
  }

  return (
    <div className="app mo">
      <Sidebar
        groups={navGroups}
        pathname={pathname}
        onNav={onNav}
        appIcon={<img src="/favicon.svg" alt="Relay" style={{ height: 18, width: 'auto', display: 'block' }} />}
        userLabel={displayName}
        userInitial={initial}
        userRole={role || ''}
        onLogout={signOut}
        collapsed={collapsed}
        onToggle={() => setCollapsed(c => !c)}
        search={search}
        onSearch={setSearch}
      />
      <div className="main-wrap">
        <ContextBar groups={navGroups} pathname={pathname} onNav={onNav} />
        <main className="main">{children}</main>
      </div>
    </div>
  );
}
