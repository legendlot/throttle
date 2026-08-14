'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { RequireAuth, useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { garageFetch } from '@throttle/db';
import { NAV_GROUPS, filterNavByPerms } from '../../lib/nav.js';
import { Sidebar } from '../../components/chrome/Sidebar.js';
import { ContextBar } from '../../components/chrome/ContextBar.js';
import { CommandPalette } from '../../components/chrome/CommandPalette.js';

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
          const ov = await garageFetch('getCampaignsOverview', {}, session);
          const o = (Array.isArray(ov) ? ov : []).find((x) => x.id === c.id);
          // ⚠️ Take `sent` from the overview but KEEP audience_snapshot as the denominator.
          // This was `total = Number(o.total || total)`, which threw away the correct value it had
          // just computed: `campaign_stats_list.total` counts comms.messages rows that EXIST, and
          // the fan-out creates them just ahead of sending, so the rail sat at ~99% for an entire
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
    </div>
  );
}
