'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { ignitionopsGet } from '../../../lib/ignitionopsFetch.js';
import { Segmented, RatingDot, RATING_COLORS, Avatar } from '../../../components/ui/index.js';

const FILTERS = [
  { id: 'all', label: 'All', value: '' },
  { id: 'green', label: 'Green', value: 'green' },
  { id: 'yellow', label: 'Yellow', value: 'yellow' },
  { id: 'red', label: 'Red', value: 'red' },
  { id: 'unrated', label: 'Unrated', value: 'unrated' },
];
const VIEWS = [{ value: 'tiles', label: 'Tiles' }, { value: 'list', label: 'List' }];
const FETCH_LIMIT = 200;

const ratingKey = r => (RATING_COLORS[r?.quality_rating] ? r.quality_rating : 'unrated');
const reachOf = r => Number(r.reach) || 0;
const fmt = n => (n ? Number(n).toLocaleString() : '—');
const href = r => `/influencers/detail/?id=${r.id}`;

export default function RosterPage() {
  const { session } = useAuth();
  const [rating, setRating] = useState('');
  const [view, setView] = useState('tiles');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!session) return;
    setLoading(true);
    const params = { limit: FETCH_LIMIT };
    if (rating) params.rating = rating;
    ignitionopsGet('getRoster', params, session)
      .then(r => setRows(r.roster || []))
      .finally(() => setLoading(false));
  }, [rating, session]);

  // Counts come from the fetched rows only. With a rating filter the server returns just that
  // rating, so only the active option can carry a count; on "All" every option can.
  const counts = { '': rows.length, green: 0, yellow: 0, red: 0, unrated: 0 };
  rows.forEach(r => { counts[ratingKey(r)] += 1; });
  const filterOptions = FILTERS.map(f => ({
    value: f.value, label: f.label,
    count: loading ? undefined : (!rating || rating === f.value ? counts[f.value].toLocaleString() : undefined),
  }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--text-4)' }}>
            Lists · everyone who has done a video
          </div>
          <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 32, fontWeight: 700, marginTop: 6 }}>Roster</h1>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
            Influencers with ≥1 posted (shipped-or-later) engagement.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <Segmented options={VIEWS} value={view} onChange={setView} />
          <Segmented options={filterOptions} value={rating} onChange={setRating} />
        </div>
      </div>

      {!loading && rows.length > 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
          {rows.length.toLocaleString()} influencer{rows.length === 1 ? '' : 's'} shown
          {' · '}
          {rows.reduce((a, r) => a + reachOf(r), 0).toLocaleString()} total reach (of those shown)
        </div>
      )}

      {loading ? <Spinner /> : rows.length === 0 ? (
        <div style={{ color: 'var(--text-3)', textAlign: 'center', padding: 24, fontSize: 13 }}>No influencers in roster.</div>
      ) : view === 'list' ? (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-card)', overflowX: 'auto' }}>
          <div style={{ minWidth: 700 }}>
            <div style={{ ...listGrid, padding: '12px 18px', fontSize: 12, fontWeight: 600, color: 'var(--text-4)', borderBottom: '1px solid var(--border)' }}>
              <span>Code</span><span>Channel</span><span>Type</span>
              <span style={{ textAlign: 'right' }}>Reach</span><span style={{ textAlign: 'right' }}>Videos</span><span>Rating</span>
            </div>
            {rows.map((r, i) => {
              const name = r.channel_name || r.person_name || '—';
              return (
                <Link key={r.id} href={href(r)} className="ig-row"
                  style={{ ...listGrid, alignItems: 'center', padding: '10px 18px', borderTop: i ? '1px solid var(--border)' : 'none', fontSize: 14, color: 'var(--text-1)' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: 'var(--accent-hi)' }}>{r.influencer_code}</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                    <Avatar name={name} index={i} />
                    <span style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
                  </span>
                  <span style={{ justifySelf: 'start', fontSize: 12, fontWeight: 600, padding: '3px 9px', borderRadius: 8, background: 'var(--surface-hover)', color: 'var(--text-2)' }}>{r.influencer_type || '—'}</span>
                  <span className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 13, textAlign: 'right' }}>{fmt(r.reach)}</span>
                  <span className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 13, textAlign: 'right' }}>{(r.engagements || []).length}</span>
                  <RatingDot rating={ratingKey(r)} size={9} />
                </Link>
              );
            })}
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(260px, 100%), 1fr))', gap: 12 }}>
          {rows.map((r, i) => {
            const name = r.channel_name || r.person_name || '—';
            const rk = ratingKey(r);
            return (
              <Link key={r.id} href={href(r)} className="ig-card-hover"
                style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 18, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-card)', color: 'var(--text-1)', minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <Avatar name={name} index={i} size={46} ring={RATING_COLORS[rk]} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--accent-hi)' }}>
                      {r.influencer_code} <span style={{ color: 'var(--text-4)' }}>· {r.influencer_type || '—'}</span>
                    </div>
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <div>
                    <div className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 700 }}>{fmt(r.reach)}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-4)' }}>Reach</div>
                  </div>
                  <div>
                    <div className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 700 }}>{(r.engagements || []).length}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-4)' }}>Videos</div>
                  </div>
                </div>
                <RatingDot rating={rk} />
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
const listGrid = { display: 'grid', gridTemplateColumns: '90px minmax(200px,2fr) 90px 100px 80px 110px', gap: 12 };
