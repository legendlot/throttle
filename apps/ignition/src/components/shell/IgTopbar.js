'use client';
import { useEffect, useState } from 'react';
import { AppLauncher } from '@throttle/ui';
import GlobalSearch from './GlobalSearch.js';

// Pit Control top bar — replaces the shared @throttle/ui <Topbar> for Ignition only.
// Left: global search (GlobalSearch.js — influencers, deals, campaigns; ⌘/Ctrl+K). A page's own box
// stays reachable with `/` (useSearchShortcut, bound in (auth)/layout.js). The old "Search this page"
// button is gone: two search fields side by side read as one too many (typeahead plan S3).

// lastRefreshed: the RefreshContext value. Accepts a Date / epoch ms (→ "synced Ns ago") or a
// preformatted string (shown as-is, the shared Topbar's contract). null → the indicator is hidden.
function useSyncedLabel(lastRefreshed) {
  const ts = lastRefreshed instanceof Date ? lastRefreshed.getTime()
    : typeof lastRefreshed === 'number' ? lastRefreshed : null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (ts == null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ts]);
  if (typeof lastRefreshed === 'string' && lastRefreshed) return lastRefreshed;
  if (ts == null) return '';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `synced ${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `synced ${m}m ago` : `synced ${Math.round(m / 60)}h ago`;
}

export default function IgTopbar({ refreshing, lastRefreshed, showNewDeal, onNewDeal }) {
  const synced = useSyncedLabel(lastRefreshed);

  return (
    <header className="ig-topbar" style={{
      height: 72, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 18, padding: '0 32px',
      fontFamily: 'var(--font-ui)', background: 'transparent',
    }}>
      <GlobalSearch />

      <div style={{ marginLeft: 'auto', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 14 }}>
        {/* Shown only when a page actually reports a refresh. Nothing in Ignition sets the
            RefreshContext today, and a permanent "LIVE" would claim a sync that isn't happening
            (scope ruling: no fake values). */}
        {(refreshing || synced) && (
        <span className="ig-topbar-live" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-3)',
          display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }}>
          {refreshing ? (
            <span style={{ color: 'var(--accent-hi)' }}>↻ UPDATING</span>
          ) : (
            <>
              <span className="ig-live-dot" />
              {`LIVE · ${synced}`}
            </>
          )}
        </span>
        )}
        <span className="ig-launcher-wrap" style={{ width: 42, height: 42, borderRadius: 12, display: 'flex',
          alignItems: 'center', justifyContent: 'center' }}>
          <AppLauncher current="ignition" />
        </span>
        {showNewDeal && (
          <a href="/engagements/new/" className="ig-cta ig-topbar-cta"
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              onNewDeal();
            }}
            style={{
              height: 42, padding: '0 18px', display: 'flex', alignItems: 'center', gap: 6, borderRadius: 12,
              background: 'var(--accent)', color: '#0a0a0a', fontWeight: 700, fontSize: 14, whiteSpace: 'nowrap',
            }}>
            + New deal
          </a>
        )}
      </div>
    </header>
  );
}
