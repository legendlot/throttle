'use client';
import { useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { Modal } from '../../../../components/ui/Modal.js';
import { ignitionopsGet, ignitionopsPost } from '../../../../lib/ignitionopsFetch.js';
import AdvanceModal from '../../../../components/AdvanceModal.js';
import { liveDataWarnings, metricsCompleteness, isLocked, unlockActive } from '../../../../lib/metrics.js';
import AdsCard from '../../../../components/AdsCard.js';
import { DetailHeader } from './components/DetailHeader.js';
import { PipelineCard } from './components/PipelineCard.js';
import { ProductsCard } from './components/ProductsCard.js';
import { DealTermsCard } from './components/DealTermsCard.js';
import { CostsCard } from './components/CostsCard.js';
import { PostLiveCard } from './components/PostLiveCard.js';
import { PerformanceCard } from './components/PerformanceCard.js';
import { CodesCard } from './components/CodesCard.js';
import { ComplianceCard } from './components/ComplianceCard.js';
import { PaymentsCard } from './components/PaymentsCard.js';
import { InfluencerCard } from './components/InfluencerCard.js';
import { LogisticsCard } from './components/LogisticsCard.js';
import { NotesCard } from './components/NotesCard.js';
import { HistoryCard } from './components/HistoryCard.js';
import { Card, KV } from './components/shared.js';

export default function EngagementDetailPage() {
  const sp = useSearchParams();
  const router = useRouter();
  const id = sp.get('id');
  const eno = sp.get('engagement_no');
  const { session, perms } = useAuth();
  const { showToast: toast } = useToast();
  const [data, setData] = useState(null);
  const [catalogs, setCatalogs] = useState(null);
  const [err, setErr] = useState(null);
  const [advOpen, setAdvOpen] = useState(false);
  const [note, setNote] = useState('');
  const [delOpen, setDelOpen] = useState(false);
  const [approving, setApproving] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const canManage = !!perms?.ignition_manage;
  const canApprove = !!perms?.ignition_approve;   // S313 — final approval, admin tier only

  function reload() {
    if (!session || (!id && !eno)) return;
    const params = id ? { id } : { engagement_no: eno };
    ignitionopsGet('getEngagement', params, session).then(setData).catch(e => setErr(e.message));
  }
  useEffect(reload, [id, eno, session]);
  // Catalogs drive the metric-gap reason picklist. Served by the worker so the reason vocabulary
  // has one definition; a failure here must not blank the page, so it degrades to no picker.
  useEffect(() => {
    if (!session) return;
    ignitionopsGet('getCatalogs', {}, session).then(setCatalogs).catch(() => setCatalogs(null));
  }, [session]);

  async function doAdvance({ to_stage, note, ...extra }) {
    // Forward all extra fields (video_link / rating / shipping_order_id /
    // expected_post_date) so the AdvanceModal's guard re-tries work.
    await ignitionopsPost('advanceStage', { engagement_id: data.engagement.id, to_stage, note, ...extra }, session);
    toast(`Advanced to ${to_stage}`, 'success');
    reload();
  }

  async function doDelete() {
    try {
      const res = await ignitionopsPost('deleteEngagement', { engagement_id: data.engagement.id }, session);
      toast(`Deleted ${res.engagement_no}`, 'success');
      router.push('/engagements');
    } catch (e) {
      if (/has_payments_cannot_delete/.test(e.message)) {
        toast('Has payments — cancel/close it instead of deleting.', 'error');
      } else if (/has_ad_payments_cannot_delete/.test(e.message)) {
        toast('Has ad payments — cancel/close it instead of deleting.', 'error');
      } else {
        toast(e.message, 'error');
      }
      setDelOpen(false);
    }
  }

  async function doApprove() {
    setApproving(true);
    try {
      await ignitionopsPost('approveEngagement', { engagement_id: data.engagement.id }, session);
      toast('Approved — this deal can now move on', 'success');
      reload();
    } catch (e) { toast(e.message, 'error'); }
    finally { setApproving(false); }
  }

  // COMPLETE-deal lock (S373). Same gate as Approve (`ignition_approve`); the worker re-checks it.
  async function doUnlock() {
    const reason = window.prompt('Unlock this deal for 24 hours. Why? (optional)', '');
    if (reason === null) return;   // Cancel
    setUnlocking(true);
    try {
      await ignitionopsPost('unlockEngagement', { engagement_id: data.engagement.id, reason: reason.trim() || undefined }, session);
      toast('Unlocked for 24 hours', 'success');
      reload();
    } catch (e) { toast(e.message, 'error'); }
    finally { setUnlocking(false); }
  }
  async function doRelock() {
    setUnlocking(true);
    try {
      await ignitionopsPost('relockEngagement', { engagement_id: data.engagement.id }, session);
      toast('Locked again', 'success');
      reload();
    } catch (e) { toast(e.message, 'error'); }
    finally { setUnlocking(false); }
  }

  async function addNote() {
    if (!note.trim()) return;
    await ignitionopsPost('addNote', { engagement_id: data.engagement.id, body: note }, session);
    setNote('');
    toast('Note added', 'success');
    reload();
  }

  if (err) return <div style={{ color: 'var(--state-error-fg)', padding: 16 }}>Error: {err}</div>;
  if (!data) return <Spinner />;
  const e = data.engagement;
  const inf = e.influencer || {};
  // Reann #5 (2026-09-04) — a live video with no Cost or no Views is a data hole, flagged at the
  // top of the deal where it cannot be missed. A WARNING only: nothing here blocks anything.
  const dataWarnings = liveDataWarnings(e, inf?.channel_platform);
  // Afshaan 2026-09-04 — derived from the SAME `e` the page already holds, so a PerformanceCard
  // save (onSaved={reload} → setData) flips the pill without a page reload.
  const completeness = metricsCompleteness(e);
  // COMPLETE-deal lock (S373). The worker's `locked` (its clock, its copy of the rule) wins; the
  // local derivation is only the fallback for a response that predates the field. Either way it is
  // cosmetic — updateEngagement / setEngagementProducts / markGiftedNoPost refuse on the server.
  const locked = typeof data.locked === 'boolean' ? data.locked : isLocked(e);
  const unlockedWindow = completeness.complete && !locked && unlockActive(e);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1200 }}>
      <DetailHeader e={e} inf={inf} data={data} completeness={completeness} session={session} reload={reload} setAdvOpen={setAdvOpen} canManage={canManage} setDelOpen={setDelOpen} />

      <PipelineCard e={e} data={data} canApprove={canApprove} doApprove={doApprove} approving={approving} locked={locked} doUnlock={doUnlock} unlocking={unlocking} unlockedWindow={unlockedWindow} doRelock={doRelock} dataWarnings={dataWarnings} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
        <DealTermsCard e={e} paidTotal={data.paid_total} canEdit={canManage} locked={locked} session={session} onSaved={reload} />

        <ProductsCard
          products={data.products || []}
          directedTo={e.directed_to}
          engagementId={e.id}
          canEdit={canManage}
          locked={locked}
          session={session}
          onSaved={reload}
        />

        {/* Reann #1 (2026-08-27): "add Name, Phone Number, Location, Platform Type in the Deal
            section so that Influencers' identity can be verified within the Engagement itself."
            Every field here was already on the wire — getEngagement embeds the whole influencer
            row — it simply was not rendered, so verifying who a deal was with meant opening the
            profile in another tab. Read-only on purpose: the influencer record is edited on the
            influencer page, and two edit surfaces for one row is how they drift apart. */}
        <InfluencerCard inf={inf} />

        {/* Reann #7 (2026-08-27): "integrate the payment section into engagements itself … the
            payment screenshot should be attached to the specific influencer's engagement record
            … easily accessible when viewing that influencer's campaign details, to ensure the
            payment is actually cleared." The payments were already stored per-deal and already
            on the wire (getEngagement returns payments + paid_total) — the deal page just showed
            the total and made you go to /payments to see the proof. The separate Payments page is
            deliberately KEPT: it is the cross-deal spend view, which this card cannot be. */}
        <PaymentsCard
          payments={data.payments || []}
          paidTotal={data.paid_total}
          agreed={e.payment_amount}
          engagement={e}
          influencer={inf}
          canEdit={canManage}
          session={session}
          onSaved={reload}
        />

        <Card title="POC">
          <KV label="Assigned to" value={e.poc_name || '—'} />
        </Card>

        <CostsCard e={e} canEdit={canManage} locked={locked} session={session} onSaved={reload} />

        {/* Ads (S373) — spans the row. Deliberately NOT given `locked`: ads and ad payments stay
            editable on a Complete deal, because ads run after the video posts. */}
        <AdsCard
          engagement={e}
          videos={data.videos || []}
          ads={data.ads === undefined ? [] : data.ads}
          adPayments={data.ad_payments === undefined ? [] : data.ad_payments}
          canManage={canManage}
          canApprove={canApprove}
          session={session}
          onSaved={reload}
        />

        <LogisticsCard e={e} />

        <PostLiveCard e={e} canEdit={canManage} locked={locked} session={session} onSaved={reload} />

        <PerformanceCard
          e={e}
          videos={data.videos || []}
          ads={data.ads || []}
          canEdit={!!perms?.ignition_manage && e.stage === 'live'}
          session={session}
          onSaved={reload}
          platform={inf?.channel_platform}
          gapReasons={catalogs?.metric_gap_reasons}
        />

        <ComplianceCard e={e} canManage={canManage} locked={locked} session={session} onSaved={reload} />
      </div>

      <CodesCard engagementId={e.id} canManage={canManage} session={session} />

      <NotesCard data={data} note={note} setNote={setNote} addNote={addNote} />

      <HistoryCard data={data} />

      <AdvanceModal
        open={advOpen}
        engagement={e}
        onClose={() => setAdvOpen(false)}
        onAdvance={doAdvance}
      />

      {delOpen && (
        <Modal open title={`Delete ${e.engagement_no}?`} onClose={() => setDelOpen(false)}>
          <div style={{ minWidth: 360, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 }}>
              This permanently removes the deal and its products, notes and history.
              Deals with recorded payments can&apos;t be deleted — cancel/close them instead.
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => setDelOpen(false)} style={{ padding: '8px 14px', background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer' }}>Cancel</button>
              <button onClick={doDelete} style={{ padding: '8px 14px', background: 'var(--state-error-fg)', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>Delete deal</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
