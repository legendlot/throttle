'use client';
/* ════════════════════════════════════════════════════════════
   PitstopSidebar — the Volt rail (prototype <aside>). 236px,
   --bg-2, brand header + ⌘K launcher + Work nav + Setup group +
   user footer. Active = --accent-bg fill + 1px --accent-bd +
   --t1 bold; inactive --t2, hover --surface. Badges mono pill.
   App-local (NOT shared @throttle/ui).
   ════════════════════════════════════════════════════════════ */
import { usePathname, useRouter } from 'next/navigation';
import { NAV_PRIMARY, NAV_SETUP, NAV_MANUAL, routeMatch, filterNav } from '../../lib/nav.js';
import { Icon } from './Icon.js';

export function PitstopSidebar({ perms = {}, badges = {}, userLabel = '', userRole = '', onCmdK, onLogout }) {
  const pathname = usePathname();
  const router = useRouter();
  const go = (route) => router.push(route);

  const primary = filterNav(NAV_PRIMARY, perms);
  const setup = filterNav(NAV_SETUP, perms);
  const initial = userLabel ? userLabel[0].toUpperCase() : '?';

  return (
    <aside style={{ width: 236, flexShrink: 0, background: 'var(--bg-2)', borderRight: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column', height: '100%' }}>

      {/* brand */}
      <div style={{ padding: '18px 18px 14px', display: 'flex', alignItems: 'center', gap: 10,
        borderBottom: '1px solid var(--border)' }}>
        <div style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--accent)', display: 'grid',
          placeItems: 'center', flexShrink: 0, boxShadow: 'var(--accent-glow)' }}>
          <Icon name="zap" size={17} style={{ color: 'var(--accent-fg)' }} />
        </div>
        <div>
          <div style={{ fontFamily: 'var(--f-display)', fontWeight: 700, fontSize: 16, letterSpacing: '0.08em',
            color: 'var(--t1)', lineHeight: 1 }}>PITSTOP</div>
          <div className="num" style={{ fontSize: 9, letterSpacing: '0.18em', color: 'var(--t4)',
            textTransform: 'uppercase', marginTop: 3 }}>Customer Success</div>
        </div>
      </div>

      {/* ⌘K launcher */}
      <button onClick={onCmdK} title="Search & commands (⌘K)"
        style={{ margin: '14px 14px 4px', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 11px',
          background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-sm)',
          color: 'var(--t3)', cursor: 'pointer', fontFamily: 'var(--f-ui)', fontSize: 12.5, textAlign: 'left' }}
        onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent-bd)'; e.currentTarget.style.color = 'var(--t2)'; }}
        onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-2)'; e.currentTarget.style.color = 'var(--t3)'; }}>
        <Icon name="search" size={14} />
        <span style={{ flex: 1 }}>Search &amp; commands</span>
        <kbd className="num" style={{ fontSize: 10, background: 'var(--surface-3)', border: '1px solid var(--border-2)',
          borderRadius: 4, padding: '1px 5px', color: 'var(--t3)' }}>⌘K</kbd>
      </button>

      {/* nav */}
      <nav style={{ flex: 1, overflowY: 'auto', padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div style={{ fontFamily: 'var(--f-display)', fontSize: 9.5, letterSpacing: '0.16em', color: 'var(--t4)',
          textTransform: 'uppercase', padding: '8px 8px 5px' }}>Work</div>
        {primary.map(item => {
          const active = routeMatch(pathname, item.route);
          const badge = item.badgeKey ? badges[item.badgeKey] : null;
          return (
            <button key={item.id} onClick={() => go(item.route)}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px',
                borderRadius: 'var(--radius-sm)', border: `1px solid ${active ? 'var(--accent-bd)' : 'transparent'}`,
                background: active ? 'var(--accent-bg)' : 'transparent', color: active ? 'var(--t1)' : 'var(--t2)',
                cursor: 'pointer', fontFamily: 'var(--f-ui)', fontSize: 13.5, fontWeight: active ? 700 : 500, width: '100%' }}
              onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--surface)'; }}
              onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}>
              <Icon name={item.icon} size={17} />
              <span style={{ flex: 1, textAlign: 'left' }}>{item.label}</span>
              {badge ? (
                <span className="num" style={{ fontSize: 10, background: active ? 'var(--accent)' : 'var(--surface-3)',
                  color: active ? 'var(--accent-fg)' : 'var(--t3)', borderRadius: 99, padding: '1px 7px',
                  minWidth: 20, textAlign: 'center' }}>{badge}</span>
              ) : null}
            </button>
          );
        })}

        {setup.length > 0 && (
          <>
            <div style={{ fontFamily: 'var(--f-display)', fontSize: 9.5, letterSpacing: '0.16em', color: 'var(--t4)',
              textTransform: 'uppercase', padding: '14px 8px 5px' }}>Setup</div>
            {setup.map(item => {
              const active = routeMatch(pathname, item.route);
              return (
                <button key={item.id} onClick={() => go(item.route)}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 9px', background: active ? 'var(--surface)' : 'transparent',
                    border: 'none', borderRadius: 'var(--radius-sm)', color: active ? 'var(--t2)' : 'var(--t3)',
                    cursor: 'pointer', fontFamily: 'var(--f-ui)', fontSize: 13, fontWeight: 500, width: '100%' }}
                  onMouseEnter={e => { if (!active) { e.currentTarget.style.background = 'var(--surface)'; e.currentTarget.style.color = 'var(--t2)'; } }}
                  onMouseLeave={e => { if (!active) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--t3)'; } }}>
                  <Icon name={item.icon} size={16} style={{ opacity: 0.8 }} />
                  <span style={{ flex: 1, textAlign: 'left' }}>{item.label}</span>
                </button>
              );
            })}
          </>
        )}

        {/* System Manual — flat, always available (keeps the existing feature reachable) */}
        <button onClick={() => go(NAV_MANUAL.route)}
          style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 10, padding: '8px 9px',
            background: routeMatch(pathname, NAV_MANUAL.route) ? 'var(--surface)' : 'transparent',
            border: 'none', borderRadius: 'var(--radius-sm)',
            color: routeMatch(pathname, NAV_MANUAL.route) ? 'var(--t2)' : 'var(--t3)',
            cursor: 'pointer', fontFamily: 'var(--f-ui)', fontSize: 13, fontWeight: 500, width: '100%' }}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface)'; e.currentTarget.style.color = 'var(--t2)'; }}
          onMouseLeave={e => { if (!routeMatch(pathname, NAV_MANUAL.route)) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--t3)'; } }}>
          <Icon name="book" size={16} style={{ opacity: 0.8 }} />
          <span style={{ flex: 1, textAlign: 'left' }}>{NAV_MANUAL.label}</span>
        </button>
      </nav>

      {/* user footer */}
      <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--surface-3)', display: 'grid',
          placeItems: 'center', fontFamily: 'var(--f-display)', fontWeight: 700, fontSize: 12, color: 'var(--accent)',
          flexShrink: 0 }}>{initial}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--t1)', whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis' }}>{userLabel || '—'}</div>
          {userRole && <div className="num" style={{ fontSize: 9.5, color: 'var(--t4)', textTransform: 'uppercase',
            letterSpacing: '0.08em' }}>{userRole}</div>}
        </div>
        {onLogout && (
          <button onClick={onLogout} title="Sign out"
            style={{ background: 'none', border: 'none', color: 'var(--t4)', cursor: 'pointer', display: 'flex',
              padding: 4, borderRadius: 6 }}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--t1)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--t4)'}>
            <Icon name="logout" size={16} />
          </button>
        )}
      </div>
    </aside>
  );
}
