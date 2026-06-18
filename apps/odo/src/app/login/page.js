'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';

const COND = "'Space Grotesk', system-ui, sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, monospace";

export default function LoginPage() {
  const { session, loading, signInWithGoogle } = useAuth();
  const router = useRouter();

  useEffect(() => { if (!loading && session) router.replace('/'); }, [session, loading, router]);

  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', fontFamily: MONO }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 360, padding: '0 20px' }}>
        <img src="/favicon.svg" alt="Odo" style={{ height: 64, width: 64, marginBottom: 24, borderRadius: 14 }} />
        <div style={{ fontFamily: COND, fontWeight: 700, fontSize: 34, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--t1)', lineHeight: 1, marginBottom: 6 }}>ODO</div>
        <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.3em', textTransform: 'uppercase', color: 'var(--t3)', marginBottom: 36 }}>Consolidated Sales</div>
        <div style={{ width: '100%', height: 1, background: 'var(--border)', marginBottom: 28 }} />
        <button onClick={signInWithGoogle} style={{ width: '100%', background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none', borderRadius: 6, padding: 14, fontFamily: COND, fontWeight: 700, fontSize: 12, letterSpacing: '0.2em', textTransform: 'uppercase', cursor: 'pointer' }}>Sign in with Google</button>
        <div style={{ marginTop: 40, fontFamily: MONO, fontSize: 9, color: 'var(--text-4)', letterSpacing: '0.15em', textTransform: 'uppercase' }}>@legendoftoys.com</div>
      </div>
    </div>
  );
}
