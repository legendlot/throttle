'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, Chip } from '@throttle/ui';
import { ignitionopsGet } from '../../../lib/ignitionopsFetch.js';
import RatingBadge from '../../../components/RatingBadge.js';

const FILTERS = [
  { id: 'all', label: 'All', value: '' },
  { id: 'green', label: 'Green', value: 'green' },
  { id: 'yellow', label: 'Yellow', value: 'yellow' },
  { id: 'red', label: 'Red', value: 'red' },
  { id: 'unrated', label: 'Unrated', value: 'unrated' },
];

export default function RosterPage() {
  const { session } = useAuth();
  const router = useRouter();
  const [rating, setRating] = useState('');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!session) return;
    setLoading(true);
    const params = { limit: 200 };
    if (rating) params.rating = rating;
    ignitionopsGet('getRoster', params, session)
      .then(r => setRows(r.roster || []))
      .finally(() => setLoading(false));
  }, [rating, session]);

  return (
    <div>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          Roster
        </h1>
        <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
          Influencers with ≥1 completed engagement.
        </div>
      </header>

      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {FILTERS.map(f => <Chip key={f.id} active={rating === f.value} onClick={() => setRating(f.value)}>{f.label}</Chip>)}
      </div>

      {!loading && rows.length > 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-3)', fontFamily: 'var(--font-mono)', marginBottom: 12 }}>
          {rows.length.toLocaleString()} influencer{rows.length === 1 ? '' : 's'}
          {' · '}
          {rows.reduce((a, r) => a + (Number(r.reach) || 0), 0).toLocaleString()} total reach
        </div>
      )}

      {loading ? <Spinner /> : (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
              <th style={th}>Code</th><th style={th}>Channel</th><th style={th}>Type</th><th style={th}>Reach</th>
              <th style={th}>Engagements</th><th style={th}>Rating</th>
            </tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={6} style={{ ...td, color: 'var(--text-3)', textAlign: 'center' }}>No influencers in roster.</td></tr>}
              {rows.map(r => (
                <tr key={r.id} onClick={() => router.push(`/influencers/detail/?id=${r.id}`)}
                  style={{ cursor: 'pointer', borderTop: '1px solid var(--border)' }}>
                  <td style={td}><span style={{ color: '#FF6B00', fontWeight: 600 }}>{r.influencer_code}</span></td>
                  <td style={td}>{r.channel_name || r.person_name || '—'}</td>
                  <td style={td}>{r.influencer_type || '—'}</td>
                  <td style={td}>{r.reach?.toLocaleString() || '—'}</td>
                  <td style={td}>{(r.engagements || []).length}</td>
                  <td style={td}><RatingBadge rating={r.quality_rating} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
const th = { padding: '10px 12px', fontSize: 11, color: 'var(--text-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600 };
const td = { padding: '10px 12px' };
