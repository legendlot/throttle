'use client';
import { useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, Modal, useToast } from '@throttle/ui';
import { ignitionopsGet, ignitionopsPost } from '../../../../lib/ignitionopsFetch.js';
import StageBadge from '../../../../components/StageBadge.js';
import StageStepper from '../../../../components/StageStepper.js';
import DealTypeBadge from '../../../../components/DealTypeBadge.js';
import AdvanceModal from '../../../../components/AdvanceModal.js';
import OpenPitstopButton from '../../../../components/OpenPitstopButton.js';
import ProductLinesEditor, { linesToPayload } from '../../../../components/ProductLinesEditor.js';
import { deriveMetrics, isMetricApplicable, unexplainedGaps, GAP_REASONS } from '../../../../lib/metrics.js';
import { DEAL_TYPE_VALUES, DEAL_TYPE_LABELS, PAYMENT_TERMS, PAYMENT_TERMS_LABELS } from '../../../../lib/dealTypes.js';

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
  const canManage = !!perms?.ignition_manage;

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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1200 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ color: '#FF6B00', fontWeight: 700, fontSize: 18 }}>{e.engagement_no}</span>
        <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          {inf.channel_name || inf.influencer_code || '—'}
        </h1>
        {/* Reann #4 — handle link, so the deal view can reach the channel in one click. */}
        {inf.channel_link ? (
          <a href={inf.channel_link} target="_blank" rel="noopener noreferrer"
            title={inf.channel_link}
            style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: '#FF6B00', textDecoration: 'none', borderBottom: '1px dotted #FF6B00' }}>
            {inf.channel_platform ? `${inf.channel_platform} ↗` : 'channel ↗'}
          </a>
        ) : null}
        {inf.influencer_code && (
          <a href={`/influencers/detail?id=${inf.id}`}
            style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-3)', textDecoration: 'none' }}>
            {inf.influencer_code}
          </a>
        )}
        <StageBadge stage={e.stage} size="lg" />
        <DealTypeBadge dealType={e.deal_type} />
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <BriefPreviewButton engagementId={e.id} session={session} />
          <OpenPitstopButton engagement={e} onLinked={reload} />
          <button
            onClick={() => setAdvOpen(true)}
            disabled={data.allowed_next.length === 0}
            style={{
              padding: '6px 14px', background: '#FF6B00', color: '#fff',
              border: 'none', borderRadius: 'var(--radius-sm)',
              fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700,
              letterSpacing: '0.06em', textTransform: 'uppercase',
              cursor: data.allowed_next.length === 0 ? 'not-allowed' : 'pointer',
              opacity: data.allowed_next.length === 0 ? 0.5 : 1,
            }}
          >Advance →</button>
          {canManage && (
            <button
              onClick={() => setDelOpen(true)}
              style={{
                padding: '6px 14px', background: 'transparent', color: 'var(--state-error-fg)',
                border: '1px solid var(--state-error-fg)', borderRadius: 'var(--radius-sm)',
                fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700,
                letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer',
              }}
            >Delete</button>
          )}
        </div>
      </div>

      <Card title="Pipeline">
        <StageStepper stage={e.stage} />
        {/* Reann #5 — hard approval gate. A proposed deal cannot move on until someone with
            ignition_manage approves it; rejecting (drop/ghost) stays available without approval. */}
        {e.stage === 'proposed' && !e.approved_at && (
          <div style={{ marginTop: 12, padding: 12, background: 'var(--state-warning-bg)', border: '1px solid var(--state-warning-fg)', borderRadius: 'var(--radius-sm)', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 240, fontSize: 12, color: 'var(--text-1)', lineHeight: 1.5 }}>
              <strong>Waiting for approval.</strong> This deal cannot move past Proposed until it is
              approved. It can still be dropped or ghosted if you are turning it down.
            </div>
            {canManage && (
              <button onClick={doApprove} disabled={approving}
                style={{ padding: '6px 14px', background: '#27c93f', color: '#04140a', border: 'none', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', cursor: approving ? 'not-allowed' : 'pointer', opacity: approving ? 0.6 : 1 }}>
                {approving ? 'Approving…' : 'Approve'}
              </button>
            )}
          </div>
        )}
        {e.approved_at && (
          <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
            Approved {new Date(e.approved_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
          </div>
        )}
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
        <DealTermsCard e={e} paidTotal={data.paid_total} canEdit={canManage} session={session} onSaved={reload} />

        <ProductsCard
          products={data.products || []}
          directedTo={e.directed_to}
          engagementId={e.id}
          canEdit={canManage}
          session={session}
          onSaved={reload}
        />

        <Card title="POC">
          <KV label="Assigned to" value={e.poc_name || '—'} />
        </Card>

        <CostsCard e={e} canEdit={canManage} session={session} onSaved={reload} />

        <Card title="Logistics">
          <KV label="Shipping order" value={e.shipping_order_id || '—'} />
          <KV label="Tracking" value={e.tracking_id || '—'} />
          <KV label="Shipping date" value={e.shipping_date || '—'} />
          <KV label="Delivered" value={e.delivered_date || '—'} />
          {e.cs_ticket_no && <KV label="Pitstop ticket" value={<span style={{ color: 'var(--state-error-fg)' }}>{e.cs_ticket_no}</span>} />}
        </Card>

        <PostLiveCard e={e} canEdit={canManage} session={session} onSaved={reload} />

        <PerformanceCard
          e={e}
          canEdit={!!perms?.ignition_manage && e.stage === 'live'}
          session={session}
          onSaved={reload}
          platform={inf?.channel_platform}
          gapReasons={catalogs?.metric_gap_reasons}
        />

        <ComplianceCard e={e} canManage={canManage} session={session} onSaved={reload} />
      </div>

      <CodesCard engagementId={e.id} canManage={canManage} session={session} />

      <Card title="Notes">
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <input
            value={note} onChange={(ev) => setNote(ev.target.value)}
            placeholder="Add a note…"
            onKeyDown={(ev) => { if (ev.key === 'Enter') addNote(); }}
            style={{
              flex: 1, background: 'var(--surface-2)', color: 'var(--text-1)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
              padding: '8px 10px', fontFamily: 'var(--font-mono)', fontSize: 13,
            }}
          />
          <button onClick={addNote} style={{
            padding: '8px 14px', background: 'var(--surface-3)', color: 'var(--text-1)',
            border: '1px solid var(--border-2)', borderRadius: 'var(--radius-sm)',
            fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer',
          }}>Add</button>
        </div>
        {data.notes.length === 0 ? <div style={{ color: 'var(--text-3)' }}>No notes yet.</div> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {data.notes.map(n => (
              <div key={n.id} style={{ padding: '8px 10px', background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 4 }}>
                  {new Date(n.created_at).toLocaleString()}
                </div>
                <div style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{n.body}</div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="History">
        {data.history.length === 0 ? <div style={{ color: 'var(--text-3)' }}>No history yet.</div> : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead><tr style={{ background: 'var(--surface-2)' }}>
              <th style={th}>When</th><th style={th}>Action</th><th style={th}>From</th><th style={th}>To</th><th style={th}>Note</th>
            </tr></thead>
            <tbody>
              {data.history.map(h => (
                <tr key={h.id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={td}>{new Date(h.created_at).toLocaleString()}</td>
                  <td style={td}>{h.action}</td>
                  <td style={td}>{h.stage_from || '—'}</td>
                  <td style={td}>{h.stage_to || '—'}</td>
                  <td style={td}>{h.note || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

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

// Multi-product lines (#4) with inline edit → setEngagementProducts (replace-set,
// rolls cost up on the worker). Legacy single-product deals show a synthesized line.
function ProductsCard({ products, directedTo, engagementId, canEdit, session, onSaved }) {
  const { showToast: toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [lines, setLines] = useState([]);
  const [busy, setBusy] = useState(false);

  function startEdit() {
    setLines((products || []).map(p => ({
      product_code: p.product_code || '',
      // Carry the real reference + COGS snapshot through the editor — omitting them
      // here meant every edit-save silently wiped product_ref/cogs_inr on rows that
      // had them (linesToPayload nulls what the line object lacks).
      product_ref: p.product_ref || null,
      cogs_inr: p.cogs_inr ?? null,
      product_variant: p.product_variant || '',
      quantity: p.quantity ?? 1,
      goodies_cost: p.goodies_cost ?? '',
      shipping_cost: p.shipping_cost ?? '',
    })));
    setEditing(true);
  }
  async function save() {
    setBusy(true);
    try {
      await ignitionopsPost('setEngagementProducts', { engagement_id: engagementId, products: linesToPayload(lines) }, session);
      toast('Products updated', 'success');
      setEditing(false);
      onSaved?.();
    } catch (err) { toast(err.message, 'error'); }
    finally { setBusy(false); }
  }

  return (
    <section style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ fontSize: 12, color: 'var(--text-3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Products</h2>
        {canEdit && !editing && (
          <button onClick={startEdit} style={{ padding: '4px 10px', background: 'var(--surface-3)', color: 'var(--text-1)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer' }}>Edit</button>
        )}
      </div>
      {editing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <ProductLinesEditor value={lines} onChange={setLines} session={session} />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setEditing(false)} style={{ padding: '6px 12px', background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer' }}>Cancel</button>
            <button onClick={save} disabled={busy} style={{ padding: '6px 12px', background: '#FF6B00', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1 }}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      ) : (
        <>
          {(products || []).length === 0 ? (
            <div style={{ color: 'var(--text-3)', fontSize: 13 }}>No products.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {products.map((p, i) => (
                <div key={p.id || i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 13 }}>
                  <span style={{ color: 'var(--text-1)', fontWeight: 600 }}>{p.product_code || '—'}</span>
                  {p.product_variant && <span style={{ color: 'var(--text-2)' }}>{p.product_variant}</span>}
                  {Number(p.quantity) > 1 && <span style={{ color: 'var(--text-3)' }}>×{p.quantity}</span>}
                  <span style={{ marginLeft: 'auto', color: 'var(--text-3)', display: 'flex', gap: 10 }}>
                    {p.goodies_cost != null && <span title="Goodies">🎁 ₹{Number(p.goodies_cost).toLocaleString()}</span>}
                    {p.shipping_cost != null && <span title="Shipping">🚚 ₹{Number(p.shipping_cost).toLocaleString()}</span>}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
            <KV label="Directed to" value={directedTo || '—'} />
          </div>
        </>
      )}
    </section>
  );
}

// Costs card. Goodies + shipping roll up from the product lines (edit those in the
// Products card); return cost + ad spend are engagement-level and editable here (⑦).
// Deal Terms — editable since S309 (Reann, #bugs 2026-08-18 batch, items 2 + 3).
//
// Both gaps were UI-only; the worker already accepted every field here. `deal_type`,
// `payment_terms`, `payment_amount`, `affiliate_pct`, `commission_amount` AND
// `campaign_id` are all in ENGAGEMENT_FIELDS, so this saves in ONE updateEngagement
// call rather than a PATCH plus a separate assignEngagementToCampaign. That also
// matters for correctness, not just tidiness: updateEngagement calls recomputeCpm,
// and payment_amount feeds total_cost feeds CPM. Assigning the campaign through the
// dedicated endpoint would skip that.
//
// Campaign could always be set at deal CREATION, and removed/added from the campaign
// side at /campaigns/detail — but never from the deal itself, which is where Reann
// works. 295 of 335 deals carried no campaign when this shipped (measured 2026-08-25).
function DealTermsCard({ e, paidTotal, canEdit, session, onSaved }) {
  const { showToast: toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [campaigns, setCampaigns] = useState([]);
  const [f, setF] = useState({});

  // The picker's list loads ONLY when the card is opened for editing — the read view
  // does not need it, because getEngagement embeds `campaign:campaign_id(id,name)`.
  // Without that embed this would show "—" on every deal that HAS a campaign until
  // someone pressed Edit.
  useEffect(() => {
    if (!editing || !session) return;
    ignitionopsGet('getCampaigns', { status: 'active' }, session)
      .then(r => setCampaigns(r.campaigns || []))
      .catch(() => setCampaigns([]));
  }, [editing, session]);

  const campaignName = e.campaign?.name || campaigns.find(c => c.id === e.campaign_id)?.name || null;

  function startEdit() {
    setF({
      deal_type: e.deal_type || 'paid',
      // NOT defaulted to 'n_a'. payment_terms is NULL on 238 of 335 deals (measured
      // 2026-08-25) and NULL means "never recorded", which is not the same statement
      // as "N/A". Defaulting here would stamp a definite N_A onto every one of those
      // the first time someone opened this card to change something else entirely.
      payment_terms: e.payment_terms || '',
      payment_amount: e.payment_amount ?? '',
      affiliate_pct: e.affiliate_pct ?? '',
      commission_amount: e.commission_amount ?? '',
      campaign_id: e.campaign_id || '',
    });
    setEditing(true);
  }
  async function save() {
    setBusy(true);
    try {
      const numOrNull = (v) => (v === '' || v == null ? null : Number(v));
      await ignitionopsPost('updateEngagement', {
        engagement_id: e.id,
        deal_type: f.deal_type,
        payment_terms: f.payment_terms || null,
        payment_amount: numOrNull(f.payment_amount),
        affiliate_pct: numOrNull(f.affiliate_pct),
        commission_amount: numOrNull(f.commission_amount),
        // '' means "no campaign" — send null so the worker detaches rather than
        // failing the FK on an empty string.
        campaign_id: f.campaign_id || null,
      }, session);
      toast('Deal terms updated', 'success');
      setEditing(false);
      onSaved?.();
    } catch (err) { toast(err.message, 'error'); }
    finally { setBusy(false); }
  }

  const agreed = Number(e.payment_amount || 0);
  const paid = Number(paidTotal || 0);
  const done = agreed > 0 && paid >= agreed;

  return (
    <section style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ fontSize: 12, color: 'var(--text-3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Deal Terms</h2>
        {canEdit && !editing && (
          <button onClick={startEdit} style={{ padding: '4px 10px', background: 'var(--surface-3)', color: 'var(--text-1)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer' }}>Edit</button>
        )}
      </div>

      {/* Engagement type stays read-only: video vs UGC drives a different pipeline
          (ugc_briefs, the /ugc board), so flipping it here would strand a deal. */}
      <KV label="Type" value={e.engagement_type === 'ugc' ? 'UGC' : 'Video'} />

      {editing ? (
        <>
          <SelectEdit label="Deal type" value={f.deal_type} onChange={v => setF(x => ({ ...x, deal_type: v }))}
            options={DEAL_TYPE_VALUES.map(v => ({ value: v, label: DEAL_TYPE_LABELS[v] }))} />
          <SelectEdit label="Payment terms" value={f.payment_terms} onChange={v => setF(x => ({ ...x, payment_terms: v }))}
            options={[{ value: '', label: '— Not set —' }, ...PAYMENT_TERMS.map(v => ({ value: v, label: PAYMENT_TERMS_LABELS[v] }))]} />
          <CostEdit label="Payment ₹" value={f.payment_amount} onChange={v => setF(x => ({ ...x, payment_amount: v }))} />
          <CostEdit label="Affiliate %" value={f.affiliate_pct} onChange={v => setF(x => ({ ...x, affiliate_pct: v }))} />
          <CostEdit label="Commission ₹" value={f.commission_amount} onChange={v => setF(x => ({ ...x, commission_amount: v }))} />
          <SelectEdit label="Campaign" value={f.campaign_id} onChange={v => setF(x => ({ ...x, campaign_id: v }))}
            options={[{ value: '', label: '— No campaign —' }, ...campaigns.map(c => ({ value: c.id, label: c.name }))]} />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
            <button onClick={() => setEditing(false)} style={{ padding: '6px 12px', background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer' }}>Cancel</button>
            <button onClick={save} disabled={busy} style={{ padding: '6px 12px', background: '#FF6B00', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1 }}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </>
      ) : (
        <>
          <KV label="Deal type" value={DEAL_TYPE_LABELS[e.deal_type] || e.deal_type} />
          <KV label="Payment terms" value={PAYMENT_TERMS_LABELS[e.payment_terms] || e.payment_terms || '—'} />
          <KV label="Payment amount" value={`₹${agreed.toLocaleString()}`} />
          <KV label="Paid" value={
            <span style={{ color: done ? '#27c93f' : paid > 0 ? '#F2CD1A' : 'var(--text-3)', fontWeight: 600 }}>
              ₹{paid.toLocaleString()} of ₹{agreed.toLocaleString()}{done ? ' ✓' : ''}
            </span>
          } />
          {e.affiliate_pct != null && <KV label="Affiliate %" value={`${e.affiliate_pct}%`} />}
          {e.commission_amount != null && <KV label="Commission" value={`₹${Number(e.commission_amount).toLocaleString()}`} />}
          <KV label="Campaign" value={campaignName || <span style={{ color: 'var(--text-3)' }}>—</span>} />
        </>
      )}
    </section>
  );
}

function SelectEdit({ label, value, onChange, options }) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '3px 0', alignItems: 'center' }}>
      <span style={{ width: 130, color: 'var(--text-3)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</span>
      <select value={value} onChange={ev => onChange(ev.target.value)}
        style={{ flex: 1, background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '6px 9px', fontFamily: 'var(--font-mono)', fontSize: 13, width: '100%', boxSizing: 'border-box' }}>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

function CostsCard({ e, canEdit, session, onSaved }) {
  const { showToast: toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ret, setRet] = useState('');
  const [ad, setAd] = useState('');

  function startEdit() {
    setRet(e.return_cost ?? '');
    setAd(e.ad_spend ?? '');
    setEditing(true);
  }
  async function save() {
    setBusy(true);
    try {
      const numOrNull = (v) => (v === '' || v == null ? null : Number(v));
      await ignitionopsPost('updateEngagement', {
        engagement_id: e.id,
        return_cost: numOrNull(ret),
        ad_spend: numOrNull(ad),
      }, session);
      toast('Costs updated', 'success');
      setEditing(false);
      onSaved?.();
    } catch (err) { toast(err.message, 'error'); }
    finally { setBusy(false); }
  }

  const cpm = e.cpm;
  return (
    <section style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ fontSize: 12, color: 'var(--text-3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Costs</h2>
        {canEdit && !editing && (
          <button onClick={startEdit} style={{ padding: '4px 10px', background: 'var(--surface-3)', color: 'var(--text-1)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer' }}>Edit</button>
        )}
      </div>
      <KV label="Goodies" value={`₹${Number(e.goodies_cost || 0).toLocaleString()}`} />
      <KV label="Shipping" value={`₹${Number(e.shipping_cost || 0).toLocaleString()}`} />
      {editing ? (
        <>
          <CostEdit label="Return ₹" value={ret} onChange={setRet} />
          <CostEdit label="Ad spend ₹" value={ad} onChange={setAd} />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
            <button onClick={() => setEditing(false)} style={{ padding: '6px 12px', background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer' }}>Cancel</button>
            <button onClick={save} disabled={busy} style={{ padding: '6px 12px', background: '#FF6B00', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1 }}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </>
      ) : (
        <>
          <KV label="Return" value={`₹${Number(e.return_cost || 0).toLocaleString()}`} />
          <KV label="Ad spend" value={`₹${Number(e.ad_spend || 0).toLocaleString()}`} />
          <KV label="CPM" value={cpm != null
            ? <span style={{ color: Number(cpm) > 100 ? 'var(--state-error-fg)' : 'var(--text-1)', fontWeight: Number(cpm) > 100 ? 700 : 400 }}>
                ₹{Number(cpm).toFixed(2)}{Number(cpm) > 100 ? ' ⚠ high' : ''}
              </span>
            : '—'} />
          <KV label="TOTAL" value={<strong style={{ color: '#FF6B00' }}>₹{Number(e.total_cost || 0).toLocaleString()}</strong>} />
        </>
      )}
    </section>
  );
}

function CostEdit({ label, value, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '3px 0', alignItems: 'center' }}>
      <span style={{ width: 130, color: 'var(--text-3)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</span>
      <input type="number" min="0" value={value} onChange={e => onChange(e.target.value)} placeholder="0"
        style={{ flex: 1, background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '6px 9px', fontFamily: 'var(--font-mono)', fontSize: 13, width: '100%', boxSizing: 'border-box' }} />
    </div>
  );
}

// Deal brief — DRAFT ONLY (S313). Shows exactly what would go to the creator so the wording can
// be argued with before anything is armed. There is no Send button and that is deliberate: the
// send path needs a Relay template and an influencer comms profile, neither of which exists yet.
// Copy-to-clipboard is the honest interim — Reann can paste it into her own email today.
function BriefPreviewButton({ engagementId, session }) {
  const { showToast: toast } = useToast();
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function open() {
    setBusy(true);
    try {
      const r = await ignitionopsGet('getDealBriefPreview', { engagement_id: engagementId }, session);
      setDraft(r);
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(`${draft.subject}\n\n${draft.body}`); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { toast('Could not copy — select the text and copy it manually', 'error'); }
  }

  return (
    <>
      <button onClick={open} disabled={busy} style={{ padding: '4px 10px', background: 'var(--surface-3)', color: 'var(--text-1)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 11, cursor: busy ? 'not-allowed' : 'pointer' }}>
        {busy ? 'Loading…' : 'Preview brief'}
      </button>
      {draft && (
        <Modal open onClose={() => setDraft(null)} title={`Deal brief — draft`}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ padding: 10, background: 'var(--state-warning-bg)', border: '1px solid var(--state-warning-fg)', borderRadius: 'var(--radius-sm)', fontSize: 12, lineHeight: 1.5 }}>
              <strong>This is a draft and nothing can send it yet.</strong> The wording is a starting
              point — change it to what you actually want creators to read. Copy it out to use it today.
            </div>
            {(draft.warnings || []).length > 0 && (
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: 'var(--state-error-fg)', lineHeight: 1.6 }}>
                {draft.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            )}
            <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
              To: <span style={{ color: 'var(--text-1)', fontFamily: 'var(--font-mono)' }}>{draft.to || '— no email on record —'}</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
              Subject: <span style={{ color: 'var(--text-1)' }}>{draft.subject}</span>
            </div>
            <pre style={{ margin: 0, padding: 12, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', maxHeight: 340, overflowY: 'auto' }}>{draft.body}</pre>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={copy} style={{ padding: '6px 12px', background: 'var(--surface-3)', color: copied ? '#4ade80' : 'var(--text-1)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer' }}>
                {copied ? 'Copied' : 'Copy brief'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

// The influencer's tracking link. Shown in FULL and copyable, not as an "open" affordance:
// the whole point is that someone hands this string to a creator to put in their bio. It is
// minted automatically when a deal reaches Shipped; the button covers deals that predate that
// (utm_link is null on all 335 as of 2026-08-26) and any mint that failed at the time.
function TrackingLinkRow({ e, canEdit, session, onSaved }) {
  const { showToast: toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

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
      </span>
    </div>
  );
}

// Post-live card — the actual posting date is editable so already-live deals whose
// post_date was never captured can be back-dated; getMonthlyTargets attributes a
// video's views to its post_date month, so setting it makes those views count
// toward the target (Reann #bugs 2026-07-16). Video link / UTM stay read-only here.
function PostLiveCard({ e, canEdit, session, onSaved }) {
  const { showToast: toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [postDate, setPostDate] = useState('');

  function startEdit() {
    setPostDate((e.post_date || '').slice(0, 10));
    setEditing(true);
  }
  async function save() {
    setBusy(true);
    try {
      await ignitionopsPost('updateEngagement', {
        engagement_id: e.id,
        post_date: postDate === '' ? null : postDate,
      }, session);
      toast('Posting date updated', 'success');
      setEditing(false);
      onSaved?.();
    } catch (err) { toast(err.message, 'error'); }
    finally { setBusy(false); }
  }

  return (
    <section style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ fontSize: 12, color: 'var(--text-3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Post-live</h2>
        {canEdit && !editing && (
          <button onClick={startEdit} style={{ padding: '4px 10px', background: 'var(--surface-3)', color: 'var(--text-1)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer' }}>Edit</button>
        )}
      </div>
      <KV label="Expected post" value={e.expected_post_date || '—'} />
      {editing ? (
        <div style={{ display: 'flex', gap: 8, padding: '3px 0', alignItems: 'center' }}>
          <span style={{ width: 130, color: 'var(--text-3)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Actual post</span>
          <input type="date" value={postDate} onChange={ev => setPostDate(ev.target.value)}
            style={{ flex: 1, background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '6px 9px', fontFamily: 'var(--font-mono)', fontSize: 13, width: '100%', boxSizing: 'border-box' }} />
        </div>
      ) : (
        <KV label="Actual post" value={e.post_date || '—'} />
      )}
      <KV label="Video link" value={e.video_link ? <a href={e.video_link} target="_blank" rel="noreferrer" style={{ color: '#FF6B00' }}>{e.video_link.slice(0, 40)}…</a> : '—'} />
      <TrackingLinkRow e={e} canEdit={canEdit} session={session} onSaved={onSaved} />
      {editing && (
        <>
          <div style={{ fontSize: 10, color: 'var(--text-3)', margin: '8px 0 2px', lineHeight: 1.4 }}>
            Setting the posting date counts this video's views toward that month's target.
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
            <button onClick={() => setEditing(false)} style={{ padding: '6px 12px', background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer' }}>Cancel</button>
            <button onClick={save} disabled={busy} style={{ padding: '6px 12px', background: '#FF6B00', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1 }}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </>
      )}
    </section>
  );
}

// #13 — editable performance stats once the deal is live/completed.
// Reann 2026-08-10 #1 added saves / reposts / followers_gained / follower_count_at_post.
const METRIC_FIELDS = [
  ['views', 'Views'], ['likes', 'Likes'], ['comments', 'Comments'], ['shares', 'Shares'],
  ['reposts', 'Reposts'], ['saves', 'Saves'], ['followers_gained', 'Followers gained'],
  ['follower_count_at_post', 'Followers at post date'],
  ['impressions', 'Impressions'], ['sessions', 'Sessions'], ['orders', 'Orders'],
  ['conversions_value', 'Conversions ₹'],
];

function PerformanceCard({ e, canEdit, session, onSaved, platform, gapReasons }) {
  const { showToast: toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});
  const [gaps, setGaps] = useState({});
  const [busy, setBusy] = useState(false);

  const applicable = ([k]) => isMetricApplicable(k, platform);
  const shown = METRIC_FIELDS.filter(applicable);
  const derived = deriveMetrics(e, platform);
  const unexplained = unexplainedGaps(e, platform);

  function startEdit() {
    const f = {};
    for (const [k] of shown) f[k] = e[k] ?? '';
    setForm(f); setGaps({ ...(e.metric_gaps || {}) }); setEditing(true);
  }
  async function save() {
    setBusy(true);
    try {
      const patch = { engagement_id: e.id };
      for (const [k] of shown) patch[k] = form[k] === '' ? null : Number(form[k]);
      // Only keep a reason where the value is actually blank — a reason sitting behind a real
      // number is stale the moment someone fills it in, and would keep reading as "unknown".
      const cleaned = {};
      for (const [k] of shown) if (patch[k] == null && gaps[k]) cleaned[k] = gaps[k];
      patch.metric_gaps = cleaned;
      await ignitionopsPost('updateEngagement', patch, session);
      toast('Performance updated', 'success');
      setEditing(false);
      onSaved?.();
    } catch (err) { toast(err.message, 'error'); }
    finally { setBusy(false); }
  }

  return (
    <section style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ fontSize: 12, color: 'var(--text-3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Performance</h2>
        {canEdit && !editing && (
          <button onClick={startEdit} style={{ padding: '4px 10px', background: 'var(--surface-3)', color: 'var(--text-1)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer' }}>Edit</button>
        )}
      </div>
      {editing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {shown.map(([k, label]) => (
            <div key={k} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ width: 130, color: 'var(--text-3)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</span>
              <input type="number" value={form[k]} onChange={ev => setForm(f => ({ ...f, [k]: ev.target.value }))}
                style={{ flex: 1, background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '6px 8px', fontFamily: 'var(--font-mono)', fontSize: 13 }} />
              {/* A blank number gets a "why" picker — that is what separates a real 0 from unknown. */}
              {(form[k] === '' || form[k] == null) && (
                <select value={gaps[k] || ''} onChange={ev => setGaps(g => ({ ...g, [k]: ev.target.value }))}
                  style={{ width: 150, background: 'var(--surface-2)', color: gaps[k] ? 'var(--text-1)' : 'var(--text-3)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '6px 8px', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                  <option value="">why blank?</option>
                  {(gapReasons || []).map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              )}
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
            <button onClick={() => setEditing(false)} style={{ padding: '6px 12px', background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer' }}>Cancel</button>
            <button onClick={save} disabled={busy} style={{ padding: '6px 12px', background: '#FF6B00', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1 }}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      ) : (
        <>
          {shown.map(([k, label]) => {
            const raw = e[k];
            const reason = (e.metric_gaps || {})[k];
            const isMoney = k === 'conversions_value';
            const val = (raw == null || raw === '')
              ? <span style={{ color: 'var(--text-3)', fontStyle: 'italic' }}>{reason ? (GAP_REASONS[reason] || reason) : '—'}</span>
              : (isMoney ? `₹${Number(raw).toLocaleString()}` : Number(raw).toLocaleString());
            return <KV key={k} label={label} value={val} />;
          })}
          {e.actual_roas != null && <KV label="Actual ROAS" value={Number(e.actual_roas).toFixed(2)} />}

          {/* Engagement ratios — every one divides by followers at post date. */}
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, color: 'var(--text-3)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8 }}>
              Engagement ratios
            </div>
            {derived.missingDenominator ? (
              <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.5 }}>
                Needs <strong style={{ color: 'var(--text-2)' }}>followers at post date</strong> before any
                ratio can be worked out. It is the follower count on the day this posted, not today&apos;s —
                using today&apos;s would understate a creator who has grown since. Add it above.
              </div>
            ) : (
              derived.ratios.map(r => (
                <KV key={r.key} label={r.label}
                  value={r.value == null
                    ? <span style={{ color: 'var(--text-3)', fontStyle: 'italic' }}>—</span>
                    : (r.unit === 'x' ? `${r.value}x` : `${r.value}%`)} />
              ))
            )}
          </div>

          <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, color: 'var(--text-3)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8 }}>
              Business
            </div>
            {derived.business.map(b => (
              <KV key={b.key} label={b.label}
                value={b.value == null
                  ? <span style={{ color: 'var(--text-3)', fontStyle: 'italic' }}>—</span>
                  : `₹${Number(b.value).toLocaleString()}`} />
            ))}
          </div>

          {unexplained.length > 0 && (
            <div style={{ marginTop: 12, padding: '8px 10px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontSize: 11, color: 'var(--text-3)', lineHeight: 1.5 }}>
              {unexplained.length} metric{unexplained.length > 1 ? 's' : ''} blank with no reason recorded.
              Edit and pick why, so a gap can be told apart from a genuine zero.
            </div>
          )}
        </>
      )}
    </section>
  );
}

// Coupon registry + attribution per engagement (Batch B theme ②). Gift = internal
// 100%-off own-order record; affiliate = per-video code for the audience, multi-use,
// commission accrues only while the engagement is live. Codes are created on / retired
// from Shopify; "Sync" reconciles redemptions (net of refunds) onto the deal.
function CodesCard({ engagementId, canManage, session }) {
  const { showToast: toast } = useToast();
  const [coupons, setCoupons] = useState(null);
  const [pct, setPct] = useState('');
  const [couponName, setCouponName] = useState('');   // optional affiliate vanity name (S313)
  const [busy, setBusy] = useState(false);

  function load() {
    if (!session || !engagementId) return;
    ignitionopsGet('getCouponsForEngagement', { engagement_id: engagementId }, session)
      .then(r => setCoupons(r.coupons || [])).catch(() => setCoupons([]));
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [engagementId, session]);

  async function issue(kind) {
    setBusy(true);
    try {
      const body = { engagement_id: engagementId, kind };
      if (kind === 'affiliate') {
        const p = Number(pct);
        if (!p || p <= 0 || p > 100) { toast('Enter a discount % (1–100)', 'error'); setBusy(false); return; }
        body.discount_pct = p;
        // Optional vanity name, AFFILIATE ONLY. The worker already accepted `code` for affiliate
        // and always ignores it for gift; nothing here ever offers it on the gift path, because a
        // guessable gift code is a 100%-off order anyone can fluke (S217). Left blank, the worker
        // mints the name as before.
        const custom = couponName.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (custom) {
          if (custom.length < 3) { toast('A code name needs at least 3 letters or digits', 'error'); setBusy(false); return; }
          body.code = custom;
        }
      }
      const res = await ignitionopsPost('issueCoupon', body, session);
      if (res.shopify === 'created') toast(`Code ${res.coupon.code} created on Shopify`, 'success');
      else toast(`Code ${res.coupon.code} reserved — Shopify pending (${res.note || 'add write_discounts'})`, 'info');
      setPct(""); setCouponName(""); load();
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  }
  async function retire(id) {
    if (!window.confirm('Retire this code? It will be deactivated on Shopify; redemption history is kept.')) return;
    try { await ignitionopsPost('retireCoupon', { coupon_code_id: id }, session); toast('Code retired', 'success'); load(); }
    catch (e) { toast(e.message, 'error'); }
  }
  async function sync(id) {
    try { const r = await ignitionopsPost('syncCouponRedemptions', { coupon_code_id: id }, session); toast(`Redemptions synced (${r.synced})`, 'success'); load(); }
    catch (e) { toast(e.message === 'shopify_not_configured' ? 'Shopify not connected' : e.message, 'error'); }
  }
  async function retry(id) {
    try {
      const r = await ignitionopsPost('retryCoupon', { coupon_code_id: id }, session);
      if (r.shopify === 'created' || r.already) toast('Code pushed live to Shopify', 'success');
      else toast(`Still pending — ${r.note || 'Shopify unavailable'}${r.scope_missing ? ' (add write_discounts)' : ''}`, 'info');
      load();
    } catch (e) { toast(e.message, 'error'); }
  }

  const gift = (coupons || []).filter(c => c.kind === 'gift');
  const aff = (coupons || []).filter(c => c.kind === 'affiliate');

  return (
    <Card title="Codes & attribution">
      {coupons == null ? <div style={{ color: 'var(--text-3)' }}>Loading…</div> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <div style={subhead}>Affiliate code — for the creator&apos;s audience</div>
            {aff.length === 0
              ? <div style={{ color: 'var(--text-3)', fontSize: 13 }}>None yet.</div>
              : aff.map(c => <CodeRow key={c.id} c={c} canManage={canManage} onRetire={retire} onSync={sync} onRetry={retry} big />)}
            {canManage && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
                <input type="number" min="1" max="100" placeholder="% off" value={pct} onChange={e => setPct(e.target.value)} style={pctInp} />
                <input value={couponName} onChange={e => setCouponName(e.target.value)}
                  placeholder="Code name (optional)" title="Letters and numbers only. Leave blank to generate one."
                  style={{ ...pctInp, width: 190, textTransform: 'uppercase' }} />
                <button onClick={() => issue('affiliate')} disabled={busy} style={issueBtn}>Issue affiliate code</button>
              </div>
            )}
          </div>
          <div>
            <div style={subhead}>Gift code — internal, places the creator&apos;s free order (100% off)</div>
            {gift.length === 0
              ? <div style={{ color: 'var(--text-3)', fontSize: 13 }}>None yet.</div>
              : gift.map(c => <CodeRow key={c.id} c={c} canManage={canManage} onRetire={retire} onSync={sync} onRetry={retry} />)}
            {canManage && <button onClick={() => issue('gift')} disabled={busy} style={{ ...issueBtn, marginTop: 8 }}>Issue gift code</button>}
          </div>
        </div>
      )}
    </Card>
  );
}

// Post-live compliance checklist (B12) + gifted-but-never-posted flag (B14).
function ComplianceCard({ e, canManage, session, onSaved }) {
  const { showToast: toast } = useToast();
  const [busy, setBusy] = useState(false);
  const postLive = e.stage === 'live';
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
      {postLive ? (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
            {checks.map(([k, label]) => (
              <label key={k} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, cursor: canManage ? 'pointer' : 'default' }}>
                <input type="checkbox" disabled={!canManage || busy} checked={e[k] === true} onChange={ev => toggle(k, ev.target.checked)} />
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
            {canManage && <button onClick={() => flagGifted(false)} disabled={busy} style={miniBtn}>Clear</button>}
          </div>
        ) : (
          canManage && <button onClick={() => flagGifted(true)} disabled={busy} style={miniBtn}>Flag &ldquo;gifted, never posted&rdquo;</button>
        )}
      </div>
    </Card>
  );
}
const okPill = { display: 'inline-block', fontSize: 11, color: '#27c93f', border: '1px solid #27c93f', borderRadius: 'var(--radius-sm)', padding: '3px 8px', textTransform: 'uppercase', letterSpacing: '0.04em' };
const badPill = { display: 'inline-block', fontSize: 11, color: 'var(--state-error-fg)', border: '1px solid var(--state-error-fg)', borderRadius: 'var(--radius-sm)', padding: '3px 8px', textTransform: 'uppercase', letterSpacing: '0.04em' };

function CodeRow({ c, canManage, onRetire, onSync, onRetry, big }) {
  const retired = c.status === 'retired';
  const pending = c.status === 'pending_shopify';
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '8px 0', borderTop: '1px solid var(--border)' }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: big ? 18 : 14, color: retired ? 'var(--text-3)' : '#FF6B00', textDecoration: retired ? 'line-through' : 'none', letterSpacing: '0.04em' }}>{c.code}</span>
      <span style={pill}>{c.discount_pct}% off</span>
      {pending && <span style={{ ...pill, color: '#F2CD1A', borderColor: '#F2CD1A' }}>Shopify pending</span>}
      {retired && <span style={{ ...pill, color: 'var(--text-3)' }}>retired</span>}
      <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
        {/* No commission figure: affiliate codes are TRACKING-ONLY (Afshaan 2026-08-26), so the
            "₹0.00 commission" this used to print was reporting a debt that does not exist.
            See reference/decisions.md before re-adding it. */}
        {c.redemptions || 0} uses · ₹{Number(c.attributed_revenue_net || 0).toLocaleString()} net
      </span>
      {canManage && !retired && (
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {pending && onRetry && (
            <button onClick={() => onRetry(c.id)} style={{ ...miniBtn, background: '#FF6B00', color: '#fff', borderColor: '#FF6B00', fontWeight: 700 }}>Push to Shopify</button>
          )}
          <button onClick={() => onSync(c.id)} style={miniBtn}>Sync</button>
          <button onClick={() => onRetire(c.id)} style={miniBtn}>Retire</button>
        </span>
      )}
    </div>
  );
}

const subhead = { fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6, fontWeight: 600 };
const pill = { fontSize: 10, color: 'var(--text-3)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '2px 6px', textTransform: 'uppercase', letterSpacing: '0.04em' };
const pctInp = { width: 90, background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '6px 9px', fontFamily: 'var(--font-mono)', fontSize: 13 };
const issueBtn = { padding: '6px 12px', background: '#FF6B00', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, cursor: 'pointer' };
const miniBtn = { padding: '4px 10px', background: 'var(--surface-2)', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer' };

function Card({ title, children }) {
  return (
    <section style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius-md)', padding: 16,
    }}>
      <h2 style={{ fontSize: 12, color: 'var(--text-3)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 12 }}>{title}</h2>
      {children}
    </section>
  );
}

function KV({ label, value }) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '3px 0' }}>
      <span style={{ width: 130, color: 'var(--text-3)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</span>
      <span style={{ color: 'var(--text-1)', fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</span>
    </div>
  );
}
const th = { padding: '6px 10px', fontSize: 11, color: 'var(--text-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600, textAlign: 'left' };
const td = { padding: '6px 10px' };
