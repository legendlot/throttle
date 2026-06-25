'use client';
import { useState, useEffect, useRef } from 'react';

// The cross-system launcher menu. Hardcoded list = the single source of truth.
// Podium and Manifest are intentionally NOT in this list.
const SYSTEMS = [
  { key: 'garage',   label: 'Garage',   url: 'https://garage.legendoftoys.com',   mono: 'GA', tint: '#f2cd1a' },
  { key: 'redline',  label: 'Redline',  url: 'https://redline.legendoftoys.com',  mono: 'RL', tint: '#e5484d' },
  { key: 'depot',    label: 'Depot',    url: 'https://depot.legendoftoys.com',    mono: 'DP', tint: '#3b82f6' },
  { key: 'snorkel',  label: 'Snorkel',  url: 'https://snorkel.legendoftoys.com',  mono: 'SN', tint: '#0ea5e9' },
  { key: 'ignition', label: 'Ignition', url: 'https://ignition.legendoftoys.com', mono: 'IG', tint: '#f97316' },
  { key: 'docket',   label: 'Docket',   url: 'https://docket.legendoftoys.com',   mono: 'DK', tint: '#8b5cf6' },
  { key: 'pitstop',  label: 'Pitstop',  url: 'https://pitstop.legendoftoys.com',  mono: 'PS', tint: '#10b981' },
  { key: 'odo',      label: 'Odo',      url: 'https://odo.legendoftoys.com',      mono: 'OD', tint: '#f2cd1a' },
  { key: 'throttle', label: 'Throttle', url: 'https://throttle.legendoftoys.com', mono: 'TH', tint: '#eab308' },
  { key: 'relay',    label: 'Relay',    url: 'https://relay.legendoftoys.com',    mono: 'RY', tint: '#F2CD1A' },
];

function WaffleIcon({ size = 18 }) {
  const r = size / 9;               // dot radius
  const step = (size - 2 * r) / 2;  // spacing so the 3x3 grid fits the viewBox edge-to-edge
  const positions = [0, 1, 2];
  const dots = [];
  for (const row of positions) for (const col of positions) {
    dots.push(
      <circle key={`${row}-${col}`} cx={r + col * step} cy={r + row * step} r={r} fill="currentColor" />
    );
  }
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      {dots}
    </svg>
  );
}

// Live favicon (each system serves /favicon.png) with a monogram-tint fallback.
function SysIcon({ sys, size = 40 }) {
  const [failed, setFailed] = useState(false);
  return (
    <span style={{
      width: size, height: size, borderRadius: size * 0.225, display: 'grid', placeItems: 'center',
      overflow: 'hidden', flexShrink: 0, background: failed ? sys.tint : 'transparent',
    }}>
      {failed ? (
        <span style={{
          fontFamily: 'var(--mono, var(--font-mono, monospace))', fontSize: size * 0.32, fontWeight: 700,
          color: '#16140b', letterSpacing: '0.02em',
        }}>{sys.mono}</span>
      ) : (
        <img
          src={`${sys.url}/favicon.png`}
          alt=""
          width={Math.round(size * 0.9)}
          height={Math.round(size * 0.9)}
          onError={() => setFailed(true)}
          style={{ width: size * 0.9, height: size * 0.9, objectFit: 'contain', display: 'block', borderRadius: size * 0.175 }}
        />
      )}
    </span>
  );
}

// A switchable system in the grid (the systems you are NOT currently on).
function Tile({ sys }) {
  return (
    <a
      href={sys.url}
      target="_blank"
      rel="noopener noreferrer"
      title={sys.label}
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7,
        padding: '12px 6px', borderRadius: 10, textDecoration: 'none',
        background: 'transparent', transition: 'background 120ms',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-2, rgba(255,255,255,0.05))'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
    >
      <SysIcon sys={sys} />
      <span style={{
        fontSize: 12, fontWeight: 500, color: 'var(--t2, #c7ccd4)', whiteSpace: 'nowrap',
      }}>{sys.label}</span>
    </a>
  );
}

// The current system, pinned at the top — shown, not switchable (you're already here).
function CurrentBanner({ sys }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 11, padding: '10px 11px', marginBottom: 12,
      borderRadius: 'var(--r-md, 11px)', cursor: 'default',
      background: 'var(--surface-2, rgba(255,255,255,0.05))',
      border: '1px solid var(--accent, var(--yellow, rgba(242,205,26,0.45)))',
    }}>
      <SysIcon sys={sys} size={38} />
      <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.25, minWidth: 0 }}>
        <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--t1, #fff)' }}>{sys.label}</span>
        <span style={{
          fontSize: 10, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase',
          color: 'var(--t3, #8a909a)', marginTop: 3, fontFamily: 'var(--mono, var(--font-mono, inherit))',
        }}>You're here</span>
      </span>
    </div>
  );
}

export function AppLauncher({ current }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Pin the active system at top (unselectable); the grid shows everything else.
  // If `current` isn't a listed system (e.g. Podium hosts the launcher but isn't
  // in it), there's no banner and the grid stays the full list.
  const currentSys = SYSTEMS.find((s) => s.key === current) || null;
  const others = currentSys ? SYSTEMS.filter((s) => s.key !== current) : SYSTEMS;

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
      <button
        type="button"
        aria-label="Open app launcher"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{
          width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: open ? 'var(--surface-2, rgba(255,255,255,0.06))' : 'var(--surface, transparent)',
          border: '1px solid var(--border, rgba(255,255,255,0.12))',
          borderRadius: 'var(--r-sm, 8px)',
          color: 'var(--t2, #c7ccd4)', cursor: 'pointer', flexShrink: 0,
        }}
      >
        <WaffleIcon />
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute', top: 'calc(100% + 8px)', right: 0, zIndex: 400,
            width: 300, padding: 12,
            background: 'var(--surface, var(--bg, #15171c))',
            border: '1px solid var(--border, rgba(255,255,255,0.12))',
            borderRadius: 'var(--r-lg, 14px)',
            boxShadow: 'var(--shadow-pop, 0 12px 40px rgba(0,0,0,0.45))',
          }}
        >
          {currentSys && <CurrentBanner sys={currentSys} />}
          <div style={{
            fontSize: 10.5, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase',
            color: 'var(--t3, #8a909a)', padding: '2px 4px 10px',
            fontFamily: 'var(--mono, var(--font-mono, inherit))',
          }}>Switch system</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4 }}>
            {others.map((s) => <Tile key={s.key} sys={s} />)}
          </div>
        </div>
      )}
    </div>
  );
}

export default AppLauncher;
