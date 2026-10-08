'use client';
import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { AppLauncher } from '@throttle/ui';
import { isTypingTarget } from './IgRail.js';

// Pit Control top bar — replaces the shared @throttle/ui <Topbar> for Ignition only.
// The search field is NOT a command palette: Ignition has none, so clicking it (or ⌘/Ctrl+K)
// focuses the page's own [data-search-primary] input — the same target `/` focuses through
// useSearchShortcut (bound in (auth)/layout.js, unchanged). Pages without a search: no-op.

function focusPageSearch() {
  const target = typeof document !== 'undefined' && document.querySelector('[data-search-primary]');
  if (!target) return false;
  try { target.focus(); target.select?.(); } catch { /* ignore */ }
  return true;
}

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

  useEffect(() => {
    function onKey(e) {
      if (e.key !== 'k' && e.key !== 'K') return;
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      // Never pull focus out of an open modal to the page behind it, and leave Ctrl+K (macOS
      // "delete to end of line") alone while typing in a field (S412 review).
      if (document.querySelector('[aria-modal="true"]')) return;
      if (e.ctrlKey && !e.metaKey && (isTypingTarget(e.target) || isTypingTarget(document.activeElement))) return;
      if (focusPageSearch()) e.preventDefault();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Only 3 routes have a page search; on the rest the field would be a dead click. Show it only
  // while a [data-search-primary] input is on the page (pages render it after their data loads).
  const [hasSearch, setHasSearch] = useState(false);
  useEffect(() => {
    const check = () => setHasSearch(!!document.querySelector('[data-search-primary]'));
    check();
    const mo = new MutationObserver(check);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, []);

  return (
    <header className="ig-topbar" style={{
      height: 72, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 18, padding: '0 32px',
      fontFamily: 'var(--font-ui)', background: 'transparent',
    }}>
      {hasSearch ? (
      <button type="button" className="ig-topbar-search" onClick={focusPageSearch}
        title="Focus this page's search  ( / )"
        style={{
          flex: 1, minWidth: 0, maxWidth: 560, display: 'flex', alignItems: 'center', gap: 12, height: 46,
          padding: '0 16px', background: 'var(--input)', border: '1px solid var(--border-2)', borderRadius: 12,
          color: 'var(--text-3)', fontSize: 15, cursor: 'text', fontFamily: 'var(--font-ui)', textAlign: 'left',
        }}>
        <Search size={17} strokeWidth={1.75} style={{ flexShrink: 0 }} />
        <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          Search this page
        </span>
        <span className="ig-topbar-kbd" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, padding: '2px 8px',
          border: '1px solid var(--border-3)', borderRadius: 6, flexShrink: 0 }}>⌘K</span>
      </button>
      ) : <span style={{ flex: 1 }} />}

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
