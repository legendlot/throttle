'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { GarageIcon } from '../../components/GarageIcon.js';

const COND = "'Tomorrow', system-ui, -apple-system, 'Helvetica Neue', sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, Menlo, monospace";

export default function LoginPage() {
  const { session, loading, signInWithGoogle } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && session) router.replace('/');
  }, [session, loading, router]);

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      width: '100vw',
      height: '100dvh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#0e0e0e',
      fontFamily: MONO,
      margin: 0,
      padding: 0,
      overflow: 'hidden',
      zIndex: 1,
    }}>
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        width: 360,
        padding: '0 20px',
      }}>
        {/* LOT logo */}
        <img
          src="/lot-logo.png"
          alt="Legend of Toys"
          style={{ height: 56, width: 'auto', marginBottom: 36 }}
        />

        {/* System icon */}
        <div style={{ marginBottom: 12 }}>
          <GarageIcon size={40} showDot strokeWidth={2} />
        </div>

        {/* System title */}
        <div style={{
          fontFamily: COND,
          fontWeight: 900,
          fontSize: 36,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          color: '#f0f0f0',
          lineHeight: 1,
          marginBottom: 6,
        }}>
          GARAGE
        </div>

        {/* Sub-title */}
        <div style={{
          fontFamily: MONO,
          fontSize: 10,
          letterSpacing: '0.3em',
          textTransform: 'uppercase',
          color: '#666',
          marginBottom: 36,
        }}>
          Inventory · Store
        </div>

        {/* Divider */}
        <div style={{ width: '100%', height: 1, background: '#1e1e1e', marginBottom: 28 }} />

        {/* Sign-in button — explicit hex values */}
        <button
          onClick={signInWithGoogle}
          style={{
            width: '100%',
            background: '#F2CD1A',
            color: '#080808',
            border: 'none',
            borderRadius: 6,
            padding: '14px',
            fontFamily: COND,
            fontWeight: 700,
            fontSize: 12,
            letterSpacing: '0.2em',
            textTransform: 'uppercase',
            cursor: 'pointer',
            transition: 'opacity .15s, transform .1s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.9'; }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
          onMouseDown={(e) => { e.currentTarget.style.transform = 'scale(0.99)'; }}
          onMouseUp={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
        >
          Sign in with Google
        </button>

        {/* Footer */}
        <div style={{
          marginTop: 48,
          fontFamily: MONO,
          fontSize: 9,
          color: '#3a3a3a',
          letterSpacing: '0.15em',
          textTransform: 'uppercase',
        }}>
          @legendoftoys.com
        </div>
      </div>
    </div>
  );
}
