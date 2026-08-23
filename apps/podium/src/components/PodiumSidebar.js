'use client';
// Podium-local sidebar (Pit Wall v2). Replaces the shared @throttle/ui Sidebar
// for Podium ONLY — the shared one stays byte-for-byte for the other apps.
// Collapsible: the PODIUM header is the toggle (chevron rotates 180° collapsed),
// default expanded, state persisted by the layout to localStorage podium-sb-collapsed.
// Nav is still driven by src/lib/nav.js (NAV_GROUPS + filterNavByPerms) — restyled,
// not regrouped. Flat entries (System Manual) render as a lone item with no header.
import { ChevronLeft, Search, LogOut } from 'lucide-react';
import { Avatar } from './ui.js';

// Longest matching route across every visible item → the active route.
function activeRoute(groups, pathname) {
  let best = '';
  for (const g of groups) {
    const items = g.flat ? [g] : (g.items || []);
    for (const it of items) {
      const r = it.route;
      if (!r) continue;
      if (pathname === r || pathname === r + '/' || pathname.startsWith(r + '/')) {
        if (r.length > best.length) best = r;
      }
    }
  }
  return best;
}

function NavItem({ item, active, collapsed, onClick }) {
  const Ic = item.icon;
  const orange = item.accent === 'orange';
  const iconColor = active ? 'var(--yellow)' : orange ? 'var(--orange)' : 'var(--t3)';
  const textColor = active ? 'var(--t1)' : orange ? 'var(--orange)' : 'var(--t3)';
  return (
    <div
      className="pd-nav-item"
      role="button" tabIndex={0}
      title={collapsed ? item.label : undefined}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: collapsed ? 'center' : 'flex-start',
        gap: 11, padding: '8px 12px', borderRadius: 6, cursor: 'pointer',
        background: active ? 'var(--surface)' : 'transparent',
        borderLeft: active ? '2px solid var(--yellow)' : '2px solid transparent',
        color: textColor,
      }}
    >
      {Ic && <Ic size={16} strokeWidth={1.75} color={iconColor} style={{ flex: 'none' }} />}
      {!collapsed && (
        <span style={{ fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: active ? 600 : 500, color: textColor, whiteSpace: 'nowrap' }}>
          {item.label}
        </span>
      )}
    </div>
  );
}

export function PodiumSidebar({ groups, pathname, onNavigate, collapsed, onToggle, userLabel, userRole, onSearch, onSignOut }) {
  const active = activeRoute(groups, pathname);

  return (
    <aside className="pd-rail" style={{
      width: collapsed ? 'var(--sidebar-w-collapsed)' : 'var(--sidebar-w)', flex: 'none',
      background: 'var(--bg-2)', borderRight: '1px solid var(--divider)',
      display: 'flex', flexDirection: 'column', transition: 'width 180ms var(--ease)',
    }}>
      {/* Header = collapse toggle */}
      <div
        className="pd-sb-head"
        onClick={onToggle}
        title="Collapse / expand sidebar"
        style={{
          display: 'flex', flexDirection: collapsed ? 'column' : 'row', alignItems: 'center',
          gap: collapsed ? 8 : 10, padding: collapsed ? '16px 8px 12px' : '18px 18px 14px',
          cursor: 'pointer', userSelect: 'none',
        }}
      >
        <span style={{
          width: 30, height: 30, borderRadius: 7, background: 'var(--yellow)', color: '#1b1b1e',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16, flex: 'none',
        }}>P</span>
        {!collapsed && (
          <>
            <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15, letterSpacing: '0.16em', color: 'var(--t1)', whiteSpace: 'nowrap' }}>PODIUM</span>
            <span style={{ flex: 1 }} />
          </>
        )}
        <ChevronLeft size={16} strokeWidth={2} color="var(--t3)"
          style={{ transform: collapsed ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 180ms', flex: 'none' }} />
      </div>

      {/* Search */}
      {!collapsed && (
        <div onClick={onSearch} style={{
          margin: '2px 14px 8px', display: 'flex', alignItems: 'center', gap: 8,
          background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 7,
          padding: '7px 10px', color: 'var(--t4)', cursor: 'text',
        }}>
          <Search size={14} strokeWidth={1.9} />
          <span style={{ fontSize: 12, flex: 1 }}>Search…</span>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 9, fontWeight: 600, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 5px', color: 'var(--t2)' }}>⌘K</span>
        </div>
      )}

      {/* Nav */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '2px 12px 12px' }}>
        {groups.map((g, gi) => g.flat ? (
          <div key={g.id}>
            {collapsed && <div style={divStyle} />}
            <NavItem item={g} active={active === g.route} collapsed={collapsed} onClick={() => onNavigate(g.route)} />
          </div>
        ) : (
          <div key={g.id}>
            {collapsed
              ? <div style={divStyle} />
              : <div style={{ padding: gi === 0 ? '11px 10px 5px' : '14px 10px 5px', fontFamily: 'var(--font-display)', fontSize: 9, fontWeight: 600, letterSpacing: '0.16em', color: 'var(--t5)', whiteSpace: 'nowrap' }}>{g.label}</div>}
            {(g.items || []).map(it => (
              <NavItem key={it.id} item={it} active={active === it.route} collapsed={collapsed} onClick={() => onNavigate(it.route)} />
            ))}
          </div>
        ))}
      </div>

      {/* User footer */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: collapsed ? 'center' : 'flex-start', gap: 10, padding: '11px 16px', borderTop: '1px solid var(--divider)' }}>
        <Avatar name={userLabel || '?'} size={32} radius={8} />
        {!collapsed && (
          <>
            <div style={{ minWidth: 0, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden' }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--t1)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{userLabel}</div>
              {userRole && <div style={{ fontSize: 10.5, color: 'var(--t4)', fontFamily: 'var(--font-display)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>{userRole}</div>}
            </div>
            {onSignOut && <button onClick={onSignOut} title="Sign out" aria-label="Sign out" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, background: 'transparent', color: 'var(--t3)', border: 'none', borderRadius: 6, cursor: 'pointer', flex: 'none' }}><LogOut size={15} /></button>}
          </>
        )}
      </div>
    </aside>
  );
}

const divStyle = { height: 1, background: 'var(--divider)', margin: '9px 6px 7px' };

export default PodiumSidebar;
