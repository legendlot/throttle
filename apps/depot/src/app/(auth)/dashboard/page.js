'use client';
/* ════════════════════════════════════════════════════════════
   Depot Overview — Phase 1 placeholder landing. A real warehouse
   dashboard (live dispatch counts, channel throughput, RTD stock,
   storage map) is Phase 2. For now this is a branded home with
   quick-links into the dispatch surface.
   ════════════════════════════════════════════════════════════ */
import { useRouter } from 'next/navigation';
import { Network, Send, ArrowLeftRight, FileText, RefreshCw, PackageCheck } from 'lucide-react';
import { DepotIcon } from '../../../components/DepotIcon.js';

const LINKS = [
  { label: 'Pipeline',        sub: 'Production → channel flow', route: '/dispatch-pipeline',  icon: Network },
  { label: 'Shipments',       sub: 'Build & ship by channel',   route: '/dispatch-shipments', icon: Send },
  { label: 'Repack',          sub: 'Channel-swap runs',         route: '/repack-runs',        icon: ArrowLeftRight },
  { label: 'Challans',        sub: 'Delivery documents',        route: '/dispatch-challans',  icon: FileText },
  { label: 'Unit Restock',    sub: 'Return units to pool',      route: '/restock',            icon: RefreshCw },
  { label: 'Dispatch Counts', sub: 'Cycle counts & audits',     route: '/dispatch-counts',    icon: PackageCheck },
];

export default function DepotOverview() {
  const router = useRouter();

  return (
    <div style={{ maxWidth: 980, margin: '0 auto' }}>
      {/* hero */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 8 }}>
        <DepotIcon size={40} />
        <div>
          <h1 className="font-display" style={{ fontSize: 28, fontWeight: 800, letterSpacing: '0.06em',
            textTransform: 'uppercase', color: 'var(--t1)', margin: 0 }}>Depot</h1>
          <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13.5, color: 'var(--t3)' }}>
            Warehouse · finished goods · dispatch
          </div>
        </div>
      </div>

      <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13.5, color: 'var(--t3)',
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)',
        padding: '12px 16px', margin: '14px 0 22px' }}>
        Dispatch now has its own home, running in parallel with Redline. A full overview
        dashboard — live counts, channel throughput, RTD stock and the storage map — lands next.
      </div>

      {/* quick links */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
        {LINKS.map(l => {
          const I = l.icon;
          return (
            <button key={l.route} onClick={() => router.push(l.route)}
              style={{ display: 'flex', alignItems: 'center', gap: 14, textAlign: 'left',
                background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)',
                padding: '16px 18px', cursor: 'pointer', transition: 'all var(--fast)', color: 'var(--t1)' }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--yellow)'; e.currentTarget.style.background = 'var(--surface-2)'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.background = 'var(--surface)'; }}>
              <span style={{ color: 'var(--yellow)', display: 'flex', flexShrink: 0 }}>
                <I size={22} strokeWidth={1.75} />
              </span>
              <span style={{ minWidth: 0 }}>
                <div style={{ fontFamily: 'var(--font-ui)', fontSize: 15, fontWeight: 600 }}>{l.label}</div>
                <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t3)' }}>{l.sub}</div>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
