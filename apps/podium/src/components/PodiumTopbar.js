'use client';
// Podium-local topbar (Pit Wall v2). Replaces the shared @throttle/ui Topbar for
// Podium ONLY. Left = group eyebrow + screen title (Tomorrow uppercase);
// right = "Updated h:mm" with a pulsing green live dot + the user avatar.
import { Avatar } from './ui.js';
import { AppLauncher } from '@throttle/ui';

function fmtTime(d) {
  try { return new Date(d).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }); }
  catch { return ''; }
}

export function PodiumTopbar({ crumb, title, lastRefreshed, userLabel }) {
  return (
    <div style={{
      height: 'var(--topbar-h)', flex: 'none', borderBottom: '1px solid var(--divider)',
      display: 'flex', alignItems: 'center', gap: 16, padding: '0 24px', background: 'var(--bg)',
    }}>
      <div>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 9, fontWeight: 600, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--t4)' }}>{crumb || ' '}</div>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--t1)', lineHeight: 1.1 }}>{title}</div>
      </div>
      <span style={{ flex: 1 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--t3)', fontSize: 12 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--green-bright)', animation: 'podiumPulse 2s infinite' }} />
        <span className="num">{lastRefreshed ? `Updated ${fmtTime(lastRefreshed)}` : 'Live'}</span>
      </div>
      <Avatar name={userLabel || '?'} size={32} radius={8} />
      <AppLauncher current="podium" />
    </div>
  );
}

export default PodiumTopbar;
