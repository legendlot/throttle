'use client';
// Route-level error boundary. Catches any uncaught render error in a page (or the
// (auth) shell) and shows a contained card with a Try-again / Reload — instead of
// Next.js's generic full-page "Application error: a client-side exception" white screen.
// One bad value in one table must not take down the whole app. See global-error.js for
// the root-layout fallback.
import { useEffect } from 'react';

export default function Error({ error, reset }) {
  useEffect(() => { try { console.error('Odo render error:', error); } catch {} }, [error]);
  return (
    <div style={{ minHeight: '70vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      {/* OPAQUE surface, not the translucent --surface: an error card must read cleanly even
          when it lands over a half-rendered screen. */}
      <div style={{ maxWidth: 440, width: '100%', textAlign: 'center', background: 'var(--surface-solid, #15161c)',
        border: '1px solid var(--border-ctl, #2a2d35)', borderRadius: 16, padding: '32px 28px',
        boxShadow: '0 40px 90px -30px rgba(0,0,0,.9)' }}>
        <div style={{ fontSize: 30, marginBottom: 10 }}>⚠️</div>
        <div style={{ fontFamily: 'var(--cond, var(--ui, system-ui))', fontSize: 18, fontWeight: 700, color: 'var(--t1, #e8eaed)', marginBottom: 8 }}>
          Something broke on this screen
        </div>
        <div style={{ fontFamily: 'var(--ui, system-ui)', fontSize: 13, color: 'var(--t2, #9aa0aa)', lineHeight: 1.5, marginBottom: 18 }}>
          The rest of Odo is fine — this one view hit an error. Try again, or reload the page.
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <button onClick={() => reset()} style={{ fontFamily: 'var(--ui, system-ui)', fontSize: 13, fontWeight: 600,
            padding: '9px 18px', borderRadius: 8, border: 'none', cursor: 'pointer',
            background: 'var(--accent, #f5c518)', color: 'var(--accent-fg, #17140a)' }}>Try again</button>
          <button onClick={() => { try { window.location.reload(); } catch {} }} style={{ fontFamily: 'var(--ui, system-ui)', fontSize: 13, fontWeight: 600,
            padding: '9px 18px', borderRadius: 8, cursor: 'pointer',
            background: 'transparent', color: 'var(--t1, #e8eaed)', border: '1px solid var(--border-strong, #33363c)' }}>Reload</button>
        </div>
        {error?.digest && <div style={{ marginTop: 16, fontFamily: 'var(--mono, monospace)', fontSize: 10, color: 'var(--t3, #6b7280)' }}>ref: {error.digest}</div>}
      </div>
    </div>
  );
}
