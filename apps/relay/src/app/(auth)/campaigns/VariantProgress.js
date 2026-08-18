'use client';
// A/B live progress (S272 UI) — shown only while the campaign is mid-flight (sending/paused).
// Sibling of VariantSetup.js and VariantResults.js; same "no Claude in the loop" constraint —
// every number here is plain English on screen, nothing to go query for.
import { useEffect } from 'react';
import { Lock, XCircle } from 'lucide-react';
import { Panel, Badge } from '@/components/ui.js';
import { useVariantStats, mergeVariantArms } from './useVariantStats.js';

// Mirrors campaigns/page.js's own "sending" poll interval (its useEffect around
// setInterval(..., 4000)) — the SAME cadence, not a new one, so a viewer never sees this panel
// and the campaign status/lifecycle panel above it drift out of step with each other.
const POLL_MS = 4000;

export default function VariantProgress({ campaign }) {
  const isLive = campaign?.status === 'sending' || campaign?.status === 'paused';
  const campaignId = isLive ? (campaign?.id || null) : null;
  const { stats, reload } = useVariantStats(campaignId);

  useEffect(() => {
    if (!campaignId) return undefined;
    const t = setInterval(reload, POLL_MS);
    return () => clearInterval(t);
  }, [campaignId, reload]);

  if (!isLive) return null;
  const arms = mergeVariantArms(stats);
  if (arms.length < 2) return null; // not an A/B send — nothing to show mid-flight

  // ab-stats.verdict() checks pre-send-failure asymmetry BEFORE the maturity gate, so this can
  // already read 'asymmetric_failures' while the campaign is still sending — that is the whole
  // point of surfacing it here rather than only at the end.
  const asymmetric = stats?.verdict?.state === 'asymmetric_failures';

  return (
    <Panel title="Sending — live per-arm progress" pad>
      <div className="tw-note" style={{ marginTop: 0 }}>
        <Lock size={14} style={{ verticalAlign: -2, marginRight: 5 }} />
        <strong>Versions are frozen.</strong>{' '}
        {campaign.status === 'paused'
          ? 'This campaign is paused (WhatsApp blocked a template mid-send). Arms cannot be edited while some recipients have already been sent to and others have not — that would mix two different tests into one result.'
          : 'Arms cannot be edited while a send is in progress — that would mix two different tests into one result.'}
      </div>

      {asymmetric && (
        <div className="info-bar" style={{
          background: 'rgba(222,42,42,.07)', borderColor: 'var(--red-bd, rgba(222,42,42,.3))', marginBottom: 12,
        }}>
          <XCircle size={16} style={{ color: 'var(--red, #f87171)', flexShrink: 0, marginTop: 1 }} />
          <span><strong>Already lopsided.</strong> {stats.verdict.reason}</span>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {arms.map((a) => {
          const failing = a.preSendFailed + a.providerFailed;
          return (
            <div key={a.variantId || a.label} style={{
              display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap',
              border: '1px solid var(--border)', borderRadius: 8, padding: 10, fontSize: 13,
            }}>
              <Badge label={a.label} tone={a.label === 'A' ? 'blue' : 'orange'} />
              <span style={{ color: 'var(--t1)' }}>
                <strong>{a.assigned.toLocaleString('en-IN')}</strong> assigned
              </span>
              <span className="dim">·</span>
              <span style={{ color: 'var(--t1)' }}>
                <strong>{a.sent.toLocaleString('en-IN')}</strong> sent
              </span>
              <span className="dim">·</span>
              <span style={{ color: 'var(--t1)' }}>
                <strong>{a.delivered.toLocaleString('en-IN')}</strong> delivered
              </span>
              {failing > 0 && (
                <Badge dot tone={a.preSendFailed > 0 ? 'red' : 'yellow'}
                  label={`${failing.toLocaleString('en-IN')} failing${a.preSendFailed > 0 ? ' (pre-send)' : ' (post-send)'}`} />
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
