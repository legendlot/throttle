'use client';
import { useState } from 'react';
import { useToast } from '@throttle/ui';
import { ignitionopsPost } from '../../../../../lib/ignitionopsFetch.js';
import { Card, LockedNote } from './shared.js';

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
          {checks.map(([k, label]) => (
            <label key={k} style={{ ...row, cursor: editable ? 'pointer' : 'default' }}>
              <span style={{ color: 'var(--text-3)' }}>{label}</span>
              <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                <span style={{ fontSize: 13, color: e[k] === true ? 'var(--state-success-fg)' : e[k] === false ? 'var(--state-error-fg)' : 'var(--text-4)' }}>
                  {e[k] === true ? 'Yes' : e[k] === false ? 'No' : 'Pending'}
                </span>
                <input type="checkbox" disabled={!editable || busy} checked={e[k] === true} onChange={ev => toggle(k, ev.target.checked)}
                  style={{ accentColor: '#FF6B00', width: 16, height: 16, margin: 0 }} />
              </span>
            </label>
          ))}
          <div style={{ marginTop: 10 }}>
            {allTrue ? <span style={okPill}>Compliant ✓</span>
              : anyFalse ? <span style={badPill}>Non-compliant — request correction</span>
              : <span style={{ color: 'var(--text-4)', fontSize: 13 }}>Not reviewed yet</span>}
          </div>
        </>
      ) : (
        <div style={{ color: 'var(--text-4)', fontSize: 13 }}>Checklist appears once the deal is live.</div>
      )}
      <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
        {e.gifted_no_post ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={badPill}>Gifted · never posted</span>
            <span style={{ fontSize: 12, color: 'var(--text-4)' }}>creator set do-not-ship</span>
            {editable && <button onClick={() => flagGifted(false)} disabled={busy} className="ig-card-action" style={{ marginLeft: 'auto' }}>Clear</button>}
          </div>
        ) : (
          editable && <button onClick={() => flagGifted(true)} disabled={busy} className="ig-card-action">Flag &ldquo;gifted, never posted&rdquo;</button>
        )}
      </div>
    </Card>
  );
}
const row = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '7px 0', borderTop: '1px solid var(--row-divider)', fontSize: 14 };
const pill = { display: 'inline-block', fontSize: 12, fontWeight: 600, borderRadius: 'var(--r-deal)', padding: '4px 10px' };
const okPill = { ...pill, color: 'var(--state-success-fg)', background: 'var(--state-success-bg)' };
const badPill = { ...pill, color: 'var(--state-error-fg)', background: 'var(--state-error-bg)' };
