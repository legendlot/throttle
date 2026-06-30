'use client';
// Ultimate fallback: catches errors in the root layout itself (which error.js cannot),
// replacing the entire document. globals.css is NOT loaded here (this replaces the root
// layout), so styles are inlined. This is the last line of defence against a white screen.
import { useEffect } from 'react';

export default function GlobalError({ error, reset }) {
  useEffect(() => { try { console.error('Odo fatal error:', error); } catch {} }, [error]);
  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#0f1115', color: '#e8eaed',
        fontFamily: 'system-ui, -apple-system, sans-serif', minHeight: '100vh',
        display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ maxWidth: 440, textAlign: 'center', padding: '32px 28px',
          background: '#15171c', border: '1px solid #2a2d35', borderRadius: 14 }}>
          <div style={{ fontSize: 30, marginBottom: 10 }}>⚠️</div>
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Odo hit an error</div>
          <div style={{ fontSize: 13, color: '#9aa0aa', lineHeight: 1.5, marginBottom: 18 }}>
            The app couldn&apos;t load. Reload to try again.
          </div>
          <button onClick={() => { try { reset(); } catch { window.location.reload(); } }}
            style={{ fontSize: 13, fontWeight: 600, padding: '9px 18px', borderRadius: 9,
              border: 'none', cursor: 'pointer', background: '#f5c518', color: '#1a1a1a' }}>Reload</button>
          {error?.digest && <div style={{ marginTop: 16, fontFamily: 'monospace', fontSize: 10, color: '#6b7280' }}>ref: {error.digest}</div>}
        </div>
      </body>
    </html>
  );
}
