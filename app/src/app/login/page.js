'use client';
import { useAuth } from '@/lib/auth';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

export default function LoginPage() {
  const { session, signInWithGoogle, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && session) router.replace('/');
  }, [session, loading, router]);

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-white mb-2 tracking-tight">THROTTLE</h1>
        <p className="text-zinc-500 mb-8 text-sm">Brand Team Work OS — Legend of Toys</p>
        <button
          onClick={signInWithGoogle}
          className="bg-white text-black font-semibold px-6 py-3 rounded-lg hover:bg-zinc-100 transition-colors text-sm"
        >
          Sign in with Google
        </button>
        <p className="text-zinc-700 text-xs mt-4">@legendoftoys.com accounts only</p>
      </div>
    </div>
  );
}
