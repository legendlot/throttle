'use client';
import { Search, Pin, RefreshCw, ChevronRight } from 'lucide-react';
import { groupLabelForRoute, titleForRoute, matchRoute } from '../../lib/nav.js';

// ════════════════════════════════════════════════════════════════════
// GarageTopbar — breadcrumb (group) · title (Tomorrow uppercase) ·
// pin-current toggle · ⌘K search launcher · refresh · Live dot.
// Garage-specific (the shared @throttle/ui Topbar is left untouched for
// the 5 other apps that use it).
// ════════════════════════════════════════════════════════════════════

const iconBtn = { width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', color: 'var(--t3)', cursor: 'pointer', flexShrink: 0 };
const kbdStyle = { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--t3)', background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 4, padding: '2px 6px' };

export function GarageTopbar({ nav, pathname, onOpenPalette, pins, onTogglePin, onRefresh, refreshing }) {
  const group = groupLabelForRoute(nav, pathname);
  const title = titleForRoute(nav, pathname);
  const canPin = !!title; // only pin recognised screens
  const isPinned = pins.some((r) => matchRoute(r, pathname));
  const currentRoute = (() => {
    // the longest nav route that matches — the canonical route to pin
    let best = '';
    for (const r of Object.keys(routeMap(nav))) {
      if (matchRoute(r, pathname) && r.length > best.length) best = r;
    }
    return best || pathname;
  })();

  return (
    <header style={{ height: 60, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 14, padding: '0 22px', borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, minWidth: 0 }}>
        <span className="eyebrow" style={{ whiteSpace: 'nowrap' }}>{group}</span>
        <ChevronRight size={12} strokeWidth={1.75} style={{ color: 'var(--t4)', alignSelf: 'center' }} />
        <span className="title" style={{ fontSize: 16.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</span>
      </div>

      {canPin && (
        <button onClick={() => onTogglePin(currentRoute)} title={isPinned ? 'Unpin this page' : 'Pin this page'}
          style={{ ...iconBtn, width: 32, height: 32, color: isPinned ? 'var(--yellow)' : 'var(--t4)', borderColor: isPinned ? 'var(--brand-bd)' : 'var(--border)', background: isPinned ? 'var(--yellow-dim)' : 'var(--surface)' }}>
          <Pin size={14} strokeWidth={1.75} />
        </button>
      )}

      <button onClick={onOpenPalette} style={{
        marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 9, width: 'min(300px, 32vw)',
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)',
        padding: '8px 12px', cursor: 'pointer', color: 'var(--t3)', transition: 'border-color var(--fast)',
      }}
        onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--border-3)'}
        onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}>
        <Search size={15} strokeWidth={1.75} />
        <span style={{ flex: 1, textAlign: 'left', fontSize: 13.5, fontFamily: 'var(--font-ui)' }}>Search Garage…</span>
        <kbd style={kbdStyle}>⌘K</kbd>
      </button>

      <button title="Refresh" onClick={onRefresh} style={iconBtn}>
        <RefreshCw size={16} strokeWidth={1.75} style={{ animation: refreshing ? 'g-spin .7s linear infinite' : 'none' }} />
      </button>

      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-display)', fontSize: 10, fontWeight: 600, letterSpacing: '0.12em', color: 'var(--ok-fg)', textTransform: 'uppercase' }}>
        <span className="g-pulse" style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--ok-fg)' }} />Live
      </span>
    </header>
  );
}

function routeMap(nav) {
  const map = {};
  for (const g of nav.primary) {
    if (g.single) { map[g.route] = g; continue; }
    for (const i of g.items) map[i.route] = i;
  }
  for (const i of nav.drawer.items) map[i.route] = i;
  return map;
}
