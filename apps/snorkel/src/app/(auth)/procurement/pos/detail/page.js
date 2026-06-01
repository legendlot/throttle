'use client';
import { Suspense } from 'react';
import PODetailClient from '../[poNumber]/PODetailClient.js';

// BUG-C: static-export route — reads po_number from search params instead of
// the dynamic [poNumber] segment, since Next.js static export can't enumerate
// all PO numbers at build time. PODetailClient uses useSearchParams() which
// MUST be wrapped in a Suspense boundary for static export to render correctly
// (without it the route bails to client-only and 404s on direct load).
export default function Page() {
  return (
    <Suspense fallback={<div style={{ padding: 40, color: 'var(--t3)' }}>Loading…</div>}>
      <PODetailClient />
    </Suspense>
  );
}
