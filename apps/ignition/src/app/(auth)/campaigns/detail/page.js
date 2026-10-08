'use client';
import { useEffect, useState, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { Modal } from '../../../../components/ui/Modal.js';
import { Card, SectionTitle, Tile, StagePill, Row, NumCell, ProgressBar, budgetTone } from '../../../../components/ui/index.js';
import { Plus, X, ArrowLeft } from 'lucide-react';
import { supabase } from '@throttle/db';
import { ignitionopsGet, ignitionopsPost } from '../../../../lib/ignitionopsFetch.js';
import { productLabel, titleish } from '../../../../lib/productLabel.js';

function inr(n) { return n == null || isNaN(n) ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`; }
function num(n) { return n == null || isNaN(n) ? 0 : Number(n); }

export default function CampaignDetailPage() {
  const params = useSearchParams();
  const id = params.get('id');
  const { session, perms } = useAuth();
  const { showToast: toast } = useToast();
  const router = useRouter();
  const canManage = !!perms?.ignition_manage;

  const [campaign, setCampaign] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showAttach, setShowAttach] = useState(false);
  const [editing, setEditing] = useState(false);

  const load = useCallback(() => {
    if (!session || !id) return;
    setLoading(true);
    ignitionopsGet('getCampaign', { id }, session)
      .then(r => setCampaign(r.campaign))
      .catch(e => toast(e.message, 'error'))
      .finally(() => setLoading(false));
  }, [session, id]);
  useEffect(load, [load]);

  async function detach(engId) {
    try {
      await ignitionopsPost('assignEngagementToCampaign', { engagement_id: engId, campaign_id: null }, session);
      toast('Detached', 'success'); load();
    } catch (e) { toast(e.message, 'error'); }
  }

  // Never swap an open edit form for the spinner — a background reload (a real token
  // refresh re-keys any effect on `session`) must not discard unsaved input.
  if (loading && !editing) return <Spinner />;
  if (!campaign) return <div style={{ padding: 16, color: 'var(--text-3)' }}>Campaign not found.</div>;

  const r = campaign.rollup || {};
  const engs = campaign.engagements || [];
  // Budget = budget_amount, same as the Campaigns list (agreed_total is the legacy per-influencer
  // figure — never a second budget). No budget set → no bar and no "left" (null must never read as ₹0).
  const spend = num(r.spend);
  const budget = campaign.budget_amount != null ? Number(campaign.budget_amount) : null;
  const pct = budget > 0 ? (spend / budget) * 100 : null;
  const tone = pct != null ? budgetTone(pct) : 'var(--text-3)';
  const left = budget != null ? budget - spend : null;
  const influencer = campaign.influencer?.channel_name || campaign.influencer?.person_name;
  const cols = `150px 64px minmax(120px, 1fr) 130px 90px 100px 60px${canManage ? ' 32px' : ''}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <button onClick={() => router.push('/campaigns')} style={backLink}>
        <ArrowLeft size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />Campaigns
      </button>

      <header className="ig-up" style={{ display: 'flex', alignItems: 'flex-end', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 700, color: 'var(--accent-hi)' }}>{campaign.campaign_no}</div>
          <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 32, fontWeight: 700, marginTop: 6, overflowWrap: 'anywhere' }}>
            {campaign.name || campaign.campaign_no}
          </h1>
          {influencer && (
            <div style={{ fontSize: 14, color: 'var(--text-2)', marginTop: 4 }}>
              {influencer}
              {campaign.influencer?.influencer_code && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-4)', marginLeft: 8 }}>{campaign.influencer.influencer_code}</span>}
            </div>
          )}
          <div style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 4 }}>
            Planned videos: <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-2)' }}>{campaign.video_count}</span> · Agreed total: <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-2)' }}>{inr(campaign.agreed_total)}</span>
          </div>
        </div>
        <StatusPill status={campaign.status} />
        {canManage && (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => setEditing(true)} className="ig-ghost-btn" style={btnGhost}>Edit</button>
            <button onClick={() => setShowAttach(true)} className="ig-cta" style={btnCta}>
              <Plus size={15} strokeWidth={2.5} />Link deal
            </button>
          </div>
        )}
      </header>

      <Card hero>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: pct != null ? 10 : 0 }}>
          <span style={{ fontFamily: 'var(--font-cond)', fontSize: 17, fontWeight: 700 }}>Budget</span>
          <span style={{ fontSize: 14, color: 'var(--text-3)' }}>
            Consumed <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-1)', fontWeight: 700 }}>{inr(spend)}</span>
            {budget != null && <> of {inr(budget)}</>}
            {left != null && (left >= 0
              ? <> · {inr(left)} left</>
              : <> · <span style={{ color: 'var(--state-error-fg)' }}>{inr(-left)} over</span></>)}
            {pct != null && <span style={{ fontFamily: 'var(--font-mono)', color: tone, marginLeft: 8 }}>{Math.round(pct)}%</span>}
          </span>
        </div>
        {pct != null && <ProgressBar pct={pct} color={tone} height={12} delay={200} />}
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
        <Tile size={22} label="Linked deals" value={r.linked_count ?? 0} />
        <Tile size={22} label="Posted" value={r.posted_count ?? 0} color="var(--accent-hi)" />
        <Tile size={22} label="Total spend" value={inr(r.spend)} />
        {/* Organic = views − paid (S373); the campaign rollup already returns it that way. */}
        <Tile size={22} label="Organic views" value={num(r.views).toLocaleString('en-IN')} />
        {num(r.paid_views) > 0 && <Tile size={22} label="Paid views (ads)" value={num(r.paid_views).toLocaleString('en-IN')} />}
        <Tile size={22} label="Orders" value={num(r.orders).toLocaleString('en-IN')} />
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-start' }}>
        <Card padding="0" style={{ flex: '1 1 100%', minWidth: 0, overflow: 'hidden' }}>
          <div style={{ padding: '16px 20px' }}>
            <SectionTitle size={15} style={{ marginBottom: 0 }}>Linked engagements</SectionTitle>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <div style={{ minWidth: canManage ? 870 : 826 }}>
              <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 12, padding: '10px 20px', borderTop: '1px solid var(--border)', fontSize: 12, fontWeight: 600, color: 'var(--text-4)' }}>
                <span>Engagement #</span><span>Type</span><span>Product</span><span>Stage</span>
                <span style={{ textAlign: 'right' }}>Spend</span><span style={{ textAlign: 'right' }}>Organic views</span><span style={{ textAlign: 'right' }}>Orders</span>
                {canManage && <span />}
              </div>
              {engs.length === 0 && (
                <div style={{ padding: '18px 20px', borderTop: '1px solid var(--row-divider)', color: 'var(--text-3)', fontSize: 14, textAlign: 'center' }}>No engagements linked yet.</div>
              )}
              {engs.map((e, i) => (
                <Row key={e.id} columns={cols} index={i} animate
                  onClick={() => router.push(`/engagements/detail/?id=${e.id}`)}
                  style={{ padding: '10px 20px' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: 'var(--accent-hi)' }}>{e.engagement_no}</span>
                  <span style={{ color: 'var(--text-2)' }}>{e.engagement_type === 'ugc' ? 'UGC' : 'Video'}</span>
                  <span style={{ color: 'var(--text-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{productLabel(e.product_code, e.product_variant) || '—'}</span>
                  <span style={{ justifySelf: 'start' }}><StagePill stage={e.stage} ugc={e.engagement_type === 'ugc'} /></span>
                  <NumCell>{inr(e.total_cost != null ? e.total_cost : e.payment_amount)}</NumCell>
                  <NumCell>
                    {Math.max(0, num(e.views) - num(e.paid_views)).toLocaleString('en-IN')}
                    {num(e.paid_views) > 0 && <div style={{ fontSize: 11, color: 'var(--text-4)' }}>+ {num(e.paid_views).toLocaleString('en-IN')} paid</div>}
                  </NumCell>
                  <NumCell>{num(e.orders).toLocaleString('en-IN')}</NumCell>
                  {canManage && (
                    <span style={{ textAlign: 'right' }}>
                      <button onClick={(ev) => { ev.stopPropagation(); detach(e.id); }} title="Detach" style={iconBtn}><X size={14} /></button>
                    </span>
                  )}
                </Row>
              ))}
            </div>
          </div>
        </Card>

        {/* Reann #8 (2026-08-27): "When creating/adding a campaign, there should be a dedicated
            Brief Upload section. We will upload the campaign brief ourselves." Lives on the
            campaign detail rather than the create form so a brief can be added or replaced later —
            briefs are rewritten more often than campaigns are created. */}
        <CampaignBrief campaign={campaign} canManage={canManage} session={session} onSaved={load} />
      </div>

      {showAttach && (
        <AttachModal session={session} campaign={campaign}
          onClose={() => setShowAttach(false)}
          onAttached={() => { setShowAttach(false); load(); }} />
      )}
      {editing && (
        <EditCampaignModal session={session} campaign={campaign}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); load(); }} />
      )}
    </div>
  );
}

// Same mapping as the Campaigns list pill.
function StatusPill({ status }) {
  const map = {
    active: ['var(--state-success-fg)', 'var(--state-success-bg)'],
    completed: ['var(--state-info-fg)', 'var(--state-info-bg)'],
    cancelled: ['var(--text-3)', 'var(--chip-neutral)'],
  };
  const [fg, bg] = map[status] || ['var(--text-2)', 'var(--chip-neutral)'];
  return <span style={{ color: fg, background: bg, fontSize: 12, fontWeight: 600, padding: '4px 10px', borderRadius: 99, textTransform: 'capitalize', marginBottom: 8 }}>{status}</span>;
}

const BRIEF_BUCKET = 'ignition-campaign-briefs';

/**
 * Campaign brief upload + read (Reann #8, 2026-08-27).
 *
 * Same three-step shape as the payment screenshot (S138 #4): ask the worker for a signed upload
 * token, PUT the file straight to storage with it, then record where it landed. The browser
 * never holds a service key and the bucket is private — the brief is read back through a
 * short-lived signed URL, never a public link.
 */
function CampaignBrief({ campaign, canManage, session, onSaved }) {
  const { showToast: toast } = useToast();
  const [busy, setBusy] = useState(false);

  async function open() {
    try {
      const r = await ignitionopsGet('getCampaignBriefUrl', { id: campaign.id }, session);
      if (r?.url) window.open(r.url, '_blank', 'noopener');
      else toast('No brief on this campaign', 'error');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function upload(file) {
    if (!file) return;
    setBusy(true);
    try {
      const { storage_path, token } = await ignitionopsPost(
        'createCampaignBriefUploadUrl',
        { campaign_id: campaign.id, file_name: file.name },
        session,
      );
      if (!token) throw new Error('Could not get an upload link for the brief');
      const { error } = await supabase.storage.from(BRIEF_BUCKET).uploadToSignedUrl(storage_path, token, file);
      if (error) throw error;
      // Only recorded AFTER the object is actually in the bucket — recording first would leave a
      // campaign advertising a brief that does not exist.
      await ignitionopsPost('updateCampaign', {
        campaign_id: campaign.id,
        patch: {
          brief_path: storage_path,
          brief_name: file.name,
          brief_mime: file.type || null,
          brief_uploaded_at: new Date().toISOString(),
        },
      }, session);
      toast('Brief uploaded', 'success');
      onSaved?.();
    } catch (e) { toast(e.message || 'Upload failed', 'error'); }
    finally { setBusy(false); }
  }

  return (
    <Card style={{ flex: '1 1 280px' }}>
      <SectionTitle size={15} style={{ marginBottom: 10 }}>Campaign brief</SectionTitle>
      {campaign.brief_path ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <button onClick={open} style={{ background: 'transparent', border: 'none', color: 'var(--accent-hi)', cursor: 'pointer', fontSize: 14, fontWeight: 600, textDecoration: 'underline', padding: 0, textAlign: 'left', overflowWrap: 'anywhere' }}>
            {campaign.brief_name || 'Open brief'}
          </button>
          {campaign.brief_uploaded_at && (
            <span style={{ fontSize: 12, color: 'var(--text-4)' }}>
              uploaded {new Date(campaign.brief_uploaded_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}
            </span>
          )}
        </div>
      ) : (
        <div style={{ fontSize: 14, color: 'var(--text-3)' }}>None uploaded.</div>
      )}
      {canManage && (
        <label className="ig-ghost-btn" style={{ ...btnGhost, marginTop: 14, opacity: busy ? 0.5 : 1, cursor: busy ? 'not-allowed' : 'pointer' }}>
          {busy ? 'Uploading…' : campaign.brief_path ? 'Replace' : 'Upload brief'}
          <input type="file" disabled={busy} onChange={e => upload(e.target.files?.[0])} style={{ display: 'none' }} />
        </label>
      )}
    </Card>
  );
}

function AttachModal({ session, campaign, onClose, onAttached }) {
  const { showToast: toast } = useToast();
  const [search, setSearch] = useState('');
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!session || search.length < 2) { setResults([]); return; }
    ignitionopsGet('getEngagements', { search, limit: 10 }, session)
      .then(r => setResults((r.engagements || []).filter(e => e.campaign_id == null || e.campaign_id === campaign.id)))
      .catch(() => setResults([]));
  }, [search, session]);

  async function attach(engId) {
    setBusy(true);
    try {
      await ignitionopsPost('assignEngagementToCampaign', { engagement_id: engId, campaign_id: campaign.id }, session);
      toast('Attached', 'success'); onAttached();
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  }

  return (
    <Modal open title="Link deal" onClose={onClose}>
      <div style={{ width: 'min(380px, 100%)', minWidth: 0 }}>
        <input autoFocus placeholder="Search engagement # / link / tracking…" value={search} onChange={e => setSearch(e.target.value)} style={inputStyle} />
        <div style={{ fontSize: 12, color: 'var(--text-4)', margin: '8px 0' }}>Only unassigned engagements (or already in this campaign) are shown.</div>
        <div style={{ background: 'var(--surface-sunk)', borderRadius: 12, border: '1px solid var(--border)', maxHeight: 280, overflowY: 'auto' }}>
          {results.length === 0 && <div style={{ padding: 12, color: 'var(--text-3)', fontSize: 13, textAlign: 'center' }}>{search.length < 2 ? 'Type to search…' : 'No matches.'}</div>}
          {results.map(e => (
            <div key={e.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '9px 12px', borderBottom: '1px solid var(--row-divider)' }}>
              <span style={{ minWidth: 0 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--accent-hi)', fontWeight: 600 }}>{e.engagement_no}</span>
                <span style={{ marginLeft: 8, fontSize: 13, color: 'var(--text-2)' }}>{titleish(e.product_code) || '—'} · {e.stage}</span>
              </span>
              <button onClick={() => attach(e.id)} disabled={busy || e.campaign_id === campaign.id} style={{ ...btnPrimary, opacity: (busy || e.campaign_id === campaign.id) ? 0.5 : 1 }}>
                {e.campaign_id === campaign.id ? 'Linked' : 'Link'}
              </button>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
          <button onClick={onClose} className="ig-ghost-btn" style={btnGhost}>Done</button>
        </div>
      </div>
    </Modal>
  );
}

function EditCampaignModal({ session, campaign, onClose, onSaved }) {
  const { showToast: toast } = useToast();
  const [videoCount, setVideoCount] = useState(campaign.video_count);
  const [agreedTotal, setAgreedTotal] = useState(campaign.agreed_total ?? '');
  const [status, setStatus] = useState(campaign.status);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await ignitionopsPost('updateCampaign', {
        campaign_id: campaign.id,
        patch: {
          video_count: Number(videoCount) || 1,
          agreed_total: agreedTotal === '' ? null : Number(agreedTotal),
          status,
        },
      }, session);
      toast('Saved', 'success'); onSaved();
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  }

  return (
    <Modal open title="Edit campaign" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: 'min(340px, 100%)', minWidth: 0 }}>
        <Field label="Video count"><input type="number" min={1} value={videoCount} onChange={e => setVideoCount(e.target.value)} style={inputStyle} /></Field>
        <Field label="Agreed total (₹)"><input type="number" value={agreedTotal} onChange={e => setAgreedTotal(e.target.value)} placeholder="optional" style={inputStyle} /></Field>
        <Field label="Status">
          <select value={status} onChange={e => setStatus(e.target.value)} style={inputStyle}>
            <option value="active">Active</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </Field>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <button onClick={onClose} className="ig-ghost-btn" style={btnGhost}>Cancel</button>
          <button onClick={save} disabled={busy} style={{ ...btnPrimary, opacity: busy ? 0.5 : 1 }}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-3)', marginBottom: 6 }}>{label}</div>
      {children}
    </div>
  );
}

const inputStyle = { background: 'var(--input)', color: 'var(--text-1)', border: '1px solid var(--border-2)', borderRadius: 12, padding: '10px 12px', fontFamily: 'var(--font-ui)', fontSize: 14, width: '100%', boxSizing: 'border-box' };
const btnPrimary = { padding: '8px 14px', background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none', borderRadius: 10, fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' };
const btnGhost = { height: 42, padding: '0 16px', display: 'inline-flex', alignItems: 'center', background: 'transparent', color: 'var(--text-1)', border: '1px solid var(--border-2)', borderRadius: 12, fontFamily: 'var(--font-ui)', fontSize: 14, fontWeight: 600, cursor: 'pointer' };
const btnCta = { height: 42, padding: '0 18px', display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--text-1)', color: 'var(--bg)', border: 'none', borderRadius: 12, fontFamily: 'var(--font-ui)', fontSize: 14, fontWeight: 700, cursor: 'pointer' };
const backLink = { alignSelf: 'flex-start', background: 'transparent', border: 'none', padding: 0, color: 'var(--text-3)', fontFamily: 'var(--font-ui)', fontSize: 13, cursor: 'pointer' };
const iconBtn = { background: 'transparent', border: 'none', color: 'var(--text-3)', cursor: 'pointer', padding: 4, display: 'inline-flex' };
