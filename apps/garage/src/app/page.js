'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth, RequireAuth, getDefaultRoute } from '@throttle/auth';

function Landing() {
  const { perms, loading } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (loading) return;
    const target = getDefaultRoute(perms);
    router.replace(target + (target.endsWith('/') ? '' : '/'));
  }, [perms, loading, router]);
  return <div style={{ padding: 20, color: '#888' }}>Loading…</div>;
}

export default function Home() {
  return <RequireAuth><Landing /></RequireAuth>;
}
