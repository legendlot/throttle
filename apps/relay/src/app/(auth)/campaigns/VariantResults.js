'use client';
// A/B results (S272 UI) — the main deliverable. Sibling of VariantSetup.js / VariantProgress.js,
// same governing constraint: the team reads this without Claude, so every number that drives a
// decision is on screen in plain English, and refusing to call a winner must never LOOK like an
// error — see commsops-worker/src/ab-stats.js's verdict() for why each state exists.
import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, XCircle, AlertTriangle, Info, Clock } from 'lucide-react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch, getValidSession } from '@throttle/db';
import { useToast } from '@throttle/ui';
import { Panel, Badge, Btn, FieldLabel } from '@/components/ui.js';
import { TONES, inr, fmtDateTime } from '@/components/format.js';
import { useVariantStats, mergeVariantArms } from './useVariantStats.js';

// Mirrors verdict.state → { label, tone } from ab-stats.js's verdict(). 'winner' is the only
// green state and 'asymmetric_failures' is the only red one — every other state is a REFUSAL to
// call a winner, which is a correct outcome, not a failure, so it is never colored red.
const STATE_META = {
  winner:               { label: 'Winner', tone: 'green' },
  asymmetric_failures:  { label: 'Result is biased — do not act on it', tone: 'red' },
  immature:             { label: 'Still maturing', tone: 'yellow' },
  underpowered:         { label: 'Underpowered — treat as equal', tone: 'yellow' },
  too_many_arms:        { label: 'Too many versions to compare', tone: 'yellow' },
  too_close:            { label: 'No real difference', tone: 'gray' },
  not_a_test:           { label: 'Not a test', tone: 'gray' },
};
const ICON_FOR_TONE = { green: CheckCircle2, red: XCircle, yellow: AlertTriangle, gray: Info };

const fmtPct = (v) => (v == null ? '—' : `${(Number(v) * 100).toFixed(1)}%`);
const fmtWhen = (iso) => (iso
  ? new Date(iso).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true,
    })
  : null);

function VerdictBanner({ verdict }) {
  const meta = STATE_META[verdict.state] || { label: verdict.state, tone: 'gray' };
  const t = TONES[meta.tone] || TONES.gray;
  const Icon = ICON_FOR_TONE[meta.tone] || Info;
  return (
    <div className="info-bar" style={{ background: t.bg, borderColor: t.bd, marginBottom: 12 }}>
      <Icon size={18} style={{ color: t.fg, flexShrink: 0, marginTop: 1 }} />
      <div>
        <div style={{ fontWeight: 700, color: t.fg, marginBottom: 3, fontSize: 13.5 }}>
          {meta.label}{verdict.winner ? ` — ${verdict.winner}` : ''}
        </div>
        {/* verdict.reason is written for a marketer, verbatim — do not paraphrase it. */}
        <div style={{ color: 'var(--t1)', fontSize: 13.5, lineHeight: 1.5 }}>{verdict.reason}</div>
      </div>
    </div>
  );
}

function ArmCard({ arm, isWinner }) {
  const reasonEntries = Object.entries(arm.failReasons || {});
  return (
    <div style={{
      border: `1px solid ${isWinner ? 'var(--green-bd, rgba(52,211,153,.34))' : 'var(--border)'}`,
      borderRadius: 10, padding: 14, flex: '1 1 280px', minWidth: 260,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Badge label={arm.label} tone={arm.label === 'A' ? 'blue' : 'orange'} />
        {isWinner && <Badge label="winner" tone="green" dot />}
      </div>

      {/* Funnel: assigned → sent → delivered → read */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: 'var(--t3)', flexWrap: 'wrap' }}>
        <span>{arm.assigned.toLocaleString('en-IN')} assigned</span>
        <span className="dim">→</span>
        <span>{arm.sent.toLocaleString('en-IN')} sent</span>
        <span className="dim">→</span>
        <span>{arm.delivered.toLocaleString('en-IN')} delivered</span>
        <span className="dim">→</span>
        <span>{arm.read.toLocaleString('en-IN')} read</span>
      </div>

      {/* PRIMARY metric — read ÷ SENT (intention-to-treat). Kept visually dominant (large, bold,
          colored) over the diagnostic read ÷ delivered figure below it, so a reader cannot
          mistake the small muted number for the headline one. */}
      <div style={{ marginTop: 14 }}>
        <div style={{ fontSize: 34, fontWeight: 700, lineHeight: 1, color: isWinner ? 'var(--green, #34d399)' : 'var(--t1)' }}>
          {fmtPct(arm.readRate)}
        </div>
        <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 4, lineHeight: 1.5 }}>
          read ÷ <strong>sent</strong> — the headline number. Recipients can switch read receipts
          off, so this is a floor, not the true percentage who read it.
        </div>
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--t4)' }}>
          {fmtPct(arm.readRateOfDelivered)} read ÷ delivered <em>— diagnostic, not the headline number</em>
        </div>
      </div>

      {/* Failures and skips, pre-send vs post-send — pre-send is what biases a result. */}
      <div style={{ marginTop: 14, fontSize: 12, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
        <div style={{ color: arm.preSendFailed > 0 ? 'var(--red, #f87171)' : 'var(--t3)' }}>
          {arm.preSendFailed.toLocaleString('en-IN')} pre-send failure(s) — never entered "sent"; biases the result
        </div>
        <div style={{ color: 'var(--t3)', marginTop: 3 }}>
          {arm.providerFailed.toLocaleString('en-IN')} post-send / provider failure(s) — part of the effect, not a bias
        </div>
        <div style={{ color: 'var(--t3)', marginTop: 3 }}>
          {arm.skipped.toLocaleString('en-IN')} skipped (gate-blocked)
        </div>
        {reasonEntries.length > 0 && (
          <div style={{ marginTop: 6, color: 'var(--t4)' }}>
            By reason: {reasonEntries.map(([k, v]) => `${k}: ${v}`).join(' · ')}
          </div>
        )}
      </div>

      <div style={{ marginTop: 10, fontSize: 12, color: 'var(--t3)' }}>
        Cost: <strong style={{ color: 'var(--t1)' }}>{inr(arm.cost)}</strong>
      </div>
    </div>
  );
}

export default function VariantResults({ campaign, perms, onChanged }) {
  const { userId } = useAuth();
  const { showToast } = useToast();
  const campaignId = campaign?.id || null;
  const canBuild = !perms || perms.campaign_build;

  const { stats, loading, error } = useVariantStats(campaignId);
  const [experiment, setExperiment] = useState(null);
  const [learningText, setLearningText] = useState('');
  const [savingLearning, setSavingLearning] = useState(false);
  const [reopenLearning, setReopenLearning] = useState(false);

  // Same experiment metadata VariantSetup already loads (hypothesis / planned_read_at / learning
  // / verdict_snapshot) — fetched again here rather than threaded down as a prop, so this panel
  // stays a self-contained sibling and page.js stays imports-and-mounts only.
  const loadExperiment = useCallback(async () => {
    if (!campaignId) return;
    try {
      const session = await getValidSession();
      if (!session) return;
      const vr = await garageFetch('getCampaignVariants', { id: campaignId }, session);
      setExperiment(vr?.experiment || null);
    } catch { /* non-fatal — the verdict banner above still works without it */ }
  }, [campaignId]);

  useEffect(() => {
    if (!userId || !campaignId) return;
    loadExperiment();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, campaignId]);

  if (!campaignId) return null;
  if (loading && !stats) return null;      // avoid flashing a wrong state before first load
  if (error && !stats) {
    return <Panel title="A/B results" pad><div className="tw-note" style={{ margin: 0 }}>{error}</div></Panel>;
  }

  const arms = mergeVariantArms(stats);
  // Zero variants = a normal, never-A/B-tested campaign (all 12 existing campaigns, today). Render
  // nothing — not an empty state, not a refusal banner — so nobody reads a claim that a test ran.
  if (arms.length === 0) return null;

  const verdict = stats.verdict || { state: 'not_a_test', reason: '', arms: [] };
  const plannedReadAt = experiment?.planned_read_at || null;
  const stillPeeking = plannedReadAt && Date.now() < new Date(plannedReadAt).getTime();

  async function saveLearning() {
    if (!learningText.trim()) return;
    setSavingLearning(true);
    try {
      const session = await getValidSession();
      await workerFetch('recordExperimentLearning', { campaignId, learning: learningText.trim() }, session);
      showToast('Learning recorded', 'success');
      setLearningText('');
      setReopenLearning(false);
      await loadExperiment();
      onChanged?.();
    } catch (e) { showToast(e.message || 'Could not record learning', 'error'); }
    finally { setSavingLearning(false); }
  }

  // Snapshot vs live divergence (#9) — the snapshot is frozen at the moment someone recorded the
  // learning; the live figures keep moving as late reads arrive (5% land after 39h). Surface any
  // disagreement rather than silently letting the two screens contradict each other.
  const snapVerdict = experiment?.verdict_snapshot?.verdict || null;
  const snapArms = Array.isArray(experiment?.verdict_snapshot?.verdict?.arms)
    ? experiment.verdict_snapshot.verdict.arms : [];
  const diverged = !!(snapVerdict && (
    snapVerdict.state !== verdict.state || (snapVerdict.winner || null) !== (verdict.winner || null)
  ));

  return (
    <>
      <Panel title="A/B results" pad
        info="The primary metric is read ÷ sent (intention-to-treat) — not read ÷ delivered. Delivery happens after the treatment is applied, so comparing read-rates only among the delivered can invent a winner. Read ÷ delivered is kept as a labelled diagnostic only.">
        <VerdictBanner verdict={verdict} />

        {stillPeeking && (
          <div className="tw-note" style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
            <Clock size={13} style={{ marginTop: 1, flexShrink: 0 }} />
            <span>
              You planned to read this at <strong>{fmtWhen(plannedReadAt)}</strong>. Checking again
              and again before then can find a &quot;winner&quot; in a coin toss — the numbers below
              are live and real, but wait for the planned time before acting on them.
            </span>
          </div>
        )}

        {verdict.deliveryDiffers && (
          <div className="info-bar" style={{ background: 'rgba(242,205,26,.07)', borderColor: 'var(--accent-bd)' }}>
            <AlertTriangle size={16} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 1 }} />
            <span>The two versions were delivered at different rates, so the delivered-based
              figures are not comparable. The headline result uses read ÷ sent and is unaffected.</span>
          </div>
        )}
        {verdict.providerFailuresDiffer && (
          <div className="info-bar" style={{ background: 'rgba(124,155,255,.07)', borderColor: 'rgba(124,155,255,.2)' }}>
            <Info size={16} style={{ color: 'var(--blue)', flexShrink: 0, marginTop: 1 }} />
            <span>One version was blocked by WhatsApp more than the other — that is part of the
              result, not a fault.</span>
          </div>
        )}

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 4 }}>
          {arms.map((a) => <ArmCard key={a.variantId || a.label} arm={a} isWinner={a.label === verdict.winner} />)}
        </div>

        <div className="tw-note" style={{ marginTop: 12, marginBottom: 0 }}>
          Two versions cost the same as one — the same number of messages are sent either way.
        </div>
      </Panel>

      <Panel title="Record what we learned" pad>
        {experiment?.decided_at && !reopenLearning ? (
          <>
            <div className="dim" style={{ fontSize: 12 }}>Recorded {fmtDateTime(experiment.decided_at)}</div>
            <div style={{ marginTop: 6, fontSize: 14, color: 'var(--t1)', whiteSpace: 'pre-wrap' }}>
              {experiment.learning || <span className="dim">(no note left)</span>}
            </div>

            {snapVerdict && (
              <div style={{ marginTop: 16 }}>
                <FieldLabel>Snapshot at decision time vs. live now</FieldLabel>
                <table className="dt">
                  <thead><tr><th>Arm</th><th className="num">Read ÷ sent (at decision)</th><th className="num">Read ÷ sent (now)</th></tr></thead>
                  <tbody>
                    {arms.map((a) => {
                      const snap = snapArms.find((s) => s.label === a.label);
                      return (
                        <tr key={a.label}>
                          <td><Badge label={a.label} tone={a.label === 'A' ? 'blue' : 'orange'} /></td>
                          <td className="num mono">{fmtPct(snap?.readRate)}</td>
                          <td className="num mono">{fmtPct(a.readRate)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {diverged && (
                  <div className="tw-note" style={{ marginTop: 8, marginBottom: 0 }}>
                    <strong>The numbers moved after we called it.</strong> At decision time the
                    result was &quot;{STATE_META[snapVerdict.state]?.label || snapVerdict.state}
                    {snapVerdict.winner ? ` — ${snapVerdict.winner}` : ''}&quot;; right now it reads
                    &quot;{STATE_META[verdict.state]?.label || verdict.state}{verdict.winner ? ` — ${verdict.winner}` : ''}&quot;.
                    Worth knowing before acting further on the earlier call.
                  </div>
                )}
              </div>
            )}

            {canBuild && (
              <div style={{ marginTop: 12 }}>
                <Btn onClick={() => setReopenLearning(true)}>Record a new learning</Btn>
              </div>
            )}
          </>
        ) : (
          canBuild && (
            <>
              <textarea className="f-inp" rows={3} value={learningText}
                onChange={(e) => setLearningText(e.target.value)}
                placeholder="What did we learn from this test? (freezes the current numbers alongside this note)" />
              <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
                <Btn kind="primary" onClick={saveLearning} disabled={savingLearning || !learningText.trim()}>
                  {savingLearning ? 'Recording…' : 'Record'}
                </Btn>
                {experiment?.decided_at && <Btn onClick={() => setReopenLearning(false)}>Cancel</Btn>}
              </div>
            </>
          )
        )}
      </Panel>
    </>
  );
}
