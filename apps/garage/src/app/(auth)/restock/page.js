'use client';
import { useEffect } from 'react';
import { Spinner } from '@throttle/ui';

// Unit Restock moved to Redline → Dispatch (S128 — dispatch-team tooling).
const DEST = 'https://redline.legendoftoys.com/restock';

export default function RestockMoved() {
  useEffect(() => { window.location.replace(DEST); }, []);
  return (
    <div style={{ padding: 48, textAlign: 'center', color: 'var(--t2)' }}>
      <Spinner />
      <div style={{ marginTop: 16, fontSize: 14 }}>
        Unit Restock has moved to <a href={DEST} style={{ color: 'var(--yellow)' }}>Redline → Dispatch</a>. Redirecting…
      </div>
    </div>
  );
}
