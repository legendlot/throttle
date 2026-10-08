'use client';
import { useEffect, useState } from 'react';
import { useToast } from '@throttle/ui';
import { ignitionopsGet, ignitionopsPost } from '../../../../../lib/ignitionopsFetch.js';

// The influencer's tracking link. Shown in FULL and copyable, not as an "open" affordance:
// the whole point is that someone hands this string to a creator to put in their bio. It is
// minted automatically when a deal reaches Shipped; the button covers deals that predate that
// (utm_link is null on all 335 as of 2026-08-26) and any mint that failed at the time.
export function TrackingLinkRow({ e, canEdit, session, onSaved }) {
  const { showToast: toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState(null);   // getTrackingLinkStatus — stale-target check

  // ⚠️ The staleness check has to run ON LOAD, not off the mint call. The worker also returns
  // `target_stale` from mintTrackingLink, but that path is unreachable for exactly the deals
  // that need it: the mint button below is hidden once `utm_link` exists, so a deal whose
  // product changed AFTER minting never makes the call. A silent indicator would repeat the
  // original failure, where every path reported success while the link kept the old target.
  // Degrades to no banner on error — a check that cannot run must not blank the row.
  useEffect(() => {
    if (!session || !e.id || !e.utm_link) { setStatus(null); return; }
    let live = true;
    ignitionopsGet('getTrackingLinkStatus', { engagement_id: e.id }, session)
      .then(r => { if (live) setStatus(r); })
      .catch(() => { if (live) setStatus(null); });
    return () => { live = false; };
  }, [e.id, e.utm_link, session]);

  async function mint() {
    setBusy(true);
    try {
      const r = await ignitionopsPost('mintTrackingLink', { engagement_id: e.id }, session);
      toast(r?.already ? 'This deal already has a link' : 'Tracking link created', 'success');
      onSaved?.();
    } catch (err) { toast(err.message, 'error'); }
    finally { setBusy(false); }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(e.utm_link);
      setCopied(true); setTimeout(() => setCopied(false), 1500);
    } catch { toast('Could not copy — select the link and copy it manually', 'error'); }
  }

  if (!e.utm_link) {
    return (
      <div style={{ display: 'flex', gap: 8, padding: '3px 0', alignItems: 'center' }}>
        <span style={{ width: 130, color: 'var(--text-3)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Tracking link</span>
        {canEdit ? (
          <button onClick={mint} disabled={busy} style={{ padding: '4px 10px', background: 'var(--surface-3)', color: 'var(--text-1)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 11, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1 }}>
            {busy ? 'Creating…' : 'Create tracking link'}
          </button>
        ) : <span style={{ color: 'var(--text-3)', fontSize: 13 }}>—</span>}
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', gap: 8, padding: '3px 0', alignItems: 'baseline' }}>
      <span style={{ width: 130, flexShrink: 0, color: 'var(--text-3)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Tracking link</span>
      <span style={{ flex: 1, minWidth: 0, display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <a href={e.utm_link} target="_blank" rel="noreferrer"
          style={{ color: '#FF6B00', fontFamily: 'var(--font-mono)', fontSize: 12, wordBreak: 'break-all' }}>{e.utm_link}</a>
        <button onClick={copy} style={{ background: 'transparent', border: 'none', padding: 0, color: copied ? '#4ade80' : 'var(--text-3)', fontFamily: 'var(--font-mono)', fontSize: 11, textDecoration: 'underline', cursor: 'pointer' }}>
          {copied ? 'copied' : 'copy'}
        </button>
        {/* The link's target is frozen at mint, so correcting the deal's product leaves it
            pointing at the old one. Ignition cannot repoint it — a target change moves where
            already-printed artwork sends customers, so it is audited to a named person and
            lives in Relay → Links. Say where it points, where it should, and where to go. */}
        {status?.target_stale && (
          <span style={{ width: '100%', marginTop: 4, padding: 8, background: 'var(--state-warning-bg)', border: '1px solid var(--state-warning-fg)', borderRadius: 'var(--radius-sm)', fontSize: 11, lineHeight: 1.6, color: 'var(--text-1)' }}>
            {/* ⚠️ Two different causes, and asserting the wrong one is worse than saying less.
                Every stale link today (4 of 81) stores the bare store root: it was minted while
                the deal's product was still unresolved free text, and only became "stale" when the
                product was linked afterwards. The product never changed. Say which case it is. */}
            <strong>This link points at a different product.</strong>{' '}
            {status.link_target && status.link_target.replace(/\/+$/, '') === 'https://www.legendoftoys.com'
              ? <>It was minted before this deal had a product linked, so it still sends people to the store home page</>
              : <>It was minted before the deal's product changed, and it still sends people</>}{' '}
            to{' '}
            <span style={{ fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>{status.link_target}</span>{' '}
            instead of{' '}
            <span style={{ fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>{status.resolved_target}</span>.
            <br />
            Ignition cannot repoint it — every target change is recorded against a person. Fix it in{' '}
            <a href="https://relay.legendoftoys.com/links/" target="_blank" rel="noreferrer" style={{ color: '#FF6B00' }}>Relay → Links</a>
            {status.code ? <> (search for <span style={{ fontFamily: 'var(--font-mono)' }}>{status.code}</span>)</> : null}.
          </span>
        )}
      </span>
    </div>
  );
}
