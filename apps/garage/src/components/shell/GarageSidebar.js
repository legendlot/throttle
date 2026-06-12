'use client';
import { useState, useEffect, createElement } from 'react';
import {
  Search, Pin, ChevronDown, ChevronRight, ChevronsLeft, Settings,
} from 'lucide-react';
import { GarageIcon } from '../GarageIcon.js';
import { matchRoute } from '../../lib/nav.js';

// ════════════════════════════════════════════════════════════════════
// GarageSidebar — Garage-specific accordion sidebar (redesign S128).
// Distinct from the shared @throttle/ui Sidebar (used by 5 other apps);
// this one adds: only-active-group-expands accordion, a user-managed
// Pinned section, a collapsed 56px icon rail, a Setup & More drawer, and
// a prominent ⌘K launcher. Route-based; Next.js navigation via onNavigate.
// ════════════════════════════════════════════════════════════════════

function Ico({ icon, size = 17, sw = 1.75, ...rest }) {
  if (!icon) return null;
  return createElement(icon, { size, strokeWidth: sw, ...rest });
}

const kbdStyle = { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--t3)', background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 4, padding: '2px 6px', lineHeight: 1.2 };
const aGroupHdr = { width: '100%', display: 'flex', alignItems: 'center', gap: 11, padding: '11px 14px', background: 'none', border: 'none', cursor: 'pointer' };
const countPill = { fontFamily: 'var(--font-mono)', fontSize: 10.5, fontWeight: 600, color: '#fff', background: 'var(--brand-red, #de2a2a)', borderRadius: 'var(--r-full)', padding: '1px 7px', minWidth: 18, textAlign: 'center' };
const railToggle = { width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: '1px solid var(--border-2)', borderRadius: 'var(--r-xs)', color: 'var(--t3)', cursor: 'pointer' };
const drawerItem = { width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: 'none', border: 'none', cursor: 'pointer', borderRadius: 'var(--r-xs)', fontSize: 13.5, fontFamily: 'var(--font-ui)', fontWeight: 500, textAlign: 'left' };

function Brand({ short }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
      <span style={{ width: 28, height: 28, borderRadius: 'var(--r-sm)', background: 'var(--yellow)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {/* dark glyph on the yellow tile — yellow-on-yellow was invisible */}
        <GarageIcon size={17} strokeWidth={2.6} color="#161616" />
      </span>
      {!short && <span style={{ fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 700, letterSpacing: '0.1em', color: 'var(--t1)' }}>GARAGE</span>}
    </span>
  );
}

function SectionLabel({ icon, children }) {
  return (
    <div className="eyebrow" style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '12px 16px 5px' }}>
      {icon && <Ico icon={icon} size={11} />}{children}
    </div>
  );
}

// Top-level row (single destination / pinned-in-rail / collapsed group)
function TopRow({ icon, label, on, collapsed, onClick, badge }) {
  return (
    <button onClick={onClick} title={collapsed ? label : undefined} style={{
      width: '100%', display: 'flex', alignItems: 'center', gap: 11, position: 'relative',
      padding: collapsed ? '10px 0' : '10px 14px', justifyContent: collapsed ? 'center' : 'flex-start',
      background: on ? 'var(--yellow-dim)' : 'transparent', border: 'none', cursor: 'pointer',
      borderLeft: `2px solid ${on ? 'var(--yellow)' : 'transparent'}`,
      color: on ? 'var(--yellow)' : 'var(--t2)', transition: 'background var(--fast)',
    }}
      onMouseEnter={e => { if (!on) e.currentTarget.style.background = 'var(--surface-2)'; }}
      onMouseLeave={e => { if (!on) e.currentTarget.style.background = 'transparent'; }}>
      <span style={{ color: on ? 'var(--yellow)' : 'var(--t3)', display: 'flex' }}><Ico icon={icon} size={19} /></span>
      {!collapsed && <span style={{ flex: 1, textAlign: 'left', fontSize: 14.5, fontFamily: 'var(--font-display)', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{label}</span>}
      {!collapsed && badge != null && badge > 0 && <span style={countPill}>{badge > 99 ? '99+' : badge}</span>}
      {collapsed && badge != null && badge > 0 && <span style={{ position: 'absolute', top: 8, right: 12, width: 6, height: 6, borderRadius: '50%', background: 'var(--bad-fg)' }} />}
    </button>
  );
}

// Sub-item row with hover pin affordance
function SubRow({ item, on, onNavigate, pinned, onTogglePin, flush, badge }) {
  const isPinned = pinned.includes(item.route);
  return (
    <button className="g-navrow" onClick={() => onNavigate(item.route)} style={{
      width: '100%', display: 'flex', alignItems: 'center', gap: 11,
      padding: flush ? '8px 12px 8px 16px' : '8px 14px 8px 44px',
      background: on ? 'var(--yellow-dim)' : 'transparent', border: 'none', cursor: 'pointer',
      borderLeft: `2px solid ${on ? 'var(--yellow)' : 'transparent'}`,
      color: on ? 'var(--yellow)' : 'var(--t2)', transition: 'background var(--fast)',
    }}
      onMouseEnter={e => { if (!on) e.currentTarget.style.background = 'var(--surface-2)'; }}
      onMouseLeave={e => { if (!on) e.currentTarget.style.background = 'transparent'; }}>
      <span style={{ color: on ? 'var(--yellow)' : 'var(--t3)', display: 'flex' }}><Ico icon={item.icon} size={16} /></span>
      <span style={{ flex: 1, textAlign: 'left', fontSize: 14, fontFamily: 'var(--font-ui)', fontWeight: on ? 600 : 500 }}>{item.label}</span>
      {badge != null && badge > 0 && <span style={countPill}>{badge > 99 ? '99+' : badge}</span>}
      <span className="g-pinbtn" data-pinned={isPinned ? 'true' : 'false'}
        onClick={e => { e.stopPropagation(); onTogglePin(item.route); }}
        title={isPinned ? 'Unpin' : 'Pin'}
        style={{ display: 'flex', padding: 3, borderRadius: 4, flexShrink: 0 }}>
        <Pin size={12.5} strokeWidth={1.75} />
      </span>
    </button>
  );
}

export function GarageSidebar({
  nav, pathname, onNavigate, pins, onTogglePin,
  collapsed, onToggleCollapsed, onOpenPalette,
  userLabel = '', userInitial = '?', userRole = '', onLogout,
  alertCount = 0,
}) {
  // Which primary group is open. Only one at a time (accordion). Defaults to
  // the group that owns the current route; re-syncs whenever the route changes.
  const activeGroupId = (() => {
    for (const g of nav.primary) {
      if (g.single) { if (matchRoute(g.route, pathname)) return g.id; continue; }
      if (g.items.some((i) => matchRoute(i.route, pathname))) return g.id;
    }
    return nav.primary[0]?.id;
  })();
  const inDrawer = nav.drawer.items.some((i) => matchRoute(i.route, pathname));

  const [expanded, setExpanded] = useState(activeGroupId);
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => { setExpanded(activeGroupId); }, [pathname]); // eslint-disable-line

  const W = collapsed ? 56 : 248;
  const itemByRoute = (() => {
    const map = {};
    for (const g of nav.primary) {
      if (g.single) { map[g.route] = g; continue; }
      for (const i of g.items) map[i.route] = i;
    }
    for (const i of nav.drawer.items) map[i.route] = i;
    return map;
  })();
  const pinList = pins.filter((r) => itemByRoute[r]);
  const badgeFor = (route) => (route === '/dashboard' ? alertCount : 0);
  // Only the LONGEST matching nav route is "active" — so /dispatch/unit-counts
  // doesn't also light up /dispatch.
  const activeRoute = (() => {
    let best = '';
    for (const r of Object.keys(itemByRoute)) {
      if (matchRoute(r, pathname) && r.length > best.length) best = r;
    }
    return best;
  })();
  const isOn = (route) => route === activeRoute;

  return (
    <aside style={{ width: W, flexShrink: 0, display: 'flex', flexDirection: 'column', background: 'var(--surface)', borderRight: '1px solid var(--border)', transition: 'width var(--base) var(--ease)', height: '100%', overflow: 'hidden' }}>
      {/* header — clicking anywhere on the bar collapses/expands the rail */}
      <div onClick={onToggleCollapsed} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        style={{ display: 'flex', alignItems: 'center', justifyContent: collapsed ? 'center' : 'space-between', height: 60, padding: collapsed ? 0 : '0 14px', borderBottom: '1px solid var(--border)', flexShrink: 0, cursor: 'pointer' }}>
        <Brand short={collapsed} />
        {!collapsed && <span style={railToggle}><ChevronsLeft size={15} strokeWidth={1.75} /></span>}
      </div>

      {/* search / ⌘K launcher */}
      <div style={{ padding: collapsed ? '10px 0' : '12px 12px 6px', display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
        {collapsed ? (
          <button onClick={onOpenPalette} title="Search · ⌘K" style={{ width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-2)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-sm)', color: 'var(--t3)', cursor: 'pointer' }}><Search size={16} strokeWidth={1.75} /></button>
        ) : (
          <button onClick={onOpenPalette} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 9, background: 'var(--bg-2)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-sm)', padding: '9px 12px', cursor: 'pointer', color: 'var(--t3)' }}>
            <Search size={15} strokeWidth={1.75} />
            <span style={{ flex: 1, textAlign: 'left', fontSize: 14, fontFamily: 'var(--font-ui)' }}>Search Garage…</span>
            <kbd style={kbdStyle}>⌘K</kbd>
          </button>
        )}
      </div>

      <nav style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '4px 0 8px' }}>
        {/* PINNED */}
        {pinList.length > 0 && (
          <div style={{ marginBottom: 6 }}>
            {!collapsed && <SectionLabel icon={Pin}>Pinned</SectionLabel>}
            {collapsed
              ? pinList.map((r) => <TopRow key={r} icon={itemByRoute[r].icon} label={itemByRoute[r].label} on={isOn(r)} collapsed onClick={() => onNavigate(r)} badge={badgeFor(r)} />)
              : pinList.map((r) => <SubRow key={r} item={itemByRoute[r]} on={isOn(r)} onNavigate={onNavigate} pinned={pins} onTogglePin={onTogglePin} badge={badgeFor(r)} flush />)}
            {collapsed && <div style={{ width: 28, height: 1, background: 'var(--border)', margin: '5px auto' }} />}
          </div>
        )}

        {/* PRIMARY GROUPS */}
        {nav.primary.map((g) => {
          if (g.single) {
            return <TopRow key={g.id} icon={g.icon} label={g.label} on={isOn(g.route)} collapsed={collapsed} onClick={() => onNavigate(g.route)} badge={badgeFor(g.route)} />;
          }
          const isExp = expanded === g.id && !collapsed;
          const hasActive = g.items.some((i) => isOn(i.route));
          return (
            <div key={g.id}>
              <button onClick={() => collapsed ? onNavigate(g.items[0].route) : setExpanded(isExp ? null : g.id)} title={collapsed ? g.label : undefined}
                style={{ ...aGroupHdr, position: 'relative', justifyContent: collapsed ? 'center' : 'flex-start', color: hasActive ? 'var(--t1)' : 'var(--t2)' }}>
                <span style={{ color: hasActive ? 'var(--yellow)' : 'var(--t3)', display: 'flex' }}><Ico icon={g.icon} size={18} /></span>
                {!collapsed && <>
                  <span style={{ flex: 1, textAlign: 'left', fontFamily: 'var(--font-display)', fontSize: 13, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{g.label}</span>
                  <ChevronDown size={13} strokeWidth={1.75} style={{ color: 'var(--t4)', transform: isExp ? 'none' : 'rotate(-90deg)', transition: 'transform var(--fast)' }} />
                </>}
              </button>
              {isExp && g.items.map((i) => (
                <SubRow key={i.route} item={i} on={isOn(i.route)} onNavigate={onNavigate} pinned={pins} onTogglePin={onTogglePin} badge={badgeFor(i.route)} />
              ))}
            </div>
          );
        })}
      </nav>

      {/* Setup & More drawer */}
      <div style={{ position: 'relative', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
        {drawerOpen && !collapsed && (
          <div style={{ position: 'absolute', bottom: 'calc(100% + 1px)', left: 8, right: 8, background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-md)', boxShadow: 'var(--shadow-pop)', padding: 6, maxHeight: 360, overflowY: 'auto', zIndex: 50 }}>
            {nav.drawer.items.map((i) => {
              const on = matchRoute(i.route, pathname);
              const isPinned = pins.includes(i.route);
              return (
                <button key={i.route} className="g-navrow" onClick={() => { onNavigate(i.route); setDrawerOpen(false); }} style={{ ...drawerItem, color: on ? 'var(--yellow)' : 'var(--t2)' }}>
                  <Ico icon={i.icon} size={15} style={{ color: on ? 'var(--yellow)' : 'var(--t3)' }} />
                  <span style={{ flex: 1, textAlign: 'left' }}>{i.label}</span>
                  <span className="g-pinbtn" data-pinned={isPinned ? 'true' : 'false'} onClick={e => { e.stopPropagation(); onTogglePin(i.route); }} title={isPinned ? 'Unpin' : 'Pin'} style={{ display: 'flex', padding: 3, borderRadius: 4 }}>
                    <Pin size={12.5} strokeWidth={1.75} />
                  </span>
                </button>
              );
            })}
          </div>
        )}
        <button onClick={() => collapsed ? onToggleCollapsed() : setDrawerOpen(d => !d)} title="Setup & More"
          style={{ ...aGroupHdr, justifyContent: collapsed ? 'center' : 'flex-start', color: inDrawer ? 'var(--t1)' : 'var(--t2)' }}>
          <span style={{ color: inDrawer ? 'var(--yellow)' : 'var(--t3)', display: 'flex' }}>{collapsed ? <ChevronRight size={18} strokeWidth={1.75} /> : <Settings size={18} strokeWidth={1.75} />}</span>
          {!collapsed && <>
            <span style={{ flex: 1, textAlign: 'left', fontFamily: 'var(--font-display)', fontSize: 13, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Setup &amp; More</span>
            <ChevronDown size={13} strokeWidth={1.75} style={{ color: 'var(--t4)', transform: drawerOpen ? 'none' : 'rotate(-90deg)', transition: 'transform var(--fast)' }} />
          </>}
        </button>
      </div>

      {/* user footer */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: collapsed ? '12px 0' : '12px 14px', borderTop: '1px solid var(--border)', justifyContent: collapsed ? 'center' : 'flex-start', flexShrink: 0 }}>
        <span style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--surface-3)', border: '1px solid var(--border-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 12.5, color: 'var(--t2)', flexShrink: 0 }}>{userInitial}</span>
        {!collapsed && <>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--t1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{userLabel}</div>
            <div className="eyebrow" style={{ fontSize: 9.5 }}>{userRole}</div>
          </div>
          {onLogout && <button onClick={onLogout} title="Sign out" style={{ background: 'none', border: 'none', color: 'var(--t3)', fontSize: 11, cursor: 'pointer', fontFamily: 'var(--font-display)', letterSpacing: '0.08em', textTransform: 'uppercase', padding: '4px 8px', borderRadius: 4, flexShrink: 0 }}>Out</button>}
        </>}
      </div>
    </aside>
  );
}
