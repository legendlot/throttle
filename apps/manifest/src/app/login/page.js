'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { supabase } from '@throttle/db';

const COND = "'Space Grotesk', system-ui, -apple-system, 'Helvetica Neue', sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, Menlo, monospace";

export default function LoginPage() {
  const { session, loading, signInWithGoogle } = useAuth();
  const router = useRouter();
  const [mode, setMode]   = useState('google');   // 'google' (LOT) | 'email' (SF)
  const [email, setEmail] = useState('');
  const [sent, setSent]   = useState(false);
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!loading && session) router.replace('/');
  }, [session, loading, router]);

  async function sendLink(e) {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: { emailRedirectTo: window.location.origin },
      });
      if (error) throw error;
      setSent(true);
    } catch (err) {
      setError(err?.message || 'Could not send the login link');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, width: '100vw', height: '100dvh',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg)', fontFamily: MONO, margin: 0, padding: 0, overflow: 'hidden', zIndex: 1,
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 360, padding: '0 20px' }}>
        <img src="/favicon.svg" alt="Manifest" style={{ height: 64, width: 64, marginBottom: 24, borderRadius: 14 }} />

        <div style={{
          fontFamily: COND, fontWeight: 900, fontSize: 36, letterSpacing: '0.04em',
          textTransform: 'uppercase', color: 'var(--text-1)', lineHeight: 1, marginBottom: 6,
        }}>MANIFEST</div>
        <div style={{
          fontFamily: MONO, fontSize: 10, letterSpacing: '0.3em', textTransform: 'uppercase',
          color: 'var(--text-3)', marginBottom: 36,
        }}>China Imports</div>

        <div style={{ width: '100%', height: 1, background: 'var(--border)', marginBottom: 28 }} />

        {mode === 'google' ? (
          <>
            <button
              onClick={signInWithGoogle}
              style={{
                width: '100%', background: '#F2CD1A', color: '#282828', border: 'none',
                borderRadius: 6, padding: '14px', fontFamily: COND, fontWeight: 700, fontSize: 12,
                letterSpacing: '0.2em', textTransform: 'uppercase', cursor: 'pointer',
              }}
            >Sign in with Google</button>
            <button
              onClick={() => { setMode('email'); setError(''); }}
              style={{
                marginTop: 14, background: 'transparent', border: 'none', cursor: 'pointer',
                color: 'var(--text-3)', fontFamily: MONO, fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase',
              }}
            >Partner sign-in (email link)</button>
            <div style={{ marginTop: 40, fontFamily: MONO, fontSize: 9, color: 'var(--text-4)', letterSpacing: '0.15em', textTransform: 'uppercase' }}>
              @legendoftoys.com
            </div>
          </>
        ) : sent ? (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-1)', marginBottom: 10 }}>Check your email</div>
            <div style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-3)', lineHeight: 1.6 }}>
              A secure sign-in link was sent to<br /><span style={{ color: 'var(--text-2)' }}>{email}</span>.<br />Open it on this device to continue.
            </div>
            <button onClick={() => { setSent(false); setMode('google'); }}
              style={{ marginTop: 24, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-3)', fontFamily: MONO, fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase' }}>
              ← Back
            </button>
          </div>
        ) : (
          <form onSubmit={sendLink} style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <input
              type="email" required value={email} onChange={e => setEmail(e.target.value)}
              placeholder="you@solvefactory.com" autoFocus
              style={{
                width: '100%', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6,
                padding: '13px 14px', fontSize: 13, color: 'var(--text-1)', outline: 'none', fontFamily: MONO,
              }}
            />
            <button type="submit" disabled={busy || !email.trim()}
              style={{
                width: '100%', background: '#F2CD1A', color: '#282828', border: 'none', borderRadius: 6, padding: '14px',
                fontFamily: COND, fontWeight: 700, fontSize: 12, letterSpacing: '0.2em', textTransform: 'uppercase',
                cursor: busy ? 'wait' : 'pointer', opacity: busy || !email.trim() ? 0.6 : 1,
              }}>{busy ? 'Sending…' : 'Email me a login link'}</button>
            {error && <div style={{ color: 'var(--state-error-fg)', fontSize: 11, fontFamily: MONO, textAlign: 'center' }}>{error}</div>}
            <button type="button" onClick={() => { setMode('google'); setError(''); }}
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-3)', fontFamily: MONO, fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase' }}>
              ← LOT sign-in
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
