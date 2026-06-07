'use client';
import { createContext, useContext, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { RequireAuth, useAuth } from '@throttle/auth';
import { Sidebar, Spinner, Topbar, QuickCreate, useSearchShortcut } from '@throttle/ui';
import { useNavGroups } from '../../lib/nav.js';
import { GarageIcon } from '../../components/GarageIcon.js';
import { useGarageAlerts } from '../../hooks/useGarageAlerts.js';
import { ClipboardList, Workflow, Inbox } from 'lucide-react';

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
  const { user, session, role, signOut, perms, loading } = useAuth();
  const pathname  = usePathname();
  const router    = useRouter();
  const rawNavGroups = useNavGroups(perms || {});
  const { alertCount } = useGarageAlerts(session);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Global "/" → focus the primary search input on the active page.
  useSearchShortcut();

  function NavBadge({ count, color }) {
    if (!count || count < 1) return null;
    return (
      <span style={{
        display: 'inline-block',
        background: color === 'red' ? '#de2a2a' : '#f97316',
        color: '#fff',
        fontSize: 9, fontWeight: 700, padding: '1px 5px',
        borderRadius: 8, marginLeft: 5,
        fontFamily: 'var(--mono)', letterSpacing: '.04em',
      }}>
        {count > 99 ? '99+' : count}
      </span>
    );
  }

  const navGroups = useMemo(() => {
    return rawNavGroups.map(group => ({
      ...group,
      items: (group.items || []).map(item => {
        if (item.id === 'alerts' && item.badgeColor) {
          return { ...item, badge: <NavBadge count={alertCount} color={item.badgeColor} /> };
        }
        return item;
      }),
    }));
  }, [rawNavGroups, alertCount]);

  const quickCreateGroups = [
    {
      label: 'Production',
      actions: [
        // Run requests (fresh / repair / outsourced / repack) now live in Redline → New Run / Request.
        { label: 'Ad Hoc Issue',       icon: ClipboardList, onClick: () => router.push('/work-orders') },
        { label: 'Line Flush',         icon: Workflow,      onClick: () => router.push('/line-flush') },
      ],
    },
    {
      label: 'Inventory',
      actions: [
        { label: 'New GRN', icon: Inbox, onClick: () => router.push('/grn') },
      ],
    },
  ];

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
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <Topbar
          navGroups={navGroups}
          pathname={pathname}
          onTabSelect={(item) => router.push(item.route)}
        />
        <main style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>
          {children}
        </main>
      </div>
      <QuickCreate groups={quickCreateGroups} />
    </div>
  );
}
