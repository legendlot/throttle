'use client';
import { useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { ignitionopsGet, ignitionopsPost } from '../../../../lib/ignitionopsFetch.js';
import RatingBadge from '../../../../components/RatingBadge.js';
import StageBadge from '../../../../components/StageBadge.js';
import DealTypeBadge from '../../../../components/DealTypeBadge.js';

export default function InfluencerDetailPage() {
  const sp = useSearchParams();
  const router = useRouter();
  const id = sp.get('id');
  const code = sp.get('code');
  const { session } = useAuth();
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  function reload() {
    if (!session || (!id && !code)) return;
    const params = id ? { id } : { code };
    ignitionopsGet('getInfluencer', params, session).then(setData).catch(e => setErr(e.message));
  }
  useEffect(reload, [id, code, session]);

  async function setRating(rating) {
    try {
      await ignitionopsPost('setRating', { influencer_id: data.influencer.id, rating }, session);
      toast(`Rating set to ${rating}`, 'success');
      reload();
    } catch (e) { toast(e.message, 'error'); }
  }

  if (err) return <div style={{ color: 'var(--state-error-fg)', padding: 16 }}>Error: {err}</div>;
  if (!data) return <Spinner />;
  const inf = data.influencer;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1100 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ color: '#FF6B00', fontWeight: 700, fontSize: 18 }}>{inf.influencer_code}</span>
        <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          {inf.channel_name || inf.person_name || '(no name)'}
        </h1>
        <RatingBadge rating={inf.quality_rating} />
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {['green','yellow','red','unrated'].map(r => (
            <button key={r} onClick={() => setRating(r)} style={ratingBtn}>{r}</button>
          ))}
        </div>
      </div>

      <Card title="Identity">
        <KV label="Channel link" value={inf.channel_link ? <a href={inf.channel_link} target="_blank" rel="noreferrer" style={{ color: '#FF6B00' }}>{inf.channel_link}</a> : '—'} />
        <KV label="Platform" value={inf.channel_platform || '—'} />
        <KV label="Type" value={inf.influencer_type || '—'} />
        <KV label="Categories" value={(inf.categories || []).join(', ') || '—'} />
        <KV label="Reach" value={inf.reach?.toLocaleString() || '—'} />
        <KV label="Audience" value={inf.audience || '—'} />
        <KV label="Location" value={inf.location || '—'} />
      </Card>

      <Card title="Contact">
        <KV label="POC type" value={inf.contact_poc_type || '—'} />
        <KV label="POC name" value={inf.contact_poc_name || '—'} />
        <KV label="Phone" value={inf.contact_number || '—'} />
        <KV label="Email" value={inf.email || '—'} />
        <KV label="Address" value={inf.address || '—'} />
        <KV label="First invite" value={inf.first_invite_sent_at ? new Date(inf.first_invite_sent_at).toLocaleDateString() : 'Not sent'} />
      </Card>

      <Card title={`Engagements (${data.engagements.length})`}>
        {data.engagements.length === 0 ? (
          <div style={{ color: 'var(--text-3)' }}>No engagements yet.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
                <th style={th}>Engagement #</th><th style={th}>Type</th><th style={th}>Stage</th>
                <th style={th}>Deal</th><th style={th}>Post date</th><th style={th}>Total cost</th>
              </tr>
            </thead>
            <tbody>
              {data.engagements.map(e => (
                <tr key={e.id} onClick={() => router.push(`/engagements/detail/?id=${e.id}`)}
                  style={{ cursor: 'pointer', borderTop: '1px solid var(--border)' }}>
                  <td style={td}><span style={{ color: '#FF6B00', fontWeight: 600 }}>{e.engagement_no}</span></td>
                  <td style={td}>{e.engagement_type}</td>
                  <td style={td}><StageBadge stage={e.stage} /></td>
                  <td style={td}><DealTypeBadge dealType={e.deal_type} /></td>
                  <td style={td}>{e.post_date || '—'}</td>
                  <td style={td}>₹{Number(e.total_cost || 0).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {inf.rating_notes && (
        <Card title="Rating notes">
          <div style={{ whiteSpace: 'pre-wrap', color: 'var(--text-2)' }}>{inf.rating_notes}</div>
        </Card>
      )}
    </div>
  );
}

function Card({ title, children }) {
  return (
    <section style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius-md)', padding: 16,
    }}>
      <h2 style={{
        fontSize: 12, color: 'var(--text-3)', letterSpacing: '0.08em',
        textTransform: 'uppercase', marginBottom: 12,
      }}>{title}</h2>
      {children}
    </section>
  );
}

function KV({ label, value }) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '4px 0' }}>
      <span style={{ width: 140, color: 'var(--text-3)', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </span>
      <span style={{ color: 'var(--text-1)', fontSize: 13, flex: 1 }}>{value}</span>
    </div>
  );
}

const ratingBtn = {
  padding: '4px 8px', background: 'transparent', color: 'var(--text-2)',
  border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
  fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer',
  textTransform: 'uppercase', letterSpacing: '0.04em',
};
const th = { padding: '8px 10px', fontSize: 11, color: 'var(--text-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600 };
const td = { padding: '8px 10px' };
