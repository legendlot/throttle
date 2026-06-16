'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, Modal, useToast, useListNav } from '@throttle/ui';
import { Plus } from 'lucide-react';
import { ignitionopsGet, ignitionopsPost } from '../../../lib/ignitionopsFetch.js';

function inr(n) { return n == null || isNaN(n) ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`; }

export default function CampaignsPage() {
  const { session, perms } = useAuth();
  const { showToast: toast } = useToast();
  const router = useRouter();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const canManage = !!perms?.ignition_manage;
  const { focusedIdx, setFocusedIdx } = useListNav(rows.length, (i) => {
    const c = rows[i]; if (c) router.push(`/campaigns/detail/?id=${c.id}`);
  });

  function load() {
    if (!session) return;
    setLoading(true);
    ignitionopsGet('getCampaigns', {}, session)
      .then(r => setRows(r.campaigns || []))
      .catch(e => toast(e.message, 'error'))
      .finally(() => setLoading(false));
  }
  useEffect(load, [session]);

  return (
    <div>
      <header style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            Campaigns
          </h1>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
            Multi-video deal groupings. Each campaign rolls up its linked engagements.
          </div>
        </div>
        {canManage && (
          <button onClick={() => setShowNew(true)} style={btnPrimary}>
            <Plus size={14} strokeWidth={2.5} style={{ marginRight: 6, verticalAlign: '-2px' }} />New Campaign
          </button>
        )}
      </header>

      {loading ? <Spinner /> : (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
              <th style={th}>Campaign #</th><th style={th}>Influencer</th><th style={th}>Videos</th>
              <th style={th}>Linked</th><th style={th}>Posted</th><th style={th}>Spend</th>
              <th style={th}>Agreed total</th><th style={th}>Status</th>
            </tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={8} style={{ ...td, color: 'var(--text-3)', textAlign: 'center' }}>No campaigns yet.</td></tr>}
              {rows.map((c, i) => (
                <tr key={c.id} onClick={() => router.push(`/campaigns/detail/?id=${c.id}`)}
                  onMouseEnter={() => setFocusedIdx(i)}
                  style={{
                    borderTop: '1px solid var(--border)', cursor: 'pointer',
                    background: focusedIdx === i ? 'var(--surface-2)' : 'transparent',
                    outline: focusedIdx === i ? '2px solid #FF6B00' : 'none', outlineOffset: '-2px',
                  }}>
                  <td style={td}><span style={{ color: '#FF6B00', fontWeight: 600 }}>{c.campaign_no}</span></td>
                  <td style={td}>{c.influencer?.channel_name || c.influencer?.person_name || c.influencer?.influencer_code || '—'}</td>
                  <td style={td}>{c.video_count}</td>
                  <td style={td}>{c.rollup?.linked_count ?? 0}</td>
                  <td style={td}>{c.rollup?.posted_count ?? 0}</td>
                  <td style={td}>{inr(c.rollup?.spend)}</td>
                  <td style={td}>{c.agreed_total != null ? inr(c.agreed_total) : '—'}</td>
                  <td style={td}><StatusPill status={c.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showNew && (
        <NewCampaignModal
          session={session}
          onClose={() => setShowNew(false)}
          onCreated={(c) => { setShowNew(false); toast(`Created ${c.campaign_no}`, 'success'); router.push(`/campaigns/detail/?id=${c.id}`); }}
        />
      )}
    </div>
  );
}

function StatusPill({ status }) {
  const map = { active: '#FF6B00', completed: '#4ade80', cancelled: '#888' };
  return <span style={{ color: map[status] || 'var(--text-2)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{status}</span>;
}

function NewCampaignModal({ session, onClose, onCreated }) {
  const { showToast: toast } = useToast();
  const [search, setSearch] = useState('');
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(null);
  const [videoCount, setVideoCount] = useState(2);
  const [agreedTotal, setAgreedTotal] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!session || search.length < 2) { setResults([]); return; }
    ignitionopsGet('getInfluencers', { search, limit: 8 }, session)
      .then(r => setResults(r.influencers || []))
      .catch(() => setResults([]));
  }, [search, session]);

  async function submit() {
    if (!selected) { toast('Pick an influencer', 'error'); return; }
    setBusy(true);
    try {
      const c = await ignitionopsPost('createCampaign', {
        influencer_id: selected.id,
        video_count: Number(videoCount) || 1,
        agreed_total: agreedTotal === '' ? null : Number(agreedTotal),
      }, session);
      onCreated(c);
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  }

  return (
    <Modal open title="New Campaign" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 360 }}>
        <Field label="Influencer">
          {selected ? (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 10, background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}>
              <span><span style={{ color: '#FF6B00', fontWeight: 700 }}>{selected.influencer_code}</span> <span style={{ marginLeft: 8 }}>{selected.channel_name || selected.person_name}</span></span>
              <button onClick={() => setSelected(null)} style={btnGhost}>Change</button>
            </div>
          ) : (
            <>
              <input autoFocus placeholder="Search code, handle, name…" value={search} onChange={e => setSearch(e.target.value)} style={inputStyle} />
              {results.length > 0 && (
                <div style={{ marginTop: 6, background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', maxHeight: 200, overflowY: 'auto' }}>
                  {results.map(r => (
                    <div key={r.id} onClick={() => { setSelected(r); setSearch(''); setResults([]); }}
                      style={{ padding: 9, cursor: 'pointer', borderBottom: '1px solid var(--border)' }}>
                      <span style={{ color: '#FF6B00', fontWeight: 600 }}>{r.influencer_code}</span>
                      <span style={{ marginLeft: 8 }}>{r.channel_name || r.person_name || '—'}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Video count"><input type="number" min={1} value={videoCount} onChange={e => setVideoCount(e.target.value)} style={inputStyle} /></Field>
          <Field label="Agreed total (₹)"><input type="number" value={agreedTotal} onChange={e => setAgreedTotal(e.target.value)} placeholder="optional" style={inputStyle} /></Field>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <button onClick={onClose} style={btnGhost}>Cancel</button>
          <button onClick={submit} disabled={!selected || busy} style={{ ...btnPrimary, opacity: !selected || busy ? 0.5 : 1 }}>{busy ? 'Creating…' : 'Create'}</button>
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
const btnPrimary = { padding: '8px 16px', background: '#FF6B00', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer' };
const btnGhost = { padding: '8px 16px', background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.06em' };
