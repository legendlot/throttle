'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { RequireAuth, useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { Menu, X, LogOut } from 'lucide-react';
import { garageFetch } from '@throttle/db';
import { NAV_GROUPS, filterNavByPerms } from '../../lib/nav.js';
import { Sidebar } from '../../components/chrome/Sidebar.js';
import { ContextBar } from '../../components/chrome/ContextBar.js';
import { CommandPalette } from '../../components/chrome/CommandPalette.js';
import { ConfirmProvider } from '../../components/confirm.js';

const SB_KEY = 'relay-sb-collapsed';
const ONAIR_POLL_MS = 60_000;

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
  // Sidebar collapse persists across sessions (handoff §4 — localStorage).
  const [collapsed, setCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // ── mobile "More" bottom sheet (≤767px chrome; closes itself on navigation) ─
  const [sheetOpen, setSheetOpen] = useState(false);
  useEffect(() => { setSheetOpen(false); }, [pathname]);
  // ON AIR rail — the currently-sending broadcast, from the same campaign data
  // the Campaigns list already reads (status === 'sending'). Read-only polling.
  const [onair, setOnair] = useState(null);

  useEffect(() => {
    try { setCollapsed(localStorage.getItem(SB_KEY) === '1'); } catch { /* noop */ }
  }, []);
  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      try { localStorage.setItem(SB_KEY, c ? '0' : '1'); } catch { /* noop */ }
      return !c;
    });
  }, []);

  // ⌘K / Ctrl+K opens the palette from every screen.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Poll for an in-flight send (light: one list call; progress only when live).
  // Gated on relay_view — commsops blanket-gates every GET on it, so polling
  // without the perm is a guaranteed 403 per minute (hostile-review fix).
  const canView = !perms || perms.relay_view;
  useEffect(() => {
    if (!session || !canView) return undefined;
    let dead = false;
    async function tick() {
      try {
        const cs = await garageFetch('getCampaigns', {}, session);
        const sending = (Array.isArray(cs) ? cs : []).filter((c) => c.status === 'sending');
        if (dead) return;
        if (!sending.length) { setOnair(null); return; }
        const c = sending[0];
        let sent = 0, total = Number(c.audience_snapshot || 0);
        try {
          // Single-campaign stats, NOT getCampaignsOverview: this poll only needs `sent` for
          // the one sending campaign, and the overview aggregates EVERY campaign (~2s+ in the
          // DB). During a live send this widget was the page's slowest request AND re-ran that
          // aggregate on every poll tick (S293 load profile — the duplicate overview call set
          // the whole home load's 7.3s tail). campaign_stats(id) is ~0.3s.
          const o = await garageFetch('getCampaignStats', { id: c.id }, session);
          // ⚠️ Take `sent` from the stats but KEEP audience_snapshot as the denominator.
          // This was `total = Number(o.total || total)`, which threw away the correct value it
          // had just computed: stats `total` counts comms.messages rows that EXIST, and the
          // fan-out creates those just ahead of sending, so the rail sat at ~99% for an entire
          // send. Measured 2026-08-14 at 881/886 while 7,000 of 7,971 were still unreached.
          // Same defect + fix in the Control Tower "Sending now" panel — (auth)/page.js.
          if (o) { sent = Number(o.sent || 0); total = Number(total || o.total || 0); }
        } catch { /* progress optional */ }
        if (!dead) setOnair({ id: c.id, name: c.name, sent, total });
      } catch { /* transient failure — keep the last known rail rather than
                  dropping it mid-send; the next successful tick corrects it */ }
    }
    tick();
    const t = setInterval(tick, ONAIR_POLL_MS);
    return () => { dead = true; clearInterval(t); };
  }, [session, canView]);

  const navGroups = useMemo(() => filterNavByPerms(NAV_GROUPS, perms || {}), [perms]);

  if (loading && !user) return <Spinner />;

  const displayName = user?.full_name || user?.email || '';
  const initial = displayName ? displayName[0].toUpperCase() : '?';

  function onNav(route) {
    if (!route) return;
    router.push(route);
  }

  return (
    <ConfirmProvider>
    <div className="app mo">
      <Sidebar
        groups={navGroups}
        pathname={pathname}
        onNav={onNav}
        onair={onair}
        userLabel={displayName}
        userInitial={initial}
        userRole={role || ''}
        onLogout={signOut}
        collapsed={collapsed}
        onToggle={toggleCollapsed}
        onOpenPalette={() => setPaletteOpen(true)}
      />
      <div className="main-wrap">
        <ContextBar groups={navGroups} pathname={pathname} onNav={onNav} />
        <main className="main">{children}</main>
      </div>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        groups={navGroups}
        onNav={onNav}
        session={session}
        perms={perms}
        pathname={pathname}
      />

      {/* ── mobile app chrome (≤767px — CSS decides; desktop never shows it) ── */}
      <MobileTabBar navGroups={navGroups} pathname={pathname} moreOpen={sheetOpen}
        onGo={(r) => { setSheetOpen(false); onNav(r); }} onMore={() => setSheetOpen((s) => !s)} />
      {sheetOpen && (
        <MobileSheet navGroups={navGroups} pathname={pathname} onGo={onNav} onClose={() => setSheetOpen(false)}
          userLabel={displayName} userInitial={initial} userRole={role || ''} onLogout={signOut} />
      )}
    </div>
    </ConfirmProvider>
  );
}

const onRoute = (route, pathname) => !!route &&
  (route === '/' ? pathname === '/' : (pathname === route || pathname.startsWith(route + '/')));

// Flatten the perm-filtered nav (flat groups become single items) — tab bar + sheet
// both read this, so gating stays identical to the rail.
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
  { route: '/',          label: 'Home'      },
  { route: '/campaigns', label: 'Campaigns' },
  { route: '/journeys',  label: 'Journeys'  },
  { route: '/contacts',  label: 'Contacts'  },
];

function MobileTabBar({ navGroups, pathname, moreOpen, onGo, onMore }) {
  const flat = flatNav(navGroups);
  const tabs = MOBILE_TABS.map((t) => ({ ...t, it: flat.find((i) => i.route === t.route) })).filter((t) => t.it);
  return (
    <nav className="ry-tabbar">
      {tabs.map((t) => {
        const Icon = t.it.icon;
        const on = !moreOpen && onRoute(t.route, pathname);
        return (
          <button key={t.route} className={`ry-tab${on ? ' active' : ''}`} onClick={() => onGo(t.route)}>
            <Icon size={19} strokeWidth={on ? 2 : 1.75} style={{ flexShrink: 0 }} />
            <span>{t.label}</span>
          </button>
        );
      })}
      <button className={`ry-tab${moreOpen ? ' active' : ''}`} onClick={onMore}>
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
    <div className="ry-sheetwrap" onMouseDown={onClose}>
      <div className="ry-sheet" onMouseDown={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 14 }}>
          <div style={{ width: 36, height: 36, flexShrink: 0, borderRadius: 9, background: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 700, color: 'var(--accent-ink)', fontSize: 15 }}>
            {userInitial}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {userLabel}
            </div>
            <div style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 10, color: 'var(--t3)' }}>{userRole}</div>
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

        {flats.filter((g) => g.route === '/').map((g) => {
          const Icon = g.icon;
          return (
            <div key={g.route} style={{ marginBottom: 14 }}>
              <div className="ry-sheet-grid">
                <button className={`ry-sheet-item${onRoute(g.route, pathname) ? ' active' : ''}`} onClick={() => onGo(g.route)}>
                  {Icon && <Icon size={17} strokeWidth={1.75} style={{ flexShrink: 0 }} />}
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.label}</span>
                </button>
              </div>
            </div>
          );
        })}

        {grouped.map((g) => (
          <div key={g.id} style={{ marginBottom: 14 }}>
            <div style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase',
              letterSpacing: '0.1em', padding: '0 2px 7px' }}>{g.label}</div>
            <div className="ry-sheet-grid">
              {(g.items || []).map((it) => {
                const Icon = it.icon;
                return (
                  <button key={it.route} className={`ry-sheet-item${onRoute(it.route, pathname) ? ' active' : ''}`} onClick={() => onGo(it.route)}>
                    {Icon && <Icon size={17} strokeWidth={1.75} style={{ flexShrink: 0 }} />}
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        {flats.filter((g) => g.route !== '/').map((g) => {
          const Icon = g.icon;
          return (
            <div key={g.route} style={{ marginBottom: 14 }}>
              <div className="ry-sheet-grid">
                <button className={`ry-sheet-item${onRoute(g.route, pathname) ? ' active' : ''}`} onClick={() => onGo(g.route)}>
                  {Icon && <Icon size={17} strokeWidth={1.75} style={{ flexShrink: 0 }} />}
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.label}</span>
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
