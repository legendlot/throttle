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
        <main style={{ flex: 1, overflowY: scroll ? 'hidden' : 'auto', overflowX: 'hidden', padding: scroll ? '20px 26px 0' : '24px 26px 40px' }}>
          {children}
        </main>
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} onNavigate={navigate} />
      <NewRequestModal open={newReq || !!editReq} editing={editReq} onClose={() => { setNewReq(false); setEditReq(null); }} />
      <ToastHost />
    </div>
  );
}
