'use client';
/* The approval queue is now folded into Requests (filter + drawer). This
   legacy route redirects to /requests with the Pending filter intent. */
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function ApprovalRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/requests/'); }, [router]);
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'grid', placeItems: 'center', color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '.2em', textTransform: 'uppercase' }}>Redirecting…</div>
  );
}
