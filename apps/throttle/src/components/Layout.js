'use client';
import { useAuth } from '@throttle/auth';
import { useRouter, usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ToastProvider } from '@/lib/toast';
import { supabaseBrand as supabase, getValidSession } from '@throttle/db';
import { Inbox as InboxIcon, LayoutGrid, Timer, BarChart3, Megaphone, BookOpen,
  Settings as SettingsIcon, Menu, X, LogOut } from 'lucide-react';

const NAV_ITEMS = [
  { label: 'Requests',  href: '/requests/',  roles: ['requester', 'member', 'lead', 'admin'] },
  { label: 'Board',     href: '/board/',      roles: ['member', 'lead', 'admin'] },
  { label: 'Sprints',   href: '/sprints/',    roles: ['lead', 'admin'] },
  { label: 'Dashboard', href: '/dashboard/',  roles: ['lead', 'admin'] },
  { label: 'Social',    href: '/social/',     roles: ['requester', 'member', 'lead', 'admin'] },
  { label: 'Manual',    href: '/manual/',     roles: ['requester', 'member', 'lead', 'admin'] },
  { label: 'Settings',  href: '/settings/',   roles: ['admin'] },
];

function NotificationBell({ brandUser }) {
  const [open, setOpen]       = useState(false);
  const [items, setItems]     = useState([]);
  const [unread, setUnread]   = useState(0);
  const [loading, setLoading] = useState(false);

  const storageKey = `throttle_notif_seen_${brandUser?.id}`;

  async function loadNotifications() {
    await getValidSession();
    if (!brandUser?.id) return;
    setLoading(true);
    try {
      const { data: assigned } = await supabase
        .from('task_assignees')
        .select('task_id')
        .eq('user_id', brandUser.id);

      if (!assigned?.length) { setItems([]); setUnread(0); return; }

      const taskIds = assigned.map(a => a.task_id);

      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data: activity } = await supabase
        .from('activity_log')
        .select('id, task_id, event_type, payload, created_at, user_id')
        .in('task_id', taskIds)
        .neq('user_id', brandUser.id)
        .gt('created_at', since)
        .order('created_at', { ascending: false })
        .limit(20);

      const uniqueTaskIds = [...new Set((activity || []).map(a => a.task_id))];
      let titleMap = {};
      if (uniqueTaskIds.length > 0) {
        const { data: taskTitles } = await supabase
          .from('tasks')
          .select('id, title')
          .in('id', uniqueTaskIds);
        titleMap = Object.fromEntries((taskTitles || []).map(t => [t.id, t.title]));
      }

      const enriched = (activity || []).map(a => ({
        ...a,
        task_title: titleMap[a.task_id] || 'Unknown task',
      }));

      setItems(enriched);

      const lastSeen = localStorage.getItem(storageKey);
      const unreadItems = lastSeen
        ? enriched.filter(a => new Date(a.created_at) > new Date(lastSeen))
        : enriched;
      setUnread(unreadItems.length);
    } finally {
      setLoading(false);
    }
  }

  function handleOpen() {
    setOpen(o => !o);
    if (!open) {
      localStorage.setItem(storageKey, new Date().toISOString());
      setUnread(0);
    }
  }

  useEffect(() => {
    if (!['member', 'lead', 'admin'].includes(brandUser?.role)) return;
    loadNotifications();
    const interval = setInterval(loadNotifications, 60 * 1000);
    return () => clearInterval(interval);
  }, [brandUser?.id]);

  useEffect(() => {
    if (!open) return;
    function handler(e) {
      if (!e.target.closest('[data-notif-bell]')) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (!['member', 'lead', 'admin'].includes(brandUser?.role)) return null;

  function describeActivity(item) {
    const p = item.payload || {};
    switch (item.event_type) {
      case 'stage_change':  return `moved to ${p.to?.replace(/_/g, ' ') || 'new stage'}`;
      case 'comment':       return `commented: "${(p.text || '').slice(0, 40)}${p.text?.length > 40 ? '…' : ''}"`;
      case 'assignment':    return `assigned ${p.assignee_name || 'someone'}`;
      case 'approval':      return p.decision === 'approved' ? 'work approved ✓' : 'revision requested';
      case 'delivery':      return 'delivered to requester';
      case 'iteration':     return `iteration ${p.iteration_number || ''} requested`;
      case 'completion':    return 'marked done';
      default:              return item.event_type?.replace(/_/g, ' ') || 'activity';
    }
  }

  function timeAgo(ts) {
    const h = (Date.now() - new Date(ts).getTime()) / (1000 * 60 * 60);
    if (h < 1)  return `${Math.floor(h * 60)}m ago`;
    if (h < 24) return `${Math.floor(h)}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  return (
    <div data-notif-bell style={{ position: 'relative' }}>
      <button
        onClick={handleOpen}
        style={{
          position: 'relative',
          background: 'none',
          border: '1px solid var(--b1)',
          borderRadius: 4,
          width: 30,
          height: 28,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          color: open ? '#F2CD1A' : 'var(--t3)',
          transition: 'all .15s',
        }}
        title="Notifications"
      >
        <span style={{ fontSize: 13 }}>🔔</span>
        {unread > 0 && (
          <span style={{
            position: 'absolute',
            top: -5,
            right: -5,
            background: '#DE2A2A',
            color: '#fff',
            fontFamily: 'var(--sans)',
            fontSize: 11,
            fontWeight: 700,
            borderRadius: 10,
            minWidth: 18,
            height: 18,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '0 4px',
          }}>
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div style={{
          position: 'absolute',
          top: 36,
          right: 0,
          width: 320,
          maxHeight: 400,
          background: 'var(--s1)',
          border: '1px solid var(--b2)',
          borderRadius: 8,
          overflow: 'hidden',
          zIndex: 200,
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
          display: 'flex',
          flexDirection: 'column',
        }}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--b1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontFamily: 'var(--head)', fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text)' }}>Activity on my tasks</span>
            {loading && <span style={{ fontFamily: 'var(--sans)', fontSize: 11, color: 'var(--t3)' }}>updating…</span>}
          </div>
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {items.length === 0 ? (
              <div style={{ padding: '24px 14px', textAlign: 'center', fontFamily: 'var(--sans)', fontSize: 13, color: 'var(--t3)' }}>
                No activity in the last 7 days
              </div>
            ) : items.map(item => (
              <div key={item.id} style={{ padding: '10px 14px', borderBottom: '1px solid var(--b1)', display: 'flex', flexDirection: 'column', gap: 3 }}>
                <p style={{ fontFamily: 'var(--sans)', fontSize: 13, color: 'var(--text)', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {item.task_title}
                </p>
                <p style={{ fontFamily: 'var(--sans)', fontSize: 12, color: 'var(--t2)', margin: 0 }}>
                  {describeActivity(item)}
                </p>
                <p style={{ fontFamily: 'var(--sans)', fontSize: 11, color: 'var(--t3)', margin: 0 }}>
                  {timeAgo(item.created_at)}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ThrottleLogo() {
  const cells = [1,0,1,0, 0,1,0,1, 1,0,1,0, 0,1,0,1];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 5px)', gap: 0, flexShrink: 0 }}>
        {cells.map((v, i) => (
          <div key={i} style={{ width: 5, height: 5, background: v ? '#F2CD1A' : '#111111' }} />
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <span style={{ fontFamily: 'var(--head)', fontWeight: 900, fontSize: 12, letterSpacing: '.25em', color: '#F2CD1A', textTransform: 'uppercase', lineHeight: 1 }}>
          Throttle
        </span>
      </div>
    </div>
  );
}

export default function Layout({ children }) {
  const { session, brandUser, loading, signOut } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  // ── mobile "More" bottom sheet (≤767px chrome; closes itself on navigation).
  // Declared BEFORE the loading/brandUser early returns — hooks after a conditional
  // return crash the whole shell when the condition changes between renders (S303).
  const [sheetOpen, setSheetOpen] = useState(false);
  useEffect(() => { setSheetOpen(false); }, [pathname]);

  useEffect(() => {
    if (!loading && !session) router.replace('/login/');
  }, [session, loading, router]);

  if (loading) return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <span style={{ color: 'var(--t3)', fontFamily: 'var(--sans)', fontSize: 13 }}>
        Loading…
      </span>
    </div>
  );

  if (!brandUser) return null;

  const visibleNav = NAV_ITEMS.filter(item => item.roles.includes(brandUser.role));

  return (
    <ToastProvider>
    <div style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--text)' }}>
      {/* Top nav */}
      <header style={{
        borderBottom: '1px solid var(--b1)',
        padding: '0 20px',
        display: 'flex',
        alignItems: 'center',
        height: 52,
        background: 'var(--s1)',
        position: 'sticky',
        top: 0,
        zIndex: 50,
      }}>
        <ThrottleLogo />

        {/* Separator */}
        <div style={{ width: 1, height: 24, background: 'var(--b1)', margin: '0 16px' }} />

        {/* Nav */}
        <nav className="th-nav" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {visibleNav.map(item => {
            const isActive = pathname?.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                style={{
                  fontFamily: 'var(--sans)',
                  fontSize: 13,
                  letterSpacing: '.02em',
                  textDecoration: 'none',
                  padding: '5px 12px',
                  borderRadius: 4,
                  height: 30,
                  display: 'flex',
                  alignItems: 'center',
                  transition: 'all .15s',
                  background: isActive ? '#F2CD1A' : 'transparent',
                  color: isActive ? 'var(--fg-accent)' : 'var(--t2)',
                  fontWeight: isActive ? 600 : 400,
                }}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* Right side */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          <NotificationBell brandUser={brandUser} />
          <span className="th-user" style={{ fontFamily: 'var(--sans)', fontSize: 13, color: 'var(--t2)' }}>
            {brandUser.name}
          </span>
          <span className="th-user" style={{
            fontSize: 11,
            background: 'var(--s3)',
            color: 'var(--t2)',
            padding: '2px 8px',
            borderRadius: 3,
            letterSpacing: '.06em',
            textTransform: 'uppercase',
            fontFamily: 'var(--sans)',
            fontWeight: 500,
          }}>
            {brandUser.role}
          </span>
          <button
            className="th-user"
            onClick={signOut}
            style={{
              fontFamily: 'var(--sans)',
              fontSize: 12,
              color: 'var(--t3)',
              background: 'none',
              border: '1px solid var(--b1)',
              borderRadius: 4,
              padding: '4px 10px',
              cursor: 'pointer',
              transition: 'all .15s',
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      {/* Page content */}
      <main className="th-main" style={{ padding: '24px 20px' }}>
        {children}
      </main>

      {/* ── mobile app chrome (≤767px — CSS decides; desktop never shows it) ── */}
      <MobileTabBar visibleNav={visibleNav} pathname={pathname} moreOpen={sheetOpen}
        onGo={(href) => { setSheetOpen(false); router.push(href); }} onMore={() => setSheetOpen(s => !s)} />
      {sheetOpen && (
        <MobileSheet visibleNav={visibleNav} pathname={pathname}
          onGo={(href) => router.push(href)} onClose={() => setSheetOpen(false)}
          userLabel={brandUser.name} userRole={brandUser.role} onLogout={signOut} />
      )}
    </div>
    </ToastProvider>
  );
}

// ── mobile chrome ────────────────────────────────────────────────────────────
// Throttle's nav has no icons (it's a text top-nav), so the mobile chrome maps them.
const TAB_ICONS = {
  '/requests/': InboxIcon, '/board/': LayoutGrid, '/sprints/': Timer, '/dashboard/': BarChart3,
  '/social/': Megaphone, '/manual/': BookOpen, '/settings/': SettingsIcon,
};
const MOBILE_TABS = ['/requests/', '/board/', '/social/', '/dashboard/'];

function MobileTabBar({ visibleNav, pathname, moreOpen, onGo, onMore }) {
  const tabs = MOBILE_TABS.map((href) => visibleNav.find((i) => i.href === href)).filter(Boolean);
  return (
    <nav className="th-tabbar">
      {tabs.map((it) => {
        const Icon = TAB_ICONS[it.href] || LayoutGrid;
        const on = !moreOpen && pathname?.startsWith(it.href.replace(/\/$/, ''));
        return (
          <button key={it.href} className={`th-tab${on ? ' active' : ''}`} onClick={() => onGo(it.href)}>
            <Icon size={19} strokeWidth={on ? 2 : 1.75} style={{ flexShrink: 0 }} />
            <span>{it.label}</span>
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

function MobileSheet({ visibleNav, pathname, onGo, onClose, userLabel, userRole, onLogout }) {
  return (
    <div className="th-sheetwrap" onMouseDown={onClose}>
      <div className="th-sheet" onMouseDown={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 14 }}>
          <div style={{ width: 36, height: 36, flexShrink: 0, borderRadius: 9, background: '#F2CD1A',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 700, color: '#17140a', fontSize: 15 }}>
            {(userLabel || '?').trim().charAt(0).toUpperCase()}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {userLabel}
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase' }}>{userRole}</div>
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
        <div className="th-sheet-grid">
          {visibleNav.map((it) => {
            const Icon = TAB_ICONS[it.href] || LayoutGrid;
            const on = pathname?.startsWith(it.href.replace(/\/$/, ''));
            return (
              <button key={it.href} className={`th-sheet-item${on ? ' active' : ''}`} onClick={() => onGo(it.href)}>
                <Icon size={17} strokeWidth={1.75} style={{ flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
