'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';

export default function AuthCallback() {
  const { session, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (session) router.replace('/');
    else router.replace('/login/');
  }, [session, loading, router]);

  return <div style={{ padding: 20, color: '#888' }}>Signing in…</div>;
}
