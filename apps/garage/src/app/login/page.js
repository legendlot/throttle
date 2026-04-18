'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';

export default function LoginPage() {
  const { session, loading, signInWithGoogle } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && session) router.replace('/');
  }, [session, loading, router]);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#080808' }}>
      <div style={{ background: '#111', padding: 32, border: '1px solid #222', borderRadius: 8, textAlign: 'center', minWidth: 320 }}>
        <h1 style={{ fontSize: 20, margin: 0, marginBottom: 24, color: '#eee' }}>Garage</h1>
        <button
          onClick={signInWithGoogle}
          style={{ background: '#fff', color: '#111', border: 'none', padding: '10px 20px', borderRadius: 4, cursor: 'pointer', fontSize: 14 }}
        >
          Sign in with Google
        </button>
      </div>
    </div>
  );
}
