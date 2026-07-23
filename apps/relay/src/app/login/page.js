'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';

const COND = "'Space Grotesk', system-ui, -apple-system, 'Helvetica Neue', sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, Menlo, monospace";

export default function LoginPage() {
  const { session, loading, signInWithGoogle } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && session) router.replace('/');
  }, [session, loading, router]);

  return (
    <div style={{
      position: 'fixed', inset: 0,
      width: '100vw', height: '100dvh',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg)', fontFamily: MONO,
      margin: 0, padding: 0, overflow: 'hidden', zIndex: 1,
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 360, padding: '0 20px' }}>
        <img src="/brand/relay/relay-icon.svg" alt="Relay" style={{ height: 64, width: 64, marginBottom: 24 }} />

        <div style={{
          fontFamily: COND, fontWeight: 900, fontSize: 36,
          letterSpacing: '0.04em', textTransform: 'uppercase',
          color: 'var(--text-1)', lineHeight: 1, marginBottom: 6,
        }}>
          RELAY
        </div>

        <div style={{
          fontFamily: MONO, fontSize: 10, letterSpacing: '0.3em',
          textTransform: 'uppercase', color: 'var(--text-3)', marginBottom: 36,
        }}>
          Comms
        </div>

        <div style={{ width: '100%', height: 1, background: 'var(--border)', marginBottom: 28 }} />

        <button
          onClick={signInWithGoogle}
          style={{
            width: '100%', background: '#F2CD1A', color: '#17140a', border: 'none',
            borderRadius: 6, padding: '14px',
            fontFamily: COND, fontWeight: 700, fontSize: 12,
            letterSpacing: '0.2em', textTransform: 'uppercase', cursor: 'pointer',
            transition: 'opacity .15s, transform .1s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.92'; }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
          onMouseDown={(e) => { e.currentTarget.style.transform = 'scale(0.99)'; }}
          onMouseUp={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
        >
          Sign in with Google
        </button>

        <div style={{
          marginTop: 48, fontFamily: MONO, fontSize: 9, color: 'var(--text-4)',
          letterSpacing: '0.15em', textTransform: 'uppercase',
        }}>
          @legendoftoys.com
        </div>
      </div>
    </div>
  );
}
