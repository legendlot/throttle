'use client';
/* Intake is now a global modal (New Request). This legacy route redirects
   to /requests and opens the modal so old bookmarks keep working. */
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function NewRequestRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/requests/');
    const t = setTimeout(() => window.dispatchEvent(new CustomEvent('throttle:newreq')), 350);
    return () => clearTimeout(t);
  }, [router]);
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'grid', placeItems: 'center', color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '.2em', textTransform: 'uppercase' }}>Opening…</div>
  );
}
