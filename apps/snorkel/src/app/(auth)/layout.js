'use client';
import { useMemo, useState, useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { RequireAuth, useAuth } from '@throttle/auth';
import { Spinner, useSearchShortcut } from '@throttle/ui';
import { Menu, X, LogOut } from 'lucide-react';
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

  // ── mobile "More" bottom sheet (≤767px chrome; closes itself on navigation) ─
  const [sheetOpen, setSheetOpen] = useState(false);
  useEffect(() => { setSheetOpen(false); }, [pathname]);

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

      {/* ── mobile app chrome (≤767px — CSS decides; desktop never shows it) ── */}
      <MobileTabBar navGroups={navGroups} pathname={pathname} moreOpen={sheetOpen}
        onGo={(r) => { setSheetOpen(false); onNav(r); }} onMore={() => setSheetOpen((s) => !s)} />
      {sheetOpen && (
        <MobileSheet navGroups={navGroups} pathname={pathname} onGo={onNav} onClose={() => setSheetOpen(false)}
          userLabel={displayName} userInitial={initial} userRole={role || ''} onLogout={signOut} />
      )}
    </div>
  );
}

const onRoute = (route, pathname) => !!route && (pathname === route || pathname.startsWith(route + '/'));

// Flatten the perm-filtered nav (flat groups become single items) — the tab bar and
// sheet both read this, so gating stays identical to the rail.
function flatNav(navGroups) {
  const out = [];
  for (const g of navGroups) {
    if (g.flat) { out.push({ ...g }); continue; }
    for (const it of g.items || []) out.push(it);
  }
  return out;
}

// ── mobile bottom tab bar — four primary destinations + More ────────────────
const MOBILE_TABS = [
  { route: '/requests',        label: 'Requests' },
  { route: '/procurement/pos', label: 'POs'      },
  { route: '/sales/orders',    label: 'Sales'    },
  { route: '/payments',        label: 'Payments' },
];

function MobileTabBar({ navGroups, pathname, moreOpen, onGo, onMore }) {
  const flat = flatNav(navGroups);
  const tabs = MOBILE_TABS.map((t) => ({ ...t, it: flat.find((i) => i.route === t.route) })).filter((t) => t.it);
  return (
    <nav className="sn-tabbar">
      {tabs.map((t) => {
        const Icon = t.it.icon;
        const on = !moreOpen && onRoute(t.route, pathname);
        return (
          <button key={t.route} className={`sn-tab${on ? ' active' : ''}`} onClick={() => onGo(t.route)}>
            <Icon size={19} strokeWidth={on ? 2 : 1.75} style={{ flexShrink: 0 }} />
            <span>{t.label}</span>
          </button>
        );
      })}
      <button className={`sn-tab${moreOpen ? ' active' : ''}`} onClick={onMore}>
        <Menu size={19} strokeWidth={moreOpen ? 2 : 1.75} style={{ flexShrink: 0 }} />
        <span>More</span>
      </button>
    </nav>
  );
}

// ── mobile "More" sheet — the full nav, grouped like the rail ────────────────
function MobileSheet({ navGroups, pathname, onGo, onClose, userLabel, userInitial, userRole, onLogout }) {
  const flats = navGroups.filter((g) => g.flat);
  const grouped = navGroups.filter((g) => !g.flat);
  return (
    <div className="sn-sheetwrap" onMouseDown={onClose}>
      <div className="sn-sheet" onMouseDown={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 14 }}>
          <div style={{ width: 36, height: 36, flexShrink: 0, borderRadius: 9, background: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 700, color: 'var(--accent-fg)', fontSize: 15 }}>
            {userInitial}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {userLabel}
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--t3)' }}>{userRole}</div>
          </div>
          <button onClick={onLogout} title="Sign out"
            style={{ display: 'flex', padding: 6, borderRadius: 8, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--t3)' }}>
            <LogOut size={18} strokeWidth={1.75} />
          </button>
          <button onClick={onClose} title="Close"
            style={{ display: 'flex', padding: 6, borderRadius: 8, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--t2)' }}>
            <X size={19} strokeWidth={1.75} />
          </button>
        </div>

        {grouped.map((g) => (
          <div key={g.id} style={{ marginBottom: 14 }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase',
              letterSpacing: '0.1em', padding: '0 2px 7px' }}>{g.label}</div>
            <div className="sn-sheet-grid">
              {(g.items || []).map((it) => {
                const Icon = it.icon;
                return (
                  <button key={it.route} className={`sn-sheet-item${onRoute(it.route, pathname) ? ' active' : ''}`} onClick={() => onGo(it.route)}>
                    {Icon && <Icon size={17} strokeWidth={1.75} style={{ flexShrink: 0 }} />}
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        {flats.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase',
              letterSpacing: '0.1em', padding: '0 2px 7px' }}>Help</div>
            <div className="sn-sheet-grid">
              {flats.map((g) => {
                const Icon = g.icon;
                return (
                  <button key={g.route} className={`sn-sheet-item${onRoute(g.route, pathname) ? ' active' : ''}`} onClick={() => onGo(g.route)}>
                    {Icon && <Icon size={17} strokeWidth={1.75} style={{ flexShrink: 0 }} />}
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
