'use client';
import { createContext, useContext, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { RequireAuth, useAuth } from '@throttle/auth';
import { Sidebar, Spinner } from '@throttle/ui';
import { NAV_GROUPS } from '../../lib/nav.js';
import { usePendingCounts } from '../../hooks/usePendingCounts.js';
import { RedlineIcon } from '../../components/RedlineIcon.js';

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

function NavBadge({ count, color }) {
  if (!count || count < 1) return null;
  const bg = color === 'red' ? '#de2a2a' : '#f97316';
  const fg = color === 'red' ? '#fff'    : '#000';
  return (
    <span style={{
      display:'inline-block', background:bg, color:fg,
      fontSize:9, fontWeight:700, padding:'1px 5px',
      borderRadius:8, marginLeft:5, fontFamily:'var(--mono)', letterSpacing:'0.04em',
    }}>
      {count > 99 ? '99+' : count}
    </span>
  );
}

function Topbar({ navGroups, pathname, onTabSelect, refreshing, lastRefreshed }) {
  const activeGroup = navGroups.find(g =>
    (g.items || []).some(i => pathname === i.route || pathname.startsWith(i.route + '/'))
  ) || navGroups[0];

  const subTabs  = (activeGroup?.items || []).filter(i => !i.separator);
  const activeItem = subTabs.find(i =>
    pathname === i.route || pathname.startsWith(i.route + '/')
  ) || subTabs[0];

  const showSubTabs = subTabs.length > 1;

  return (
    <div style={{
      height: 44, borderBottom: '1px solid var(--border)',
      display: 'flex', alignItems: 'center', padding: '0 20px',
      gap: 10, flexShrink: 0, background: '#0e0e0e',
    }}>
      <span style={{ fontSize:10, color:'var(--t3)', letterSpacing:'.1em', fontFamily:'var(--mono)' }}>
        {activeGroup?.label}
      </span>
      <span style={{ color:'var(--border2)', fontSize:14 }}>/</span>
      <span style={{ fontSize:11, fontWeight:700, letterSpacing:'.06em', color:'var(--t1)', fontFamily:'var(--mono)' }}>
        {activeItem?.label?.toUpperCase() || ''}
      </span>

      {showSubTabs && (
        <div style={{ display:'flex', gap:2, marginLeft:20, borderLeft:'1px solid var(--border)', paddingLeft:14 }}>
          {subTabs.map(item => {
            const isActive = pathname === item.route || pathname.startsWith(item.route + '/');
            return (
              <button key={item.id} onClick={() => onTabSelect(item)} style={{
                background: isActive ? 'rgba(242,205,26,.07)' : 'none',
                border: 'none', borderRadius: 4, padding: '4px 10px',
                fontSize: 10, color: isActive ? 'var(--yellow)' : 'var(--t3)',
                cursor: 'pointer', fontFamily: 'var(--mono)',
                display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap',
              }}>
                {item.label}
                {item.badge || null}
              </button>
            );
          })}
        </div>
      )}

      <div style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:12 }}>
        {refreshing && (
          <span style={{ fontSize:9, color:'var(--t3)', letterSpacing:'.1em' }}>↻ UPDATING</span>
        )}
        {lastRefreshed && !refreshing && (
          <span style={{ fontSize:9, color:'var(--t3)', letterSpacing:'.04em' }}>{lastRefreshed}</span>
        )}
        <span style={{ fontSize:9, color:'var(--t3)', letterSpacing:'.04em', display:'flex', alignItems:'center', gap:5 }}>
          <span style={{ width:6, height:6, background:'var(--green)', borderRadius:'50%', display:'inline-block' }} />
          LIVE
        </span>
      </div>
    </div>
  );
}

function AuthLayoutInner({ children }) {
  const { user, session, role, signOut, loading } = useAuth();
  const pathname  = usePathname();
  const router    = useRouter();
  const { refreshing, lastRefreshed } = useRefreshState();
  const { alertCount, returnCount }   = usePendingCounts(session);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);

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

  if (loading && !user) return <Spinner />;

  const displayName = user?.full_name || user?.email || '';
  const initial     = displayName ? displayName[0].toUpperCase() : '?';

  return (
    <div style={{ display:'flex', height:'100dvh', overflow:'hidden' }}>
      <Sidebar
        groups={navGroupsWithBadges}
        activeTab={pathname}
        onTabSelect={(item) => router.push(item.route)}
        userLabel={displayName}
        userInitial={initial}
        userRole={role || ''}
        onLogout={signOut}
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed(c => !c)}
        appLabel="REDLINE"
        appShortLabel="RL"
        appIcon={<RedlineIcon bar={2} gap={2} />}
      />
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
        <Topbar
          navGroups={navGroupsWithBadges}
          pathname={pathname}
          onTabSelect={(item) => router.push(item.route)}
          refreshing={refreshing}
          lastRefreshed={lastRefreshed}
        />
        <main style={{ flex:1, overflowY:'auto', padding:'16px 24px' }}>
          {children}
        </main>
      </div>
    </div>
  );
}
