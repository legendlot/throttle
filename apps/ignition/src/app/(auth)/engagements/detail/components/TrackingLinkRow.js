'use client';
import { useEffect, useState } from 'react';
import { useToast } from '@throttle/ui';
import { ignitionopsGet, ignitionopsPost } from '../../../../../lib/ignitionopsFetch.js';
import { Banner } from '../../../../../components/ui/index.js';

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
      <div style={row}>
        <span style={labelStyle}>Tracking link</span>
        {canEdit ? (
          <button onClick={mint} disabled={busy} className="ig-ghost-btn" style={{ marginLeft: 'auto', height: 30, padding: '0 12px', background: 'transparent', color: 'var(--text-1)', border: '1px solid var(--border-3)', borderRadius: 'var(--r-ctl)', fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 600, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1 }}>
            {busy ? 'Creating…' : 'Create tracking link'}
          </button>
        ) : <span style={{ marginLeft: 'auto', color: 'var(--text-4)', fontSize: 14 }}>—</span>}
      </div>
    );
  }
  return (
    <div style={{ ...row, alignItems: 'baseline', flexWrap: 'wrap' }}>
      <span style={labelStyle}>Tracking link</span>
      <span style={{ flex: 1, minWidth: 0, display: 'flex', gap: 10, alignItems: 'baseline', justifyContent: 'flex-end', flexWrap: 'wrap', textAlign: 'right' }}>
        <a href={e.utm_link} target="_blank" rel="noreferrer"
          style={{ color: 'var(--accent-hi)', fontFamily: 'var(--font-mono)', fontSize: 13, wordBreak: 'break-all' }}>{e.utm_link}</a>
        <button onClick={copy} className="ig-card-action" style={{ color: copied ? 'var(--state-success-fg)' : 'var(--text-3)' }}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </span>
      {/* The link's target is frozen at mint, so correcting the deal's product leaves it
          pointing at the old one. Ignition cannot repoint it — a target change moves where
          already-printed artwork sends customers, so it is audited to a named person and
          lives in Relay → Links. Say where it points, where it should, and where to go. */}
      {status?.target_stale && (
        <Banner tone="warning" lead="This link points at a different product." style={{ width: '100%', marginTop: 8, fontSize: 13, lineHeight: 1.6 }}>
          {/* ⚠️ Two different causes, and asserting the wrong one is worse than saying less.
              Every stale link today (4 of 81) stores the bare store root: it was minted while
              the deal's product was still unresolved free text, and only became "stale" when the
              product was linked afterwards. The product never changed. Say which case it is. */}
          {status.link_target && status.link_target.replace(/\/+$/, '') === 'https://www.legendoftoys.com'
            ? <>It was minted before this deal had a product linked, so it still sends people to the store home page</>
            : <>It was minted before the deal's product changed, and it still sends people</>}{' '}
          to{' '}
          <span style={{ fontFamily: 'var(--font-mono)', wordBreak: 'break-all', color: 'var(--text-1)' }}>{status.link_target}</span>{' '}
          instead of{' '}
          <span style={{ fontFamily: 'var(--font-mono)', wordBreak: 'break-all', color: 'var(--text-1)' }}>{status.resolved_target}</span>.
          <br />
          Ignition cannot repoint it — every target change is recorded against a person. Fix it in{' '}
          <a href="https://relay.legendoftoys.com/links/" target="_blank" rel="noreferrer" style={{ color: 'var(--accent-hi)' }}>Relay → Links</a>
          {status.code ? <> (search for <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-1)' }}>{status.code}</span>)</> : null}.
        </Banner>
      )}
    </div>
  );
}

// Same row shape as the card KV rows (label left, value right, hairline above).
const row = { display: 'flex', gap: 12, padding: '7px 0', alignItems: 'center', borderTop: '1px solid var(--row-divider)', fontSize: 14 };
const labelStyle = { flexShrink: 0, color: 'var(--text-3)', fontSize: 14 };
