'use client';
import { Card } from '../../../../../components/ui/Card.js';
import { Stepper } from '../../../../../components/ui/Stepper.js';
import { StagePill } from '../../../../../components/ui/StagePill.js';
import { Banner } from '../../../../../components/ui/Banner.js';
import { HAPPY_PATH, STAGE_LABELS } from '../../../../../lib/stages.js';

const IST = { timeZone: 'Asia/Kolkata' };
const fmtStamp = (d) => new Date(d).toLocaleString('en-IN', { ...IST, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const fmtDay = (d) => new Date(d).toLocaleDateString('en-IN', { ...IST, day: '2-digit', month: 'short' });

export function PipelineCard({ e, data, canApprove, doApprove, approving, locked, doUnlock, unlocking, unlockedWindow, doRelock, dataWarnings }) {
  const idx = HAPPY_PATH.indexOf(e.stage);
  // The date each reached step was entered — the latest history row that moved the deal INTO it
  // (history arrives newest-first). Proposed falls back to the deal's own created_at (see below).
  const reached = {};
  for (const h of data.history || []) {
    if (h.stage_to && h.stage_to !== h.stage_from && !reached[h.stage_to]) reached[h.stage_to] = h.created_at;
  }
  // Only for a deal that was CREATED at proposed (166 older deals were created straight at planning
  // and never sat in Proposed); with no create row at all, created_at is still the best date.
  const createRow = (data.history || []).find(h => h.action === 'create');
  if (!reached.proposed && e.created_at && (!createRow || createRow.stage_to === 'proposed')) reached.proposed = e.created_at;
  const steps = HAPPY_PATH.map((k, i) => ({
    key: k,
    label: STAGE_LABELS[k],
    date: idx >= 0 && i <= idx && reached[k] ? fmtDay(reached[k]) : null,
  }));
  return (
    <>
      <Card hero className="ig-up" style={{ animationDelay: '60ms' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontFamily: 'var(--font-cond)', fontSize: 17, fontWeight: 700 }}>Pipeline</span>
            {/* A stage off the happy path (Delayed / On hold / an exit) lights no node, so name it here. */}
            {idx < 0 && <StagePill stage={e.stage} />}
          </span>
          {e.approved_at && (
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-4)' }}>
              Approved {fmtStamp(e.approved_at)}{data.approved_by_name ? ` · by ${data.approved_by_name}` : ''}
            </span>
          )}
        </div>
        <div style={{ overflowX: 'auto', paddingBottom: 2 }}>
          <Stepper steps={steps} current={e.stage} style={{ minWidth: 520 }} />
        </div>
        {/* Reann #5 — hard approval gate. A proposed deal cannot move on until someone with
            ignition_APPROVE approves it (S313 — final approval is Reann's; his team keeps
            ignition_manage and can still create and advance deals, they just cannot sign one
            off). Rejecting (drop/ghost) stays available without approval, deliberately: you
            must be able to turn a proposal down without first approving it. */}
        {e.stage === 'proposed' && !e.approved_at && (
          <Banner
            tone="warning"
            style={{ marginTop: 16 }}
            lead="Waiting for approval."
            // Say who CAN, rather than hiding the control and leaving people guessing why a
            // deal will not move. Nothing here is a permission check — the worker is.
            action={canApprove ? (approving ? 'Approving…' : 'Approve') : undefined}
            onAction={doApprove}
            actionDisabled={approving}
          >
            This deal cannot move past Proposed until it is approved. It can still be dropped or
            ghosted if you are turning it down.
            {!canApprove && <span style={{ display: 'block', marginTop: 4, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-4)' }}>Approval is with Reann</span>}
          </Banner>
        )}
        {/* COMPLETE-deal lock (S373). Terms freeze once the deal is Complete; metrics stay open so
            clearing one (which un-Completes the deal) is the other way back in. */}
        {locked && (
          <Banner
            tone="info"
            icon="🔒"
            style={{ marginTop: 16 }}
            lead="This deal is complete and locked."
            action={canApprove ? (unlocking ? 'Unlocking…' : 'Unlock for edit') : undefined}
            onAction={doUnlock}
            actionDisabled={unlocking}
          >
            Metrics stay editable.
            {!canApprove && <span style={{ display: 'block', marginTop: 4, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-4)' }}>Unlocking is with Reann</span>}
          </Banner>
        )}
        {unlockedWindow && (
          <Banner
            tone="warning"
            style={{ marginTop: 16 }}
            lead="Unlocked"
            action={canApprove ? (unlocking ? 'Locking…' : 'Lock again') : undefined}
            onAction={doRelock}
            actionDisabled={unlocking}
          >
            {data.unlocked_by_name ? <>by {data.unlocked_by_name} </> : null}until{' '}
            {new Date(e.unlocked_until).toLocaleString('en-IN', IST)} IST.
          </Banner>
        )}
      </Card>

      {dataWarnings.length > 0 && (
        <Banner tone="warning" lead={`Missing ${dataWarnings.join(' and ')}.`}>
          This video is live and has no{' '}
          {dataWarnings.map(w => w.toLowerCase()).join(' and no ')} recorded — CPM and cost-per-video
          cannot be worked out until {dataWarnings.length > 1 ? 'they are' : 'it is'} filled in.
          {' '}Fill {[
            dataWarnings.includes('Cost') ? 'costs in the Costs card' : null,
            dataWarnings.includes('Views') ? 'views in the Performance card' : null,
          ].filter(Boolean).join(', and ')}.
        </Banner>
      )}
    </>
  );
}
