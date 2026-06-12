'use client';
import { useEffect } from 'react';
import { Spinner } from '@throttle/ui';

// Dispatch Counts moved to Redline → Dispatch (S128 — dispatch-team tooling).
const DEST = 'https://redline.legendoftoys.com/dispatch-counts';

export default function DispatchCountsMoved() {
  useEffect(() => { window.location.replace(DEST); }, []);
  return (
    <div style={{ padding: 48, textAlign: 'center', color: 'var(--t2)' }}>
      <Spinner />
      <div style={{ marginTop: 16, fontSize: 14 }}>
        Dispatch Counts has moved to <a href={DEST} style={{ color: 'var(--yellow)' }}>Redline → Dispatch</a>. Redirecting…
      </div>
    </div>
  );
}
