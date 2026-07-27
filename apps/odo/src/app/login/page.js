'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';

const COND = "'Sora', system-ui, sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, monospace";
// Same canvas recipe as the app shell (globals.css .so-app) — the sign-in screen is the
// first impression of the Prism theme, so it must not be a flat near-black.
const CANVAS = 'radial-gradient(1100px 620px at 76% -10%, rgba(76,99,240,.13), transparent 62%),'
  + 'radial-gradient(820px 520px at 8% 2%, rgba(242,205,26,.07), transparent 58%), #08090c';

export default function LoginPage() {
  const { session, loading, signInWithGoogle } = useAuth();
  const router = useRouter();

  useEffect(() => { if (!loading && session) router.replace('/'); }, [session, loading, router]);

  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: CANVAS, fontFamily: MONO }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 360, padding: '0 20px' }}>
        <img src="/odo-mark-tile.svg" alt="Odo" style={{ height: 64, width: 64, marginBottom: 24 }} />
        <div style={{ fontFamily: COND, fontWeight: 800, fontSize: 34, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--t1)', lineHeight: 1, marginBottom: 6 }}>ODO</div>
        <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.3em', textTransform: 'uppercase', color: 'var(--t4)', marginBottom: 36 }}>Consolidated Sales</div>
        <div style={{ width: '100%', height: 1, background: 'var(--border)', marginBottom: 28 }} />
        <button onClick={signInWithGoogle} style={{ width: '100%', background: 'var(--accent-grad)', color: 'var(--accent-fg)', border: 'none', borderRadius: 10, padding: 14, fontFamily: 'var(--ui)', fontWeight: 600, fontSize: 13, letterSpacing: '0.02em', cursor: 'pointer', boxShadow: '0 8px 22px -10px rgba(242,205,26,.8)' }}>Sign in with Google</button>
        <div style={{ marginTop: 40, fontFamily: MONO, fontSize: 9, color: 'var(--t5)', letterSpacing: '0.15em', textTransform: 'uppercase' }}>@legendoftoys.com</div>
      </div>
    </div>
  );
}
