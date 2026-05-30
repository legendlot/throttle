'use client';
import { useEffect, useState, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, KpiCard, Modal, useToast } from '@throttle/ui';
import { Plus, X, ArrowLeft } from 'lucide-react';
import { ignitionopsGet, ignitionopsPost } from '../../../../lib/ignitionopsFetch.js';

function inr(n) { return n == null || isNaN(n) ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`; }
function num(n) { return n == null || isNaN(n) ? 0 : Number(n); }

export default function CampaignDetailPage() {
  const params = useSearchParams();
  const id = params.get('id');
  const { session, perms } = useAuth();
  const { toast } = useToast();
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

  if (loading) return <Spinner />;
  if (!campaign) return <div style={{ padding: 16, color: 'var(--text-3)' }}>Campaign not found.</div>;

  const r = campaign.rollup || {};
  const engs = campaign.engagements || [];

  return (
    <div>
      <button onClick={() => router.push('/campaigns')} style={{ ...btnGhost, marginBottom: 12 }}>
        <ArrowLeft size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />Campaigns
      </button>

      <header style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            <span style={{ color: '#FF6B00' }}>{campaign.campaign_no}</span>
          </h1>
          <div style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 4 }}>
            {campaign.influencer?.channel_name || campaign.influencer?.person_name || '—'}
            {campaign.influencer?.influencer_code && <span style={{ color: 'var(--text-3)', marginLeft: 8 }}>{campaign.influencer.influencer_code}</span>}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
            Status: <b style={{ color: 'var(--text-2)' }}>{campaign.status}</b> · Planned videos: {campaign.video_count} · Agreed total: {inr(campaign.agreed_total)}
          </div>
        </div>
        {canManage && <button onClick={() => setEditing(true)} style={btnGhost}>Edit</button>}
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 20 }}>
        <KpiCard label="Linked deals" value={r.linked_count ?? 0} />
        <KpiCard label="Posted" value={r.posted_count ?? 0} accent="#FF6B00" />
        <KpiCard label="Total spend" value={inr(r.spend)} />
        <KpiCard label="Views" value={num(r.views).toLocaleString()} />
        <KpiCard label="Orders" value={num(r.orders).toLocaleString()} />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <h2 style={{ fontFamily: 'var(--font-cond)', fontSize: 14, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-2)' }}>Linked engagements</h2>
        {canManage && <button onClick={() => setShowAttach(true)} style={btnPrimary}><Plus size={13} strokeWidth={2.5} style={{ verticalAlign: '-2px', marginRight: 4 }} />Attach</button>}
      </div>

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead><tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
            <th style={th}>Engagement #</th><th style={th}>Type</th><th style={th}>Product</th>
            <th style={th}>Stage</th><th style={th}>Spend</th><th style={th}>Views</th><th style={th}>Orders</th>
            {canManage && <th style={th}></th>}
          </tr></thead>
          <tbody>
            {engs.length === 0 && <tr><td colSpan={canManage ? 8 : 7} style={{ ...td, color: 'var(--text-3)', textAlign: 'center' }}>No engagements linked yet.</td></tr>}
            {engs.map(e => (
              <tr key={e.id} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={td}><a onClick={() => router.push(`/engagements/detail/?id=${e.id}`)} style={{ color: '#FF6B00', fontWeight: 600, cursor: 'pointer' }}>{e.engagement_no}</a></td>
                <td style={td}>{e.engagement_type === 'ugc' ? 'UGC' : 'Video'}</td>
                <td style={td}>{e.product_code || '—'}{e.product_variant ? ` · ${e.product_variant}` : ''}</td>
                <td style={td}>{e.stage}</td>
                <td style={td}>{inr(e.total_cost != null ? e.total_cost : e.payment_amount)}</td>
                <td style={td}>{num(e.views).toLocaleString()}</td>
                <td style={td}>{num(e.orders).toLocaleString()}</td>
                {canManage && <td style={td}><button onClick={() => detach(e.id)} title="Detach" style={iconBtn}><X size={14} /></button></td>}
              </tr>
            ))}
          </tbody>
        </table>
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

function AttachModal({ session, campaign, onClose, onAttached }) {
  const { toast } = useToast();
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
    <Modal open title="Attach engagement" onClose={onClose}>
      <div style={{ minWidth: 380 }}>
        <input autoFocus placeholder="Search engagement # / link / tracking…" value={search} onChange={e => setSearch(e.target.value)} style={inputStyle} />
        <div style={{ fontSize: 11, color: 'var(--text-3)', margin: '6px 0' }}>Only unassigned engagements (or already in this campaign) are shown.</div>
        <div style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', maxHeight: 280, overflowY: 'auto' }}>
          {results.length === 0 && <div style={{ padding: 12, color: 'var(--text-3)', fontSize: 12, textAlign: 'center' }}>{search.length < 2 ? 'Type to search…' : 'No matches.'}</div>}
          {results.map(e => (
            <div key={e.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 9, borderBottom: '1px solid var(--border)' }}>
              <span>
                <span style={{ color: '#FF6B00', fontWeight: 600 }}>{e.engagement_no}</span>
                <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--text-2)' }}>{e.product_code || '—'} · {e.stage}</span>
              </span>
              <button onClick={() => attach(e.id)} disabled={busy || e.campaign_id === campaign.id} style={{ ...btnPrimary, opacity: (busy || e.campaign_id === campaign.id) ? 0.5 : 1 }}>
                {e.campaign_id === campaign.id ? 'Linked' : 'Attach'}
              </button>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
          <button onClick={onClose} style={btnGhost}>Done</button>
        </div>
      </div>
    </Modal>
  );
}

function EditCampaignModal({ session, campaign, onClose, onSaved }) {
  const { toast } = useToast();
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 340 }}>
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
          <button onClick={onClose} style={btnGhost}>Cancel</button>
          <button onClick={save} disabled={busy} style={{ ...btnPrimary, opacity: busy ? 0.5 : 1 }}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

const th = { padding: '10px 12px', fontSize: 11, color: 'var(--text-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600 };
const td = { padding: '10px 12px' };
const inputStyle = { background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', fontFamily: 'var(--font-mono)', fontSize: 13, width: '100%', boxSizing: 'border-box' };
const btnPrimary = { padding: '7px 14px', background: '#FF6B00', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', cursor: 'pointer' };
const btnGhost = { padding: '7px 14px', background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.05em' };
const iconBtn = { background: 'transparent', border: 'none', color: 'var(--text-3)', cursor: 'pointer', padding: 4, display: 'inline-flex' };
