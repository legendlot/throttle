'use client';
import { useMemo, useState, useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { RequireAuth, useAuth } from '@throttle/auth';
import { Spinner, useSearchShortcut } from '@throttle/ui';
import { NAV_GROUPS, filterNavByPerms } from '../../lib/nav.js';
import { Sidebar } from '../../components/chrome/Sidebar.js';
import { ContextBar } from '../../components/chrome/ContextBar.js';
import { GlobalSearch } from '../../components/chrome/GlobalSearch.js';
import { useGlobalSearch } from '../../components/chrome/useGlobalSearch.js';

export default function AuthLayout({ children }) {
  return (
    <RequireAuth>
      <AuthLayoutInner>{children}</AuthLayoutInner>
    </RequireAuth>
  );
}

function AuthLayoutInner({ children }) {
  const { user, role, perms, session, signOut, loading } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [search, setSearch] = useState('');

  useSearchShortcut(); // "/" focuses the sidebar search ([data-search-primary])

  const navGroups = useMemo(() => filterNavByPerms(NAV_GROUPS, perms || {}), [perms]);
  const { ensureLoaded, runSearch, ready } = useGlobalSearch(session, perms);

  // load the cross-entity index the first time the user searches
  useEffect(() => { if (search.trim()) ensureLoaded(); }, [search, ensureLoaded]);
  // Escape clears search
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') setSearch(''); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const groups = useMemo(() => (search.trim() ? runSearch(search) : []), [search, runSearch, ready]);

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
        appIcon={<img src="/favicon.svg" alt="Snorkel" style={{ height: 18, width: 'auto', display: 'block' }} />}
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

      {search.trim() && (
        <GlobalSearch
          query={search}
          groups={groups}
          onNav={onNav}
          onPick={() => setSearch('')}
          collapsed={collapsed}
        />
      )}
    </div>
  );
}
