'use client';
import { usePathname, useRouter } from 'next/navigation';

const TABS = [
  { id: 'shipments',   label: 'Shipments',       route: '/returns/shipments' },
  { id: 'process',     label: 'Process / Disposition', route: '/returns/process' },
  { id: 'udr-pool',    label: 'Issue UDR',       route: '/returns/udr-pool' },
  { id: 'repair-pool', label: 'Issue Repair',    route: '/returns/repair-pool' },
  { id: 'losses',      label: 'Loss Notes',      route: '/returns/losses' },
  { id: 'channels',    label: 'Channels',        route: '/returns/channels' },
];

const tabBtn = (active) => ({
  background: 'transparent',
  color: active ? 'var(--yellow)' : 'var(--t3)',
  border: 'none',
  borderBottom: active ? '2px solid var(--yellow)' : '2px solid transparent',
  padding: '8px 14px 10px',
  fontFamily: 'var(--cond)',
  fontSize: 13,
  fontWeight: active ? 700 : 500,
  letterSpacing: '0.04em',
  textTransform: 'capitalize',
  cursor: 'pointer',
  marginRight: 4,
});

export default function ReturnsLayout({ children }) {
  const pathname = usePathname();
  const router = useRouter();

  return (
    <div style={{ color: 'var(--t1)' }}>
      <div style={{ marginBottom: 8, display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap' }}>
        <h1 style={{ fontFamily: 'var(--cond)', fontSize: 28, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.03em', margin: 0 }}>
          Returns
        </h1>
        <p style={{ color: 'var(--t3)', fontSize: 11, margin: 0, fontFamily: 'var(--mono)' }}>
          Receive, inspect, and disposition returns from all channels
        </p>
      </div>

      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', marginBottom: 16 }}>
        {TABS.map((t) => {
          // /returns/process can be on /returns/process?id=… so match by prefix
          const active = pathname === t.route || pathname.startsWith(t.route + '/') || pathname.startsWith(t.route + '?');
          return (
            <button
              key={t.id}
              type="button"
              style={tabBtn(active)}
              onClick={() => router.push(t.route)}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {children}
    </div>
  );
}
