'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { supabase } from '@throttle/db';

// Official Google "G" mark (4-colour) — inline so no network fetch.
function GoogleG() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
    </svg>
  );
}

export default function LoginPage() {
  const { session, loading, signInWithGoogle } = useAuth();
  const router = useRouter();
  // Partner sign-in (S419, Manifest pattern): external partners use their OWN email and a one-time
  // link. shouldCreateUser:false — this page can never create an account; partners are invited
  // from Admin → Users, and an un-invited address simply gets no email.
  const [mode, setMode]   = useState('google');   // 'google' (LOT staff) | 'email' (partner)
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
        options: { emailRedirectTo: window.location.origin, shouldCreateUser: false },
      });
      // An un-invited address comes back as an error from Supabase; say the same thing either way
      // rather than confirming which addresses exist. The per-address resend cooldown ("For security
      // purposes, you can only request this after Ns") only ever hits an INVITED address, so it is
      // swallowed too — showing it would confirm the address is real.
      if (error && !/signups not allowed|not found|otp_disabled|for security purposes|rate limit/i.test(error.message || '')) throw error;
      setSent(true);
    } catch (err) {
      setError(err?.message || 'Could not send the sign-in link');
    } finally {
      setBusy(false);
    }
  }

  const linkBtn = {
    background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-3)',
    fontFamily: 'var(--font-mono)', fontSize: 12,
  };

  return (
    <div style={{
      position: 'fixed', inset: 0,
      width: '100vw', height: '100dvh',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg)', color: 'var(--text-1)', fontFamily: 'var(--font-ui)',
      margin: 0, padding: 24, boxSizing: 'border-box', overflowY: 'auto', zIndex: 1,
    }}>
      <div className="ig-up" style={{
        width: '100%', maxWidth: 400, display: 'flex', flexDirection: 'column',
        alignItems: 'center', gap: 28,
      }}>
        <img src="/ignition-mark.svg" alt="" style={{ height: 64, width: 'auto' }} />

        <div style={{ textAlign: 'center' }}>
          <div style={{
            fontFamily: 'var(--font-cond)', fontSize: 34, fontWeight: 700,
            letterSpacing: '0.1em', lineHeight: 1.1,
          }}>
            IGNITION
          </div>
          <div style={{ fontSize: 15, color: 'var(--text-3)', marginTop: 6 }}>
            Influencer CRM · Legend of Toys
          </div>
        </div>

        <div className="ig-fuse ig-growx" style={{ width: 160, height: 4, borderRadius: 2 }} />

        {mode === 'google' ? (<>
        <button
          onClick={signInWithGoogle}
          style={{
            width: '100%', height: 50, display: 'flex', alignItems: 'center', justifyContent: 'center',
            gap: 10, border: 'none', borderRadius: 14, background: 'var(--text-1)', color: 'var(--bg)',
            fontFamily: 'inherit', fontWeight: 700, fontSize: 15, cursor: 'pointer',
            transition: 'transform 160ms, box-shadow 160ms',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 8px 24px rgba(255,107,0,.2)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = 'none'; }}
        >
          <GoogleG />Continue with Google
        </button>

        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-4)' }}>
          @legendoftoys.com accounts only
        </div>
        <button type="button" onClick={() => { setMode('email'); setError(''); }} style={linkBtn}>
          Partner sign-in (email link)
        </button>
        </>) : sent ? (
          <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center' }}>
            <div style={{ fontSize: 16, fontWeight: 700 }}>Check your email</div>
            <div style={{ fontSize: 14, color: 'var(--text-3)', lineHeight: 1.6 }}>
              If <span style={{ color: 'var(--text-2)' }}>{email.trim()}</span> has been invited, a sign-in
              link is on its way. Open it on this device.
            </div>
            <button type="button" onClick={() => { setSent(false); setMode('google'); }} style={{ ...linkBtn, marginTop: 12 }}>
              ← Back
            </button>
          </div>
        ) : (
          <form onSubmit={sendLink} style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <input
              type="email" required value={email} onChange={e => setEmail(e.target.value)}
              placeholder="you@yourcompany.com" autoFocus
              style={{
                width: '100%', height: 50, boxSizing: 'border-box', background: 'var(--surface-2)',
                border: '1px solid var(--border)', borderRadius: 14, padding: '0 16px', fontSize: 15,
                color: 'var(--text-1)', outline: 'none', fontFamily: 'inherit',
              }}
            />
            <button type="submit" disabled={busy || !email.trim()}
              style={{
                width: '100%', height: 50, border: 'none', borderRadius: 14, background: 'var(--text-1)',
                color: 'var(--bg)', fontFamily: 'inherit', fontWeight: 700, fontSize: 15,
                cursor: busy ? 'wait' : 'pointer', opacity: busy || !email.trim() ? 0.6 : 1,
              }}>{busy ? 'Sending…' : 'Email me a sign-in link'}</button>
            {error && <div style={{ color: 'var(--state-error-fg)', fontSize: 13, textAlign: 'center' }}>{error}</div>}
            <button type="button" onClick={() => { setMode('google'); setError(''); }} style={linkBtn}>
              ← LOT staff sign-in
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
