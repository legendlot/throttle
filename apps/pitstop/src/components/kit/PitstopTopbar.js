'use client';
/* ════════════════════════════════════════════════════════════
   PitstopTopbar — the Volt header (prototype <header>):
   breadcrumb (mono micro) · screen title (Tomorrow 19px UPPER) ·
   New Ticket CTA (yellow, glow) · dept switcher + app launcher
   (children) · Live · upd h:mm dot. App-local.
   ════════════════════════════════════════════════════════════ */
import { usePathname, useRouter } from 'next/navigation';
import { resolveNav } from '../../lib/nav.js';
import { Icon } from './Icon.js';
import { LiveDot, btnPrimary, istTimeLabel } from './Kit.js';

function fmtUpdated(d) {
  if (!d) return '';
  if (typeof d === 'string' && !/^\d/.test(d)) return d; // pre-formatted
  try {
    const date = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(date.getTime())) return typeof d === 'string' ? d : '';
    return istTimeLabel(date);
  } catch { return typeof d === 'string' ? d : ''; }
}

export function PitstopTopbar({ refreshing = false, lastRefreshed = null, badge = null, children }) {
  const pathname = usePathname();
  const router = useRouter();
  const { crumb, title } = resolveNav(pathname);

  return (
    <header style={{ position: 'sticky', top: 0, zIndex: 20,
      background: 'color-mix(in srgb, var(--bg) 88%, transparent)', backdropFilter: 'blur(12px)',
      borderBottom: '1px solid var(--border)', padding: '0 var(--pad)', height: 60,
      display: 'flex', alignItems: 'center', gap: 16, flexShrink: 0 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="num" style={{ fontSize: 10, letterSpacing: '0.14em', color: 'var(--t4)', textTransform: 'uppercase' }}>{crumb}</div>
        <h1 style={{ fontFamily: 'var(--f-display)', fontWeight: 700, fontSize: 19, letterSpacing: '0.04em',
          color: 'var(--t1)', textTransform: 'uppercase', lineHeight: 1.1, margin: '1px 0 0' }}>{title}</h1>
      </div>

      {/* Optional page-published status pill (set via useRefreshState().setTopbarBadge).
          A STATUS, not a filter — no click handler, cursor:default — and hidden entirely at 0
          so a healthy inbox shows nothing rather than a reassuring zero. */}
      {badge?.kind === 'awaiting' && badge.n > 0 && (
        <div title="Awaiting reply across all channels"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '5px 11px',
            borderRadius: 'var(--radius-sm)', background: 'var(--warn-bg)',
            border: '1px solid var(--warn-bd)', color: 'var(--warn-fg)',
            fontFamily: 'var(--f-display)', fontSize: 10.5, fontWeight: 700,
            letterSpacing: '0.08em', textTransform: 'uppercase',
            whiteSpace: 'nowrap', flexShrink: 0, cursor: 'default' }}>
          <Icon name="clock" size={12} /> {badge.n} awaiting
        </div>
      )}

      <button onClick={() => router.push('/new')} style={btnPrimary}>
        <Icon name="plus" size={14} /> New ticket
      </button>

      {children}

      <LiveDot refreshing={refreshing} updated={fmtUpdated(lastRefreshed)} />
    </header>
  );
}
