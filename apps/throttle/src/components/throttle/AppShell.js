'use client';
/* AppShell — auth gate + sidebar + topbar + ⌘K palette + New Request
   modal + global toasts. Each screen page renders its content inside
   <AppShell route="...">. Mirrors the prototype App() composition with
   real Next routing and the real Google-auth session.

   Auth: production redirects to /login when unauthenticated. Under
   `next dev` (NODE_ENV !== 'production') the gate is relaxed so the
   screens can be previewed with seed data — the deployed bundle is
   always NODE_ENV=production, so no bypass ships. */
import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { supabaseBrand } from '@throttle/db';
import { Sidebar, Topbar, CommandPalette, ROUTE_OF } from './Shell';
import { NewRequestModal } from './NewRequestModal';
import { ToastHost } from './ToastHost';
import { Icon } from './Icon';
import { Menu, X, LogOut } from 'lucide-react';
import { initialsOf } from '@/lib/throttleData';

const DEV_PREVIEW = process.env.NODE_ENV !== 'production';

export function AppShell({ route, children }) {
  const router = useRouter();
  const { session, user, role, brandUser, loading, signOut } = useAuth();
  const [collapsed, setCollapsed] = useState(false);
  const [palette, setPalette] = useState(false);
  const [newReq, setNewReq] = useState(false);
  const [editReq, setEditReq] = useState(null);
  const [sprint, setSprint] = useState('S-24');
  const [badges, setBadges] = useState({ requests: 2, board: 3 });
  // Mobile "More" bottom sheet (≤767px chrome). AppShell is mounted per page, so
  // navigation unmounts it and the sheet can never survive a route change.
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => {
    try { if (localStorage.getItem('throttle_collapsed') === '1') setCollapsed(true); } catch (_) {}
  }, []);

  // gate
  useEffect(() => {
    if (loading) return;
    if (!session && !DEV_PREVIEW) router.replace('/login/');
  }, [loading, session, router]);

  // global events: ⌘K, new request, open task
  useEffect(() => {
    const onKey = e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(p => !p); } };
    const onNew = () => { setEditReq(null); setNewReq(true); };
    const onEdit = e => { setEditReq(e.detail || null); };
    const onOpenTask = e => { if (typeof window !== 'undefined') window.__throttleOpenTask = e.detail; if (route !== 'board') router.push('/board'); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('throttle:newreq', onNew);
    window.addEventListener('throttle:editreq', onEdit);
    window.addEventListener('throttle:opentask', onOpenTask);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('throttle:newreq', onNew); window.removeEventListener('throttle:editreq', onEdit); window.removeEventListener('throttle:opentask', onOpenTask); };
  }, [route, router]);

  // live sprint label + nav badges (non-blocking; falls back to seed)
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      try {
        const [{ data: spr }, { count: pend }, { count: rev }] = await Promise.all([
          supabaseBrand.from('sprints').select('name').eq('status', 'active').limit(1),
          supabaseBrand.from('requests').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
          supabaseBrand.from('tasks').select('id', { count: 'exact', head: true }).eq('stage', 'in_review'),
        ]);
        if (cancelled) return;
        if (spr && spr[0]?.name) setSprint(String(spr[0].name).replace(/^Sprint\s+/i, ''));
        setBadges({ requests: pend || undefined, board: rev || undefined });
      } catch (_) { /* keep seed */ }
    })();
    return () => { cancelled = true; };
  }, [session]);

  const toggleCollapse = () => setCollapsed(c => { const n = !c; try { localStorage.setItem('throttle_collapsed', n ? '1' : '0'); } catch (_) {} return n; });
  const navigate = id => { const r = ROUTE_OF[id]; if (r) router.push(r); };

  if (loading && !DEV_PREVIEW) {
    return <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--bg)', color: 'var(--t3)', fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.2em', textTransform: 'uppercase' }}>Loading…</div>;
  }
  if (!session && !DEV_PREVIEW) return null;

  const displayUser = {
    name: brandUser?.name || user?.full_name || user?.email?.split('@')[0] || 'Meera Krishnan',
    discipline: brandUser?.discipline || (role ? role[0].toUpperCase() + role.slice(1) : 'Brand Lead'),
    initial: initialsOf(brandUser?.name || user?.full_name || user?.email || 'Meera Krishnan'),
  };
  const scroll = route === 'board' || route === 'social';

  return (
    <div data-dir="b" style={{ display: 'flex', height: '100dvh', overflow: 'hidden', background: 'var(--bg)', color: 'var(--t1)' }}>
      <Sidebar route={route} onNavigate={navigate} collapsed={collapsed} onToggle={toggleCollapse}
        onPalette={() => setPalette(true)} user={displayUser} onSignOut={signOut} badges={badges} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        <Topbar route={route} onPalette={() => setPalette(true)} sprint={sprint} />
        <main className="th-main" style={{ flex: 1, overflowY: scroll ? 'hidden' : 'auto', overflowX: 'hidden', padding: scroll ? '20px 26px 0' : '24px 26px 40px' }}>
          {children}
        </main>
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} onNavigate={navigate} />
      <NewRequestModal open={newReq || !!editReq} editing={editReq} onClose={() => { setNewReq(false); setEditReq(null); }} />
      <ToastHost />

      {/* ── mobile app chrome (≤767px — CSS decides; desktop never shows it) ── */}
      <MobileTabBar route={route} badges={badges} moreOpen={sheetOpen}
        onGo={navigate} onMore={() => setSheetOpen(s => !s)} />
      {sheetOpen && (
        <MobileSheet route={route} badges={badges} onGo={navigate} onClose={() => setSheetOpen(false)}
          user={displayUser} onSignOut={signOut} />
      )}
    </div>
  );
}

// ── mobile chrome — mirrors Shell.js's Sidebar NAV (which is ungated) ────────
const MOBILE_TABS = [
  { id: 'dashboard', label: 'Home',     icon: 'dashboard' },
  { id: 'requests',  label: 'Requests', icon: 'inbox' },
  { id: 'board',     label: 'Board',    icon: 'board' },
  { id: 'social',    label: 'Social',   icon: 'calendar' },
];

const SHEET_GROUPS = [
  { label: 'Overview',   items: [{ id: 'dashboard', label: 'Dashboard', icon: 'dashboard' }] },
  { label: 'Production', items: [
    { id: 'requests', label: 'Requests', icon: 'inbox', badgeKey: 'requests' },
    { id: 'board',    label: 'Board',    icon: 'board', badgeKey: 'board' },
    { id: 'sprints',  label: 'Sprints',  icon: 'target' },
  ] },
  { label: 'Channels', items: [
    { id: 'social',      label: 'Social',      icon: 'calendar' },
    { id: 'performance', label: 'Performance', icon: 'trend' },
  ] },
  { label: 'System', items: [
    { id: 'manual',   label: 'System Manual', icon: 'book' },
    { id: 'settings', label: 'Settings',      icon: 'settings' },
  ] },
];

function MobileTabBar({ route, badges, moreOpen, onGo, onMore }) {
  return (
    <nav className="th-tabbar">
      {MOBILE_TABS.map((t) => {
        const on = !moreOpen && route === t.id;
        const n = badges?.[t.id === 'requests' ? 'requests' : t.id === 'board' ? 'board' : ''] || 0;
        return (
          <button key={t.id} className={`th-tab${on ? ' active' : ''}`} onClick={() => onGo(t.id)}>
            <span style={{ position: 'relative', display: 'flex' }}>
              <Icon name={t.icon} size={19} />
              {n > 0 && <span className="th-tab-badge">{n > 99 ? '99+' : n}</span>}
            </span>
            <span>{t.label}</span>
          </button>
        );
      })}
      <button className={`th-tab${moreOpen ? ' active' : ''}`} onClick={onMore}>
        <Menu size={19} strokeWidth={moreOpen ? 2 : 1.75} style={{ flexShrink: 0 }} />
        <span>More</span>
      </button>
    </nav>
  );
}

function MobileSheet({ route, badges, onGo, onClose, user, onSignOut }) {
  return (
    <div className="th-sheetwrap" onMouseDown={onClose}>
      <div className="th-sheet" onMouseDown={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 14 }}>
          <div style={{ width: 36, height: 36, flexShrink: 0, borderRadius: 9, background: '#F2CD1A',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 700, color: '#17140a', fontSize: 14 }}>
            {user.initial}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user.name}
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--t3)' }}>{user.discipline}</div>
          </div>
          <button onClick={onSignOut} title="Sign out"
            style={{ display: 'flex', padding: 6, borderRadius: 8, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--t3)' }}>
            <LogOut size={18} strokeWidth={1.75} />
          </button>
          <button onClick={onClose} title="Close"
            style={{ display: 'flex', padding: 6, borderRadius: 8, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--t2)' }}>
            <X size={19} strokeWidth={1.75} />
          </button>
        </div>

        {SHEET_GROUPS.map((g) => (
          <div key={g.label} style={{ marginBottom: 14 }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase',
              letterSpacing: '0.1em', padding: '0 2px 7px' }}>{g.label}</div>
            <div className="th-sheet-grid">
              {g.items.map((it) => {
                const n = it.badgeKey ? badges?.[it.badgeKey] : 0;
                return (
                  <button key={it.id} className={`th-sheet-item${route === it.id ? ' active' : ''}`}
                    onClick={() => { onClose(); onGo(it.id); }}>
                    <Icon name={it.icon} size={17} />
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</span>
                    {n > 0 && <span className="th-tab-badge inline">{n > 99 ? '99+' : n}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
