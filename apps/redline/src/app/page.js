'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { RequireAuth } from '@throttle/auth';

function Landing() {
  const router = useRouter();
  useEffect(() => { router.replace('/exec/'); }, [router]);
  return <div style={{ padding: 20, color: '#888' }}>Loading…</div>;
}

export default function Home() {
  return <RequireAuth><Landing /></RequireAuth>;
}
