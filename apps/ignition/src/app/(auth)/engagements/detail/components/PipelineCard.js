'use client';
import StageStepper from '../../../../../components/StageStepper.js';
import { Card } from './shared.js';

export function PipelineCard({ e, data, canApprove, doApprove, approving, locked, doUnlock, unlocking, unlockedWindow, doRelock, dataWarnings }) {
  return (
    <>
      <Card title="Pipeline">
        <StageStepper stage={e.stage} />
        {/* Reann #5 — hard approval gate. A proposed deal cannot move on until someone with
            ignition_APPROVE approves it (S313 — final approval is Reann's; his team keeps
            ignition_manage and can still create and advance deals, they just cannot sign one
            off). Rejecting (drop/ghost) stays available without approval, deliberately: you
            must be able to turn a proposal down without first approving it. */}
        {e.stage === 'proposed' && !e.approved_at && (
          <div style={{ marginTop: 12, padding: 12, background: 'var(--state-warning-bg)', border: '1px solid var(--state-warning-fg)', borderRadius: 'var(--radius-sm)', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 240, fontSize: 12, color: 'var(--text-1)', lineHeight: 1.5 }}>
              <strong>Waiting for approval.</strong> This deal cannot move past Proposed until it is
              approved. It can still be dropped or ghosted if you are turning it down.
            </div>
            {canApprove ? (
              <button onClick={doApprove} disabled={approving}
                style={{ padding: '6px 14px', background: '#27c93f', color: '#04140a', border: 'none', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', cursor: approving ? 'not-allowed' : 'pointer', opacity: approving ? 0.6 : 1 }}>
                {approving ? 'Approving…' : 'Approve'}
              </button>
            ) : (
              // Say who CAN, rather than hiding the control and leaving people guessing why a
              // deal will not move. Nothing here is a permission check — the worker is.
              <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
                Approval is with Reann
              </span>
            )}
          </div>
        )}
        {e.approved_at && (
          <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
            Approved {new Date(e.approved_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
          </div>
        )}
        {/* COMPLETE-deal lock (S373). Terms freeze once the deal is Complete; metrics stay open so
            clearing one (which un-Completes the deal) is the other way back in. */}
        {locked && (
          <div style={{ marginTop: 12, padding: 12, background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-sm)', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 240, fontSize: 12, color: 'var(--text-1)', lineHeight: 1.5 }}>
              🔒 <strong>This deal is complete and locked.</strong> Metrics stay editable.
            </div>
            {canApprove ? (
              <button onClick={doUnlock} disabled={unlocking}
                style={{ padding: '6px 14px', background: 'var(--surface-3)', color: 'var(--text-1)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', cursor: unlocking ? 'not-allowed' : 'pointer', opacity: unlocking ? 0.6 : 1 }}>
                {unlocking ? 'Unlocking…' : 'Unlock for edit'}
              </button>
            ) : (
              <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
                Unlocking is with Reann
              </span>
            )}
          </div>
        )}
        {unlockedWindow && (
          <div style={{ marginTop: 12, padding: 12, background: 'var(--state-warning-bg)', border: '1px solid var(--state-warning-fg)', borderRadius: 'var(--radius-sm)', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 240, fontSize: 12, color: 'var(--text-1)', lineHeight: 1.5 }}>
              <strong>Unlocked</strong>{data.unlocked_by_name ? <> by {data.unlocked_by_name}</> : null} until{' '}
              {new Date(e.unlocked_until).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST.
            </div>
            {canApprove && (
              <button onClick={doRelock} disabled={unlocking}
                style={{ padding: '6px 14px', background: 'var(--surface-3)', color: 'var(--text-1)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', cursor: unlocking ? 'not-allowed' : 'pointer', opacity: unlocking ? 0.6 : 1 }}>
                {unlocking ? 'Locking…' : 'Lock again'}
              </button>
            )}
          </div>
        )}
      </Card>

      {dataWarnings.length > 0 && (
        <div style={{ padding: 12, background: 'var(--state-warning-bg)', border: '1px solid var(--state-warning-fg)', borderRadius: 'var(--radius-sm)', fontSize: 12, color: 'var(--text-1)', lineHeight: 1.5 }}>
          <strong>Missing {dataWarnings.join(' and ')}.</strong> This video is live and has no{' '}
          {dataWarnings.map(w => w.toLowerCase()).join(' and no ')} recorded — CPM and cost-per-video
          cannot be worked out until {dataWarnings.length > 1 ? 'they are' : 'it is'} filled in.
          {' '}Fill {[
            dataWarnings.includes('Cost') ? 'costs in the Costs card' : null,
            dataWarnings.includes('Views') ? 'views in the Performance card' : null,
          ].filter(Boolean).join(', and ')}.
        </div>
      )}
    </>
  );
}
