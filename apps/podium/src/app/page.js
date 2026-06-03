'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { RequireAuth, useAuth } from '@throttle/auth';

function Landing() {
  const router = useRouter();
  const { perms } = useAuth();
  useEffect(() => {
    // Self-only users (no podium_view) can't load the browse surfaces — send them to My Performance.
    if (!perms) return;
    router.replace(perms.podium_view ? '/dashboard/' : '/me/');
  }, [router, perms]);
  return <div style={{ padding: 20, color: '#888' }}>Loading…</div>;
}

export default function Home() {
  return <RequireAuth><Landing /></RequireAuth>;
}
