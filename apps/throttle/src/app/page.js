'use client';
import { useAuth } from '@throttle/auth';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

export default function Home() {
  const { session, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!session) { router.replace('/login/'); return; }
    router.replace('/dashboard/');
  }, [session, loading, router]);

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <p style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', letterSpacing: '.2em', textTransform: 'uppercase' }}>Loading...</p>
    </div>
  );
}
