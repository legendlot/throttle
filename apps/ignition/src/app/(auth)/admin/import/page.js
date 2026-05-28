'use client';
import { useAuth } from '@throttle/auth';

export default function ImportPage() {
  const { perms } = useAuth();
  if (!perms?.ignition_admin) return <div style={{ padding: 16, color: 'var(--text-3)' }}>Admin only.</div>;
  return (
    <div>
      <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: 16 }}>
        Sheet Import
      </h1>
      <div style={{ padding: 16, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', maxWidth: 720 }}>
        <p style={{ color: 'var(--text-2)', fontSize: 13, marginBottom: 12 }}>
          The Omnipresent sheet importer runs as a one-shot script during cutover, not from this UI.
        </p>
        <ol style={{ color: 'var(--text-2)', fontSize: 13, paddingLeft: 20, lineHeight: 1.8 }}>
          <li>Place the latest <code>Omnipresent - Influencer.xlsx</code> in <code>~/Downloads</code>.</li>
          <li>Run <code>python3 05_Throttle/scripts/import_omnipresent_influencer.py</code> from the workspace root.</li>
          <li>The script emits batched JSON and POSTs to the one-shot SECURITY DEFINER RPCs
            (<code>ignition.import_influencer_rows</code>,
            <code>import_engagement_rows</code>,
            <code>import_discount_code_rows</code>) per <a href="https://github.com/legendlot/throttle" style={{ color: '#FF6B00' }}>PATTERN-091</a>.</li>
          <li>Idempotency key: <code>legacy_sheet_ref = SHA1(...)</code> — rerun is safe.</li>
          <li>After import, the three RPCs are dropped.</li>
        </ol>
      </div>
    </div>
  );
}
