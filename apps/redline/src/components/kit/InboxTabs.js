'use client';
/* ════════════════════════════════════════════════════════════
   InboxTabs — shared header for the five Inbox streams
   (handoff §7.8). The prototype (redesign-reference/app/inbox.jsx)
   renders these as in-page tabs; here each stream is its own
   route, so the tab bar NAVIGATES (router.push) and the active
   tab derives from usePathname(). URLs stay stable.
   Props: counts — optional { alerts, returns, scans, corrections,
   repair } numbers; a count chip renders only when provided.
   ════════════════════════════════════════════════════════════ */
import { usePathname, useRouter } from 'next/navigation';
import { Icon } from './Kit.js';

const TABS = [
  { id: 'alerts',      label: 'Alerts',      href: '/alerts',       icon: 'alert',    attention: true },
  { id: 'returns',     label: 'Returns',     href: '/returns',      icon: 'undo',     attention: true },
  { id: 'scans',       label: 'Scans',       href: '/scans',        icon: 'activity', attention: false },
  { id: 'corrections', label: 'Corrections', href: '/corrections',  icon: 'edit',     attention: false },
  { id: 'repair',      label: 'Repair',      href: '/repair-queue', icon: 'wrench',   attention: true },
];

export function InboxTabs({ counts = {} }) {
  const pathname = usePathname() || '';
  const router = useRouter();
  const current = pathname.replace(/\/+$/, '') || '/';

  return (
    <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
      {TABS.map(t => {
        const on = current === t.href || current.startsWith(`${t.href}/`);
        const count = counts[t.id];
        return (
          <button
            key={t.id}
            onClick={() => { if (!on) router.push(t.href); }}
            aria-current={on ? 'page' : undefined}
            style={{
              display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer',
              background: on ? 'var(--surface-3)' : 'transparent',
              border: `1px solid ${on ? 'var(--border-3)' : 'var(--border)'}`,
              color: on ? 'var(--t1)' : 'var(--t3)',
              borderRadius: 'var(--r-full)', padding: '7px 14px', whiteSpace: 'nowrap',
              fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 600,
              transition: 'all var(--fast) var(--ease)',
            }}
          >
            <Icon name={t.icon} size={14} /> {t.label}
            {count != null && (
              <span className="num" style={{ fontSize: 11, fontWeight: 700,
                color: t.attention && count > 0 ? 'var(--bad-fg)' : on ? 'var(--t1)' : 'var(--t4)' }}>
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
