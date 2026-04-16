'use client';
import { useAuth } from '@/lib/auth';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

export default function LoginPage() {
  const { session, signInWithGoogle, loading: authLoading } = useAuth();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!authLoading && session) router.replace('/');
  }, [session, authLoading, router]);

  async function handleSignIn() {
    setLoading(true);
    setError(null);
    try {
      await signInWithGoogle();
    } catch (e) {
      setError(e.message);
      setLoading(false);
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: 'var(--bg)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 0,
    }}>
      {/* Logo mark */}
      <div style={{ marginBottom: 48, display: 'flex', alignItems: 'center', gap: 12 }}>
        {/* Checkered flag — larger version for login */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 8px)', gap: 0 }}>
          {[1,0,1,0, 0,1,0,1, 1,0,1,0, 0,1,0,1].map((v, i) => (
            <div key={i} style={{ width: 8, height: 8, background: v ? '#F2CD1A' : '#1e1e1e' }} />
          ))}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontFamily: 'var(--head)', fontWeight: 900, fontSize: 18, letterSpacing: '.3em', color: '#F2CD1A', textTransform: 'uppercase', lineHeight: 1 }}>
            Throttle
          </span>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.35em', color: 'var(--t3)', textTransform: 'uppercase' }}>
            Brand OS &middot; LOT
          </span>
        </div>
      </div>

      {/* Sign in button */}
      <button
        onClick={handleSignIn}
        disabled={loading}
        style={{
          background: '#F2CD1A',
          color: '#080808',
          border: 'none',
          borderRadius: 6,
          padding: '13px 32px',
          fontFamily: 'var(--head)',
          fontWeight: 700,
          fontSize: 11,
          letterSpacing: '.2em',
          textTransform: 'uppercase',
          cursor: loading ? 'not-allowed' : 'pointer',
          opacity: loading ? 0.6 : 1,
          transition: 'opacity .15s',
        }}
      >
        {loading ? 'Signing in...' : 'Sign in with Google'}
      </button>

      {error && (
        <p style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--red)', marginTop: 16 }}>
          {error}
        </p>
      )}

      <p style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', marginTop: 32, letterSpacing: '.1em' }}>
        @legendoftoys.com accounts only
      </p>
    </div>
  );
}
