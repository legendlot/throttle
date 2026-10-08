'use client';
import { useAuth } from '@throttle/auth';
import { Card } from '../../../../components/ui';

export default function ImportPage() {
  const { perms } = useAuth();
  if (!perms?.ignition_admin) return <div style={{ padding: 16, color: 'var(--text-3)' }}>Admin only.</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, letterSpacing: '.14em', color: 'var(--text-4)' }}>
          ADMIN · OMNIPRESENT — INFLUENCER SHEET
        </div>
        <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 32, fontWeight: 700, margin: '6px 0 0' }}>
          Sheet Import
        </h1>
      </div>
      <Card style={{ maxWidth: 720 }}>
        <p style={{ color: 'var(--text-3)', fontSize: 14, lineHeight: 1.5, margin: '0 0 12px' }}>
          The Omnipresent sheet importer runs as a one-shot script during cutover, not from this UI.
        </p>
        <ol style={{ overflowWrap: 'anywhere', color: 'var(--text-2)', fontSize: 13, paddingLeft: 20, lineHeight: 1.8, margin: 0 }}>
          <li>Place the latest <code>Omnipresent - Influencer.xlsx</code> in <code>~/Downloads</code>.</li>
          <li>Run <code>python3 05_Throttle/scripts/import_omnipresent_influencer.py</code> from the workspace root.</li>
          <li>The script emits batched JSON and POSTs to the one-shot SECURITY DEFINER RPCs
            (<code>ignition.import_influencer_rows</code>,
            <code>import_engagement_rows</code>,
            <code>import_discount_code_rows</code>) per <a href="https://github.com/legendlot/throttle" style={{ color: 'var(--accent-hi)' }}>PATTERN-091</a>.</li>
          <li>Idempotency key: <code>legacy_sheet_ref = SHA1(...)</code> — rerun is safe.</li>
          <li>After import, the three RPCs are dropped.</li>
        </ol>
      </Card>
    </div>
  );
}
