'use client';
/* ════════════════════════════════════════════════════════════
   RedlineSidebar — Sidebar2 from the redesign prototype, wired
   to the real app: Next router, NAV_PRIMARY/NAV_SETUP config,
   live Inbox badge counts, auth user footer. 4 primary
   destinations + System Manual + collapsed Setup drawer.
   Collapse state persists in localStorage `rl-sb-collapsed`.
   ════════════════════════════════════════════════════════════ */
import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Search, ChevronDown, ChevronRight, ChevronLeft, SlidersHorizontal, LogOut, BookOpen } from 'lucide-react';
import { NAV_PRIMARY, NAV_SETUP, NAV_MANUAL } from '../../lib/nav.js';
import { RedlineIcon } from '../RedlineIcon.js';

const routeMatch = (pathname, route) => {
  const norm = (pathname || '/').replace(/\/+$/, '') || '/';
  const r = (route || '').replace(/\/+$/, '');
  return norm === r || norm.startsWith(r + '/');
};

export function RedlineSidebar({ onCmdK, badges = {}, userLabel = '', userRole = '', onLogout }) {
  const pathname = usePathname();
  const router = useRouter();

  // which primary group is active for the current route?
  const activeGroup = NAV_PRIMARY.find(g =>
    (g.route && routeMatch(pathname, g.route)) ||
    (g.children || []).some(c => routeMatch(pathname, c.route))
  );
  const setupActive = NAV_SETUP.some(s => routeMatch(pathname, s.route));
  const manualActive = routeMatch(pathname, NAV_MANUAL.route);

  const [open, setOpen] = useState({});
  const [setupOpen, setSetupOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  // hydrate persisted collapse + auto-expand the active section only
  useEffect(() => {
    try { setCollapsed(localStorage.getItem('rl-sb-collapsed') === '1'); } catch (_) {}
    setHydrated(true);
  }, []);
  useEffect(() => {
    if (activeGroup?.children) setOpen({ [activeGroup.id]: true });
    else setOpen({});
    if (setupActive) setSetupOpen(true);
  }, [activeGroup?.id, setupActive]);

  const setCol = (v) => { setCollapsed(v); try { localStorage.setItem('rl-sb-collapsed', v ? '1' : '0'); } catch (_) {} };
  const toggle = (id) => setOpen(o => ({ ...o, [id]: !o[id] }));
  const go = (route) => router.push(route);

  const W = collapsed ? 66 : 232;
  const inboxCount = (badges.alerts || 0) + (badges.returns || 0);
  const initial = userLabel ? userLabel[0].toUpperCase() : '?';

  return (
    <aside style={{ width: W, flexShrink: 0, background: 'var(--bg-2)', overflow: 'hidden',
      borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', height: '100%',
      transition: hydrated ? 'width var(--base) var(--ease)' : 'none' }}>
      {/* brand */}
      <div style={{ height: 56, display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
        padding: collapsed ? '0' : '0 18px', justifyContent: collapsed ? 'center' : 'flex-start',
        borderBottom: '1px solid var(--border)' }}>
        <RedlineIcon bar={3} gap={2} />
        {!collapsed && <span className="font-display" style={{ fontSize: 15, fontWeight: 700, letterSpacing: '0.1em',
          color: 'var(--t1)', whiteSpace: 'nowrap' }}>REDLINE</span>}
      </div>

      {/* command launcher */}
      <div style={{ padding: collapsed ? '14px 0 8px' : '14px 14px 8px', display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
        <button onClick={onCmdK} title="Search or jump (⌘K)" style={{ width: collapsed ? 38 : '100%', height: collapsed ? 38 : 'auto',
          display: 'flex', alignItems: 'center', gap: 9, justifyContent: collapsed ? 'center' : 'flex-start',
          background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-sm)',
          padding: collapsed ? 0 : '8px 11px', cursor: 'pointer', color: 'var(--t3)',
          fontFamily: 'var(--font-ui)', fontSize: 13, transition: 'all var(--fast)' }}>
          <Search size={15} strokeWidth={1.75} style={{ flexShrink: 0 }} />
          {!collapsed && <><span style={{ flex: 1, textAlign: 'left' }}>Search or jump…</span>
            <span className="num" style={{ fontSize: 11, padding: '2px 5px', borderRadius: 4,
              border: '1px solid var(--border-2)', color: 'var(--t3)' }}>⌘K</span></>}
        </button>
      </div>

      <nav style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: collapsed ? '4px 14px' : '4px 10px' }}>
        {NAV_PRIMARY.map(item => {
          const on = activeGroup?.id === item.id;
          const expanded = !!open[item.id];
          const hasKids = !!(item.children && item.children.length);
          const count = item.badged ? inboxCount : 0;

          if (collapsed) {
            const ItemIcon = item.icon;
            return (
              <div key={item.id} title={item.label}
                onClick={() => { if (hasKids) { setCol(false); setOpen(o => ({ ...o, [item.id]: true })); } else go(item.route); }}
                style={{ position: 'relative', height: 40, margin: '2px 0', borderRadius: 'var(--r-sm)',
                  display: 'grid', placeItems: 'center', cursor: 'pointer',
                  background: on ? 'var(--yellow-dim)' : 'transparent', color: on ? 'var(--yellow)' : 'var(--t2)',
                  transition: 'all var(--fast)' }}
                onMouseEnter={e => { if (!on) e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}
                onMouseLeave={e => { if (!on) e.currentTarget.style.background = 'transparent'; }}>
                <ItemIcon size={18} strokeWidth={1.75} />
                {count > 0 && <span style={{ position: 'absolute', top: 4, right: 4, width: 7, height: 7,
                  borderRadius: '50%', background: 'var(--red)', border: '1.5px solid var(--bg-2)' }} />}
              </div>
            );
          }

          const ItemIcon = item.icon;
          return (
            <div key={item.id}>
              <div onClick={() => hasKids ? toggle(item.id) : go(item.route)}
                style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '9px 11px',
                  borderRadius: 'var(--r-sm)', cursor: 'pointer', position: 'relative',
                  background: on ? 'var(--yellow-dim)' : 'transparent',
                  color: on ? 'var(--yellow)' : 'var(--t2)',
                  fontFamily: 'var(--font-ui)', fontSize: 14, fontWeight: on ? 600 : 500,
                  transition: 'all var(--fast)' }}
                onMouseEnter={e => { if (!on) e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}
                onMouseLeave={e => { if (!on) e.currentTarget.style.background = 'transparent'; }}>
                {on && <div style={{ position: 'absolute', left: -10, top: 8, bottom: 8, width: 2.5,
                  background: 'var(--yellow)', borderRadius: 2 }} />}
                <ItemIcon size={17} strokeWidth={1.75} style={{ flexShrink: 0 }} />
                <span style={{ flex: 1, whiteSpace: 'nowrap' }}>{item.label}</span>
                {count > 0 ? <span className="num" style={{ fontSize: 11, fontWeight: 700,
                  background: 'var(--red)', color: '#fff', borderRadius: 'var(--r-full)', padding: '1px 7px',
                  minWidth: 20, textAlign: 'center' }}>{count > 99 ? '99+' : count}</span>
                  : hasKids ? <span className="num" style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--t4)' }}>{item.children.length}</span> : null}
                {hasKids && <span style={{ color: 'var(--t4)', display: 'flex',
                  transform: expanded ? 'rotate(0)' : 'rotate(-90deg)', transition: 'transform var(--fast)' }}>
                  <ChevronDown size={13} strokeWidth={1.75} /></span>}
              </div>
              {expanded && hasKids && (
                <div style={{ margin: '2px 0 6px 0', paddingLeft: 22, position: 'relative' }}>
                  <div style={{ position: 'absolute', left: 18, top: 4, bottom: 8, width: 1, background: 'var(--border-2)' }} />
                  {item.children.map(c => {
                    const cur = routeMatch(pathname, c.route);
                    const childCount = c.badgeKey ? (badges[c.badgeKey] || 0) : 0;
                    return (
                      <div key={c.id} onClick={() => go(c.route)} style={{ padding: '6px 0 6px 18px',
                        fontFamily: 'var(--font-ui)', fontSize: 12.5,
                        color: cur ? 'var(--t1)' : 'var(--t3)', fontWeight: cur ? 600 : 400, cursor: 'pointer',
                        display: 'flex', alignItems: 'center', gap: 8, transition: 'color var(--fast)' }}
                        onMouseEnter={e => { if (!cur) e.currentTarget.style.color = 'var(--t1)'; }}
                        onMouseLeave={e => { if (!cur) e.currentTarget.style.color = 'var(--t3)'; }}>
                        <span style={{ width: 4, height: 4, borderRadius: '50%', flexShrink: 0,
                          background: cur ? 'var(--yellow)' : 'var(--t4)' }} />
                        <span style={{ flex: 1, whiteSpace: 'nowrap' }}>{c.label}</span>
                        {childCount > 0 && <span className="num" style={{ fontSize: 10, fontWeight: 700,
                          color: 'var(--bad-fg)', background: 'var(--bad-bg)', border: '1px solid var(--bad-bd)',
                          borderRadius: 'var(--r-full)', padding: '0 6px', marginRight: 8 }}>{childCount > 99 ? '99+' : childCount}</span>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        {/* System Manual — flat item (S105 pattern: before the setup/admin section) */}
        <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
          {collapsed ? (
            <div title="System Manual" onClick={() => go(NAV_MANUAL.route)}
              style={{ height: 40, borderRadius: 'var(--r-sm)', display: 'grid', placeItems: 'center', cursor: 'pointer',
                background: manualActive ? 'var(--yellow-dim)' : 'transparent',
                color: manualActive ? 'var(--yellow)' : 'var(--t3)' }}
              onMouseEnter={e => { if (!manualActive) e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}
              onMouseLeave={e => { if (!manualActive) e.currentTarget.style.background = 'transparent'; }}>
              <BookOpen size={18} strokeWidth={1.75} />
            </div>
          ) : (
            <div onClick={() => go(NAV_MANUAL.route)} style={{ display: 'flex', alignItems: 'center', gap: 11,
              padding: '8px 11px', borderRadius: 'var(--r-sm)', cursor: 'pointer',
              background: manualActive ? 'var(--yellow-dim)' : 'transparent',
              color: manualActive ? 'var(--yellow)' : 'var(--t3)',
              fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: manualActive ? 600 : 500 }}
              onMouseEnter={e => { if (!manualActive) e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}
              onMouseLeave={e => { if (!manualActive) e.currentTarget.style.background = 'transparent'; }}>
              <BookOpen size={17} strokeWidth={1.75} />
              <span style={{ flex: 1 }}>System Manual</span>
            </div>
          )}

          {/* Setup — collapsed config drawer (done-once config, out of the daily flow) */}
          {collapsed ? (
            <div title="Setup" onClick={() => { setCol(false); setSetupOpen(true); }}
              style={{ height: 40, borderRadius: 'var(--r-sm)', display: 'grid', placeItems: 'center', cursor: 'pointer',
                color: setupActive ? 'var(--yellow)' : 'var(--t3)',
                background: setupActive ? 'var(--yellow-dim)' : 'transparent' }}
              onMouseEnter={e => { if (!setupActive) e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}
              onMouseLeave={e => { if (!setupActive) e.currentTarget.style.background = 'transparent'; }}>
              <SlidersHorizontal size={18} strokeWidth={1.75} />
            </div>
          ) : (
            <>
              <div onClick={() => setSetupOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', gap: 11,
                padding: '8px 11px', borderRadius: 'var(--r-sm)', cursor: 'pointer',
                color: setupActive ? 'var(--yellow)' : 'var(--t3)',
                fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 500 }}>
                <SlidersHorizontal size={17} strokeWidth={1.75} />
                <span style={{ flex: 1 }}>Setup</span>
                <span style={{ transform: setupOpen ? 'rotate(0)' : 'rotate(-90deg)', transition: 'transform var(--fast)', display: 'flex' }}>
                  <ChevronDown size={14} strokeWidth={1.75} />
                </span>
              </div>
              {setupOpen && NAV_SETUP.map(s => {
                const cur = routeMatch(pathname, s.route);
                return (
                  <div key={s.id} onClick={() => go(s.route)} style={{ display: 'flex', alignItems: 'center', gap: 9,
                    padding: '7px 11px 7px 38px', fontFamily: 'var(--font-ui)', fontSize: 12.5,
                    fontWeight: cur ? 600 : 400, color: cur ? 'var(--t1)' : 'var(--t3)', cursor: 'pointer' }}
                    onMouseEnter={e => { if (!cur) e.currentTarget.style.color = 'var(--t1)'; }}
                    onMouseLeave={e => { if (!cur) e.currentTarget.style.color = 'var(--t3)'; }}>
                    <span style={{ width: 4, height: 4, borderRadius: '50%', background: cur ? 'var(--yellow)' : 'transparent' }} />
                    {s.label}
                  </div>
                );
              })}
            </>
          )}
        </div>
      </nav>

      {/* collapse toggle */}
      <button onClick={() => setCol(!collapsed)} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: collapsed ? 'center' : 'flex-start',
          margin: collapsed ? '0 14px 8px' : '0 10px 8px', padding: collapsed ? '9px 0' : '9px 11px', flexShrink: 0,
          background: 'transparent', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', cursor: 'pointer',
          color: 'var(--t3)', fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 500, transition: 'all var(--fast)' }}
        onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; e.currentTarget.style.color = 'var(--t1)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--t3)'; }}>
        {collapsed ? <ChevronRight size={16} strokeWidth={1.75} /> : <ChevronLeft size={16} strokeWidth={1.75} />}
        {!collapsed && <span>Collapse</span>}
      </button>

      {/* user */}
      <div style={{ borderTop: '1px solid var(--border)', padding: collapsed ? '12px 0' : '12px 16px', display: 'flex',
        alignItems: 'center', justifyContent: collapsed ? 'center' : 'flex-start', gap: 10, flexShrink: 0 }}>
        <div title={userLabel} style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--surface-2)', flexShrink: 0,
          border: '1px solid var(--border-2)', display: 'grid', placeItems: 'center',
          fontFamily: 'var(--font-display)', fontSize: 12, fontWeight: 700, color: 'var(--t2)' }}>{initial}</div>
        {!collapsed && <>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--t1)', fontWeight: 500,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{userLabel}</div>
            {userRole && <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--t3)' }}>{userRole}</div>}
          </div>
          <div onClick={onLogout} title="Sign out" style={{ color: 'var(--t4)', cursor: 'pointer', display: 'flex' }}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--t1)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--t4)'}>
            <LogOut size={16} strokeWidth={1.75} />
          </div>
        </>}
      </div>
    </aside>
  );
}
