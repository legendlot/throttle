'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { ignitionopsGet } from '../../../lib/ignitionopsFetch.js';
import { Segmented, RatingDot, RATING_COLORS, Avatar, Typeahead } from '../../../components/ui/index.js';
import { matchRows } from '../../../lib/typeahead.js';

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
const fmt = n => (n == null || n === '' ? '—' : Number(n).toLocaleString());
const href = r => `/influencers/detail/?id=${r.id}`;
// Client-side search over the loaded roster (plan 2026-10-08 S5) — inherits the getRoster limit bug.
const rosterFields = r => [r.channel_name, r.person_name, r.influencer_code, r.channel_link, r.influencer_type];

export default function RosterPage() {
  const { session } = useAuth();
  const [rating, setRating] = useState('');
  const [view, setView] = useState('tiles');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const router = useRouter();
  const shown = matchRows(rows, q, rosterFields);

  useEffect(() => {
    if (!session) return;
    setLoading(true);
    const params = { limit: FETCH_LIMIT };
    if (rating) params.rating = rating;
    ignitionopsGet('getRoster', params, session)
      .then(r => setRows(r.roster || []))
      .finally(() => setLoading(false));
  }, [rating, session]);

  // Counts come from the fetched rows only, and getRoster limits BEFORE its shipped+ filter (backlog
  // bug), so a per-rating count on "All" understates by up to ~7x vs that rating's own fetch. Only the
  // ACTIVE option carries a count — the one number the rows on screen actually back (S412 review).
  const counts = { '': rows.length, green: 0, yellow: 0, red: 0, unrated: 0 };
  rows.forEach(r => { counts[ratingKey(r)] += 1; });
  const filterOptions = FILTERS.map(f => ({
    value: f.value, label: f.label,
    count: loading || rating !== f.value ? undefined : counts[f.value].toLocaleString(),
  }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--text-4)' }}>
            Lists · shipped or later
          </div>
          <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 32, fontWeight: 700, marginTop: 6 }}>Roster</h1>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
            Influencers with ≥1 posted (shipped-or-later) engagement.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <Typeahead
            placeholder="Search name, handle, code…"
            value={q}
            onChange={setQ}
            quiet
            debounceMs={0}
            refreshKey={rows}
            width={260}
            fetchResults={async (text) => matchRows(rows, text, rosterFields).slice(0, 6).map(r => {
              const name = r.channel_name || r.person_name || r.influencer_code || '';
              return {
                id: r.id, href: href(r), primary: name,
                secondary: [r.person_name && r.person_name !== name ? r.person_name : null, r.influencer_code !== name ? r.influencer_code : null].filter(Boolean).join(' · '),
                lead: <Avatar name={name} seed={r.id} size={28} />,
                meta: <RatingDot rating={ratingKey(r)} showLabel={false} />,
              };
            })}
            onPick={it => router.push(it.href)}
            onSubmit={() => {}}
          />
          <Segmented options={VIEWS} value={view} onChange={setView} />
          <Segmented options={filterOptions} value={rating} onChange={setRating} />
        </div>
      </div>

      {!loading && shown.length > 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
          {shown.length.toLocaleString()} influencer{shown.length === 1 ? '' : 's'} shown
          {' · '}
          {shown.reduce((a, r) => a + reachOf(r), 0).toLocaleString()} total reach (of those shown)
        </div>
      )}

      {loading ? <Spinner /> : shown.length === 0 ? (
        <div style={{ color: 'var(--text-3)', textAlign: 'center', padding: 24, fontSize: 13 }}>
          {rows.length
            ? <>No loaded influencer matches &ldquo;{q.trim()}&rdquo; &mdash; search covers the {rows.length} shown on this page, not the whole roster.</>
            : 'No influencers in roster.'}
        </div>
      ) : view === 'list' ? (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-card)', overflowX: 'auto' }}>
          <div style={{ minWidth: 770 }}>
            <div style={{ ...listGrid, padding: '12px 18px', fontSize: 12, fontWeight: 600, color: 'var(--text-4)', borderBottom: '1px solid var(--border)' }}>
              <span>Code</span><span>Channel</span><span>Type</span>
              <span style={{ textAlign: 'right' }}>Reach</span><span style={{ textAlign: 'right' }}>Videos</span><span>Rating</span>
            </div>
            {shown.map((r, i) => {
              const name = r.channel_name || r.person_name || '—';
              return (
                <Link key={r.id} href={href(r)} prefetch={false} className="ig-row"
                  style={{ ...listGrid, alignItems: 'center', padding: '10px 18px', borderTop: i ? '1px solid var(--border)' : 'none', fontSize: 14, color: 'var(--text-1)' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: 'var(--accent-hi)' }}>{r.influencer_code}</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                    <Avatar name={name} seed={r.id} />
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
          {shown.map((r, i) => {
            const name = r.channel_name || r.person_name || '—';
            const rk = ratingKey(r);
            return (
              <Link key={r.id} href={href(r)} prefetch={false} className="ig-card-hover"
                style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 18, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-card)', color: 'var(--text-1)', minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <Avatar name={name} seed={r.id} size={46} ring={RATING_COLORS[rk]} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--accent-hi)' }}>
                      {r.influencer_code} <span style={{ color: 'var(--text-4)' }}>· {r.influencer_type || '—'}</span>
                    </div>
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
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
