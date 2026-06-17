'use client';
import { Panel } from '@throttle/ui';

const DEPOT_URL = 'https://depot.legendoftoys.com';

// Dispatch was carved out of Redline into its own app (Depot) — Session 152 cutover.
// This stub stays so the team (and old bookmarks) land on a clear pointer, not a 404.
export default function DispatchMovedPage() {
  return (
    <div style={{ maxWidth: 640, margin: '8vh auto 0', padding: '0 20px' }}>
      <Panel title="Dispatch has moved to Depot" icon="truck">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '6px 2px 4px' }}>
          <p style={{ fontFamily: 'var(--font-ui)', fontSize: 14, lineHeight: 1.6, color: 'var(--t2)', margin: 0 }}>
            All dispatch screens — Pipeline, Shipments, Challans, Counts, Roster, Unit Restock,
            Channels, the live floor views and the Stock Audit — now live in <strong>Depot</strong>,
            the dedicated dispatch back-office app. Redline is production-only.
          </p>
          <a
            href={DEPOT_URL}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              alignSelf: 'flex-start',
              display: 'inline-flex', alignItems: 'center', gap: 8,
              fontFamily: 'var(--font-ui)', fontSize: 14, fontWeight: 700,
              textDecoration: 'none', color: '#fff', background: 'var(--accent, #DE2A2A)',
              padding: '11px 18px', borderRadius: 'var(--r-sm, 8px)',
            }}
          >
            Open Depot →
          </a>
          <p style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t3)', margin: 0 }}>
            Bookmark it: <span className="num" style={{ color: 'var(--t2)' }}>{DEPOT_URL.replace('https://', '')}</span>
          </p>
        </div>
      </Panel>
    </div>
  );
}
