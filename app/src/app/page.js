'use client';
import { useAuth } from '@/lib/auth';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

export default function Home() {
  const { session, brandUser, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!session) { router.replace('/login/'); return; }
    if (brandUser) { router.replace('/requests/'); }
  }, [session, brandUser, loading, router]);

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
      <p className="text-zinc-600 text-sm">Loading...</p>
    </div>
  );
}
