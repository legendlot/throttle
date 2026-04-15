'use client';
import { useAuth } from '@/lib/auth';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

export default function Home() {
  const { session, user, loading, signOut } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !session) router.replace('/login');
  }, [session, loading, router]);

  if (loading) return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
      <p className="text-zinc-500 text-sm">Loading...</p>
    </div>
  );

  if (!user) return null;

  return (
    <div className="min-h-screen bg-zinc-950 p-8">
      <div className="max-w-lg mx-auto">
        <h1 className="text-3xl font-bold text-white mb-1 tracking-tight">THROTTLE</h1>
        <p className="text-zinc-600 text-xs mb-8">Phase 1 — Foundation complete</p>
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 mb-6">
          <p className="text-zinc-500 text-xs mb-3 uppercase tracking-wider">Signed in as</p>
          <p className="text-white font-medium">{user.name}</p>
          <p className="text-zinc-500 text-sm">{user.email}</p>
          <div className="mt-3 flex gap-2">
            <span className="text-xs bg-zinc-800 text-zinc-300 px-2 py-1 rounded">{user.role}</span>
            {user.discipline && (
              <span className="text-xs bg-zinc-800 text-zinc-300 px-2 py-1 rounded">{user.discipline}</span>
            )}
          </div>
        </div>
        <button
          onClick={signOut}
          className="text-zinc-600 text-xs hover:text-zinc-400 transition-colors"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
