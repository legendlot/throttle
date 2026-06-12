'use client';
/* ════════════════════════════════════════════════════════════
   RedlineTopbar — Topbar2 from the redesign prototype:
   breadcrumb (group) · screen title (Tomorrow uppercase) ·
   "Updated h:mm" · Live dot. Crumb/title resolve from the nav
   config; updated time comes from the page RefreshContext.
   ════════════════════════════════════════════════════════════ */
import { usePathname } from 'next/navigation';
import { resolveNav } from '../../lib/nav.js';

function fmtTime(d) {
  if (!d) return null;
  try {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(d instanceof Date ? d : new Date(d));
  } catch (_) { return null; }
}

export function RedlineTopbar({ refreshing = false, lastRefreshed = null, right }) {
  const pathname = usePathname();
  const hit = resolveNav(pathname);
  const crumb = hit?.crumb || 'Redline';
  const title = hit?.item?.label || '';
  const updated = fmtTime(lastRefreshed);

  return (
    <header style={{ height: 56, borderBottom: '1px solid var(--border)', display: 'flex',
      alignItems: 'center', gap: 12, padding: '0 24px', flexShrink: 0, background: 'var(--bg)' }}>
      <span className="label" style={{ color: 'var(--t3)' }}>{crumb}</span>
      <span style={{ color: 'var(--border-2)' }}>/</span>
      <h1 className="font-display" style={{ fontSize: 17, fontWeight: 700, letterSpacing: '0.04em',
        color: 'var(--t1)', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{title}</h1>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 16 }}>
        {right}
        {updated && <span className="num" style={{ fontSize: 11, color: 'var(--t3)', whiteSpace: 'nowrap' }}>
          Updated {updated}</span>}
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className={refreshing ? '' : 'rl-pulse'} style={{ width: 7, height: 7, borderRadius: '50%',
            background: refreshing ? 'var(--amber)' : 'var(--green)' }} />
          <span className="label" style={{ fontSize: 10, color: 'var(--t2)' }}>{refreshing ? 'Sync' : 'Live'}</span>
        </span>
      </div>
    </header>
  );
}
