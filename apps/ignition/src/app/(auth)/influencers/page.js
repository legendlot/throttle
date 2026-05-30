'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, Chip, useListNav } from '@throttle/ui';
import { ignitionopsGet } from '../../../lib/ignitionopsFetch.js';
import RatingBadge from '../../../components/RatingBadge.js';

const TABS = [
  { id: 'master',   label: 'Master' },
  { id: 'b_list',   label: 'B-List' },
  { id: 'archived', label: 'Archived' },
];

const TYPE_FILTERS = ['nano','micro','macro','brand','store'];

export default function InfluencersPage() {
  const { session } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState('master');
  const [type, setType] = useState('');
  const [rating, setRating] = useState('');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const { focusedIdx, setFocusedIdx } = useListNav(rows.length, (i) => {
    const r = rows[i]; if (r) router.push(`/influencers/detail/?id=${r.id}`);
  });

  useEffect(() => {
    if (!session) return;
    setLoading(true);
    const params = { tab, limit: 100, offset: 0 };
    if (type) params.type = type;
    if (rating) params.rating = rating;
    if (search) params.search = search;
    ignitionopsGet('getInfluencers', params, session)
      .then(r => setRows(r.influencers || []))
      .finally(() => setLoading(false));
  }, [tab, type, rating, search, session]);

  return (
    <div>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1 style={{
          fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700,
          letterSpacing: '0.04em', textTransform: 'uppercase',
        }}>Influencers</h1>
      </header>

      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {TABS.map(t => (
          <Chip key={t.id} active={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</Chip>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
        <input
          data-search-primary
          placeholder="Search code, handle, name, phone, email…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={inputStyle(280)}
        />
        <select value={type} onChange={e => setType(e.target.value)} style={inputStyle(140)}>
          <option value="">All types</option>
          {TYPE_FILTERS.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={rating} onChange={e => setRating(e.target.value)} style={inputStyle(140)}>
          <option value="">All ratings</option>
          <option value="green">Green</option>
          <option value="yellow">Yellow</option>
          <option value="red">Red</option>
          <option value="unrated">Unrated</option>
        </select>
      </div>

      {loading ? <Spinner /> : (
        <div style={{
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)', overflow: 'hidden',
        }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
                <th style={th}>Code</th>
                <th style={th}>Channel</th>
                <th style={th}>Type</th>
                <th style={th}>Category</th>
                <th style={th}>Reach</th>
                <th style={th}>Location</th>
                <th style={th}>Rating</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={7} style={{ ...td, color: 'var(--text-3)', textAlign: 'center' }}>No results</td></tr>
              )}
              {rows.map((r, i) => (
                <tr
                  key={r.id}
                  onClick={() => router.push(`/influencers/detail/?id=${r.id}`)}
                  style={{
                    cursor: 'pointer', borderTop: '1px solid var(--border)',
                    background: focusedIdx === i ? 'var(--surface-2)' : 'transparent',
                    outline: focusedIdx === i ? '2px solid #FF6B00' : 'none', outlineOffset: '-2px',
                  }}
                  onMouseEnter={() => setFocusedIdx(i)}
                >
                  <td style={td}><span style={{ color: '#FF6B00', fontWeight: 600 }}>{r.influencer_code}</span></td>
                  <td style={td}>
                    <div>{r.channel_name || '—'}</div>
                    {r.person_name && <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{r.person_name}</div>}
                  </td>
                  <td style={td}>{r.influencer_type || '—'}</td>
                  <td style={td}>{(r.categories || []).join(', ') || '—'}</td>
                  <td style={td}>{r.reach?.toLocaleString() || '—'}</td>
                  <td style={td}>{r.location || '—'}</td>
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
function inputStyle(w) {
  return {
    background: 'var(--surface-2)', color: 'var(--text-1)',
    border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
    padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 13,
    width: w,
  };
}
