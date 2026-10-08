'use client';
import { useState } from 'react';
import { useToast } from '@throttle/ui';
import { ignitionopsPost } from '../../../../../lib/ignitionopsFetch.js';
import { LockedNote, Card, miniBtn } from './shared.js';

// Post-live compliance checklist (B12) + gifted-but-never-posted flag (B14).
export function ComplianceCard({ e, canManage, locked, session, onSaved }) {
  const { showToast: toast } = useToast();
  const [busy, setBusy] = useState(false);
  const postLive = e.stage === 'live';
  // Locked (S373): checklist AND the gifted flag freeze — the worker refuses both.
  const editable = canManage && !locked;
  const checks = [
    ['compliance_caption_link', 'Link in caption'],
    ['compliance_coupon_verbal', 'Coupon mentioned verbally'],
    ['compliance_car_motion', 'Car in motion 15–20s'],
  ];
  async function toggle(key, val) {
    setBusy(true);
    try { await ignitionopsPost('updateEngagement', { engagement_id: e.id, [key]: val }, session); onSaved?.(); }
    catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  }
  async function flagGifted(val) {
    if (val && !window.confirm('Mark as gifted-but-never-posted? This flags the creator do-not-ship.')) return;
    setBusy(true);
    try { await ignitionopsPost('markGiftedNoPost', { engagement_id: e.id, value: val }, session); toast(val ? 'Flagged' : 'Cleared', 'success'); onSaved?.(); }
    catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  }
  const anyFalse = checks.some(([k]) => e[k] === false);
  const allTrue = checks.every(([k]) => e[k] === true);
  return (
    <Card title="Compliance & flags">
      {locked && <LockedNote />}
      {postLive ? (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
            {checks.map(([k, label]) => (
              <label key={k} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, cursor: editable ? 'pointer' : 'default' }}>
                <input type="checkbox" disabled={!editable || busy} checked={e[k] === true} onChange={ev => toggle(k, ev.target.checked)} />
                <span style={{ color: 'var(--text-2)' }}>{label}</span>
              </label>
            ))}
          </div>
          {allTrue ? <span style={okPill}>Compliant ✓</span>
            : anyFalse ? <span style={badPill}>Non-compliant — request correction</span>
            : <span style={{ color: 'var(--text-3)', fontSize: 12 }}>Not reviewed yet</span>}
        </>
      ) : (
        <div style={{ color: 'var(--text-3)', fontSize: 13 }}>Checklist appears once the deal is live.</div>
      )}
      <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
        {e.gifted_no_post ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={badPill}>Gifted · never posted</span>
            <span style={{ fontSize: 12, color: 'var(--text-3)' }}>creator set do-not-ship</span>
            {editable && <button onClick={() => flagGifted(false)} disabled={busy} style={miniBtn}>Clear</button>}
          </div>
        ) : (
          editable && <button onClick={() => flagGifted(true)} disabled={busy} style={miniBtn}>Flag &ldquo;gifted, never posted&rdquo;</button>
        )}
      </div>
    </Card>
  );
}
const okPill = { display: 'inline-block', fontSize: 11, color: '#27c93f', border: '1px solid #27c93f', borderRadius: 'var(--radius-sm)', padding: '3px 8px', textTransform: 'uppercase', letterSpacing: '0.04em' };
const badPill = { display: 'inline-block', fontSize: 11, color: 'var(--state-error-fg)', border: '1px solid var(--state-error-fg)', borderRadius: 'var(--radius-sm)', padding: '3px 8px', textTransform: 'uppercase', letterSpacing: '0.04em' };
