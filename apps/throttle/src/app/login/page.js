'use client';
/* Login — cinematic Night Circuit gate. Full-bleed hero + sign-in panel.
   Visuals ported from the prototype login.jsx; auth is the real Google
   Workspace OAuth (no password backend) — the primary CTA and the Google
   button both trigger signInWithGoogle. */
import { useAuth } from '@throttle/auth';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ThrottleMark } from '@/components/throttle/Shell';
import { Icon } from '@/components/throttle/Icon';

export default function LoginPage() {
  const { session, signInWithGoogle, loading: authLoading } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => { if (!authLoading && session) router.replace('/'); }, [session, authLoading, router]);

  async function submit(e) {
    if (e) e.preventDefault();
    setBusy(true); setError(null);
    try { await signInWithGoogle(); }
    catch (err) { setError(err.message); setBusy(false); }
  }

  const field = { width: '100%', background: 'var(--bg-2)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-sm)',
    padding: '12px 13px', color: 'var(--t1)', fontFamily: 'var(--font-ui)', fontSize: 14.5, outline: 'none' };
  const label = { fontFamily: 'var(--font-display)', fontSize: 10, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--t3)', display: 'block', marginBottom: 7 };

  return (
    <div data-dir="b" style={{ height: '100dvh', display: 'grid', gridTemplateColumns: '1.15fr 0.85fr', background: 'var(--bg)', overflow: 'hidden' }}>
      {/* hero */}
      <div style={{ position: 'relative', overflow: 'hidden' }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/throttle-hero-night.png" alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(115deg, rgba(12,11,16,0.55) 0%, rgba(12,11,16,0.30) 45%, rgba(12,11,16,0.78) 100%)' }} />
        <div style={{ position: 'relative', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: '40px 44px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
            <ThrottleMark size={38} />
            <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1 }}>
              <span style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 800, letterSpacing: '0.18em', color: '#fff' }}>THROTTLE</span>
              <span style={{ fontFamily: 'var(--font-display)', fontSize: 9.5, fontWeight: 600, letterSpacing: '0.34em', color: 'var(--yellow)', marginTop: 5 }}>BRAND OS</span>
            </span>
          </div>
          <div>
            <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 'clamp(32px, 4vw, 52px)', lineHeight: 0.98,
              color: '#fff', margin: 0, letterSpacing: '0.005em', maxWidth: 520 }}>OWN THE NIGHT.<br/>SHIP THE WORK.</h1>
            <p style={{ fontFamily: 'var(--font-ui)', fontSize: 15, color: 'rgba(255,255,255,0.78)', margin: '18px 0 0', maxWidth: 440, lineHeight: 1.55 }}>
              The operating system for the Legend of Toys brand team. Every request, every deliverable, every sprint. One place.</p>
          </div>
          <div style={{ display: 'flex', gap: 22 }}>
            {[['21', 'IN FLIGHT'], ['78%', 'SPRINT S-24'], ['4', 'DESIGNERS']].map(([v, l]) => (
              <div key={l}><div className="num" style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 24, color: 'var(--yellow)', lineHeight: 1 }}>{v}</div>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 9, fontWeight: 600, letterSpacing: '0.14em', color: 'rgba(255,255,255,0.6)', marginTop: 5 }}>{l}</div></div>
            ))}
          </div>
        </div>
      </div>

      {/* sign-in */}
      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '0 clamp(36px, 6vw, 80px)', background: 'var(--side-bg)', borderLeft: '1px solid var(--border)' }}>
        <span className="eyebrow" style={{ padding: 0, color: 'var(--yellow)' }}>Sign in</span>
        <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 26, color: 'var(--t1)', letterSpacing: '0.01em', margin: '10px 0 28px', textTransform: 'uppercase' }}>Welcome back</h2>
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div>
            <label style={label}>Work email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@legendoftoys.com" style={field} />
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 7 }}>
              <label style={{ ...label, marginBottom: 0 }}>Password</label>
              <span style={{ fontSize: 11.5, color: 'var(--t3)', cursor: 'pointer' }}>Forgot.</span>
            </div>
            <input type="password" value={pw} onChange={e => setPw(e.target.value)} placeholder="••••••••••" style={field} />
          </div>
          <button type="submit" disabled={busy} className="t-btn" style={{ marginTop: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9,
            padding: '13px', borderRadius: 'var(--r-sm)', background: 'var(--yellow)', color: '#15140b', border: 'none', cursor: 'pointer',
            fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 13, letterSpacing: '0.08em', textTransform: 'uppercase', opacity: busy ? 0.7 : 1,
            boxShadow: '0 8px 24px -10px rgba(242,205,26,0.6)' }}>
            {busy ? 'Entering…' : <>Enter Throttle <Icon name="chevronRight" size={16} /></>}</button>
        </form>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '26px 0' }}>
          <span style={{ flex: 1, height: 1, background: 'var(--border)' }} /><span style={{ fontSize: 11, color: 'var(--t4)' }}>or</span><span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
        </div>
        <button onClick={submit} disabled={busy} className="t-btn" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, padding: '12px',
          borderRadius: 'var(--r-sm)', background: 'transparent', border: '1px solid var(--border-2)', color: 'var(--t1)', cursor: 'pointer',
          fontFamily: 'var(--font-ui)', fontWeight: 600, fontSize: 13.5 }}>
          <Icon name="users" size={16} style={{ color: 'var(--t3)' }} />Continue with Google Workspace</button>
        {error && <p style={{ fontSize: 12, color: 'var(--bad-fg)', margin: '14px 0 0' }}>{error}</p>}
        <p style={{ fontSize: 12, color: 'var(--t4)', margin: '32px 0 0', lineHeight: 1.5 }}>
          legendoftoys.com · Bengaluru. Brand team access only. Need an account. Ask Meera.</p>
      </div>
    </div>
  );
}
