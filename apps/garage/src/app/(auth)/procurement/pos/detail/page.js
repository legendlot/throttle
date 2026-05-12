'use client';
import PODetailClient from '../[poNumber]/PODetailClient.js';

// BUG-C: static-export route — reads po_number from search params instead of
// the dynamic [poNumber] segment, since Next.js static export can't enumerate
// all PO numbers at build time. PODetailClient uses useSearchParams().
export default function Page() {
  return <PODetailClient />;
}
