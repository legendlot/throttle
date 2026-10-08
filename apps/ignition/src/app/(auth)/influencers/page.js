'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useListNav, useToast } from '@throttle/ui';
import { Plus, ChevronDown, Link2Off } from 'lucide-react';
import { ignitionopsGet, ignitionopsPost } from '../../../lib/ignitionopsFetch.js';
import { channelLinkError, normalizeChannelLink } from '../../../lib/channelLink.js';
import {
  Segmented, Menu, SearchField, FilterSelect, TableCard, Row, NumCell, Avatar, RatingDot, Banner,
} from '../../../components/ui/index.js';
import { NewInfluencerModal } from '../../../components/NewInfluencerModal.js';
import { NewDealModal } from '../../../components/NewDealModal.js';

const TABS = [
  { id: 'master',   label: 'Master' },
  { id: 'b_list',   label: 'B-List' },
  { id: 'archived', label: 'Archived' },
];

const REACH_BUCKETS = [
  { id: '',                label: 'All reach' },
  { id: '0-10000',         label: '< 10K',     min: 0,       max: 10000 },
  { id: '10000-50000',     label: '10K–50K',   min: 10000,   max: 50000 },
  { id: '50000-100000',    label: '50K–100K',  min: 50000,   max: 100000 },
  { id: '100000-500000',   label: '100K–500K', min: 100000,  max: 500000 },
  { id: '500000-1000000',  label: '500K–1M',   min: 500000,  max: 1000000 },
  { id: '1000000-',        label: '1M+',       min: 1000000 },
];

const SORTS = [
  { id: 'recent', label: 'Recently updated' },
  { id: 'code',   label: 'Code (sequence)' },
  { id: 'reach',  label: 'Reach (high → low)' },
];

const GENDER_LABELS = { male: 'Male-majority', female: 'Female-majority', balanced: 'Balanced' };

const PAGE = 100;

function fmtReach(n) {
  if (n == null) return '–';
  if (n >= 1e7) return (n / 1e7).toFixed(n % 1e7 === 0 ? 0 : 1) + 'Cr';
  if (n >= 1e5) return (n / 1e5).toFixed(n % 1e5 === 0 ? 0 : 1) + 'L';
  if (n >= 1e3) return (n / 1e3).toFixed(n % 1e3 === 0 ? 0 : 1) + 'K';
  return n.toLocaleString();
}

export default function InfluencersPage() {
  const { session } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState('master');
  const [type, setType] = useState('');
  const [rating, setRating] = useState('');
  const [reach, setReach] = useState('');
  const [location, setLocation] = useState('');
  const [niche, setNiche] = useState('');
  const [ageRange, setAgeRange] = useState('');
  const [gender, setGender] = useState('');
  const [sort, setSort] = useState('recent');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState([]);
  const [counts, setCounts] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [locations, setLocations] = useState([]);
  const [catalogs, setCatalogs] = useState(null);
  const [modal, setModal] = useState(null);     // 'influencer' | 'deal' | null
  const [menuOpen, setMenuOpen] = useState(false);
  const newBtnRef = useRef(null);
  // counts are scoped by every filter EXCEPT the type card, so a selected type's own count is the
  // denominator (was the all-types total: "Showing 100 of 1,683" on Micro).
  const shownOf = !counts ? null
    : !type ? counts.total
    : type === '__untyped__' ? counts.untyped
    : counts.counts?.[type];
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const { focusedIdx, setFocusedIdx } = useListNav(rows.length, (i) => {
    const r = rows[i]; if (r) router.push(`/influencers/detail/?id=${r.id}`);
  });

  // Scope params shared by the list + the type-count cards (everything but type).
  function scopeParams() {
    const p = { tab };
    if (rating) p.rating = rating;
    if (search) p.search = search;
    if (location) p.location = location;
    if (niche) p.niche = niche;
    if (ageRange) p.age_range = ageRange;
    if (gender) p.gender = gender;
    const b = REACH_BUCKETS.find(x => x.id === reach);
    if (b?.min != null) p.reach_min = b.min;
    if (b?.max != null) p.reach_max = b.max;
    return p;
  }

  // First page (replaces rows) whenever a filter/sort changes.
  useEffect(() => {
    if (!session) return;
    setLoading(true);
    const params = { ...scopeParams(), sort, limit: PAGE, offset: 0 };
    if (type) params.type = type;
    ignitionopsGet('getInfluencers', params, session)
      .then(r => setRows(r.influencers || []))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, type, rating, reach, location, niche, ageRange, gender, sort, search, session]);

  useEffect(() => {
    if (!session) return;
    ignitionopsGet('getInfluencerCounts', scopeParams(), session)
      .then(setCounts).catch(() => setCounts(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, rating, reach, location, niche, ageRange, gender, search, session]);

  // Location options for the filter dropdown — fetched once.
  useEffect(() => {
    if (!session) return;
    ignitionopsGet('getLocations', {}, session)
      .then(r => setLocations(r.locations || [])).catch(() => setLocations([]));
  }, [session]);

  // Catalogs — niche options for the filter dropdown.
  useEffect(() => {
    if (!session) return;
    ignitionopsGet('getCatalogs', {}, session).then(setCatalogs).catch(() => setCatalogs(null));
  }, [session]);

  function loadMore() {
    if (!session || loadingMore) return;
    setLoadingMore(true);
    const params = { ...scopeParams(), sort, limit: PAGE, offset: rows.length };
    if (type) params.type = type;
    ignitionopsGet('getInfluencers', params, session)
      .then(r => setRows(prev => [...prev, ...(r.influencers || [])]))
      .finally(() => setLoadingMore(false));
  }

  function toggleType(t) { setType(prev => (prev === t ? '' : t)); }

  const cardDefs = [
    { id: '',            label: 'All',     count: counts?.total,        always: true },
    { id: 'nano',        label: 'Nano',    count: counts?.counts?.nano,  always: true },
    { id: 'micro',       label: 'Micro',   count: counts?.counts?.micro, always: true },
    { id: 'macro',       label: 'Macro',   count: counts?.counts?.macro, always: true },
    { id: 'brand',       label: 'Brand',   count: counts?.counts?.brand },
    { id: 'store',       label: 'Store',   count: counts?.counts?.store },
    { id: '__untyped__', label: 'Untyped', count: counts?.untyped },
  ].filter(c => c.always || (c.count || 0) > 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header className="ig-up" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, letterSpacing: '.14em', color: 'var(--text-4)' }}>WORK · MASTER DATA</div>
          <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 32, fontWeight: 700, marginTop: 6 }}>Influencers</h1>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <Segmented
            options={TABS.map(t => ({ value: t.id, label: t.label }))}
            value={tab}
            onChange={setTab}
          />
          <div style={{ position: 'relative', marginLeft: 'auto' }}>
            <button ref={newBtnRef} onClick={() => setMenuOpen(o => !o)} style={newBtn}>
              <Plus size={15} strokeWidth={2.25} /> New <ChevronDown size={14} />
            </button>
            <Menu
              open={menuOpen}
              onClose={closeMenu}
              anchorRef={newBtnRef}
              width={200}
              items={[
                { label: 'Add influencer', onClick: () => setModal('influencer') },
                { label: 'Add deal',       onClick: () => setModal('deal') },
              ]}
            />
          </div>
        </div>
      </header>

      <BrokenLinksPanel session={session} />

      <div className="ig-up" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10, animationDelay: '80ms' }}>
        {cardDefs.map(c => {
          const active = type === c.id;
          return (
            <button
              key={c.id || 'all'}
              type="button"
              className="ig-card-hover"
              onClick={() => (c.id === '' ? setType('') : toggleType(c.id))}
              style={{
                ...typeCard,
                cursor: 'pointer',
                background: active ? 'rgba(255,107,0,.1)' : 'var(--surface)',
                border: `1px solid ${active ? '#FF6B00' : 'var(--border)'}`,
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 600, color: active ? 'var(--accent-hi)' : 'var(--text-3)' }}>
                {c.label}
              </div>
              <div style={typeCardValue}>
                {c.count == null ? '–' : Number(c.count).toLocaleString()}
              </div>
            </button>
          );
        })}
        <div
          style={typeCard}
          title={counts?.total_reach != null ? `${Number(counts.total_reach).toLocaleString()} total reach` : undefined}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-3)' }}>Total reach</div>
          <div style={typeCardValue}>
            {counts?.total_reach == null ? '–' : fmtReach(Number(counts.total_reach))}
          </div>
        </div>
      </div>

      <div className="ig-up" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', animationDelay: '120ms' }}>
        <SearchField
          placeholder="Search code, handle, name, phone, email…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <FilterSelect value={rating} onChange={e => setRating(e.target.value)}>
          <option value="">All ratings</option>
          <option value="green">Green</option>
          <option value="yellow">Yellow</option>
          <option value="red">Red</option>
          <option value="unrated">Unrated</option>
        </FilterSelect>
        <FilterSelect value={reach} onChange={e => setReach(e.target.value)}>
          {REACH_BUCKETS.map(b => <option key={b.id || 'all'} value={b.id}>{b.label}</option>)}
        </FilterSelect>
        <FilterSelect value={location} onChange={e => setLocation(e.target.value)}>
          <option value="">All locations</option>
          {locations.map(l => <option key={l} value={l}>{l}</option>)}
        </FilterSelect>
        <FilterSelect value={niche} onChange={e => setNiche(e.target.value)}>
          <option value="">All niches</option>
          {(catalogs?.category_options?.niche || []).map(n => <option key={n} value={n}>{n}</option>)}
        </FilterSelect>
        <FilterSelect value={ageRange} onChange={e => setAgeRange(e.target.value)}>
          <option value="">All ages</option>
          {(catalogs?.age_ranges || []).map(a => <option key={a} value={a}>{a}</option>)}
        </FilterSelect>
        <FilterSelect value={gender} onChange={e => setGender(e.target.value)}>
          <option value="">All genders</option>
          {(catalogs?.gender_majorities || []).map(g => <option key={g} value={g}>{GENDER_LABELS[g] || g}</option>)}
        </FilterSelect>
        <FilterSelect value={sort} onChange={e => setSort(e.target.value)}>
          {SORTS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
        </FilterSelect>
      </div>

      {loading ? <Spinner /> : (
        <>
        <TableCard
          columns={COLS}
          minWidth={1000}
          head={['Code', 'Channel', 'Type', 'Category', { label: 'Reach', align: 'right' }, 'Location', 'Rating']}
          style={{ animation: 'igUp 500ms 160ms var(--ease-out) backwards' }}
        >
          {rows.length === 0 && (
            <div style={{ padding: '18px', color: 'var(--text-3)', textAlign: 'center', fontSize: 14 }}>No results</div>
          )}
          {rows.map((r, i) => (
            <Row
              key={r.id}
              columns={COLS}
              index={i}
              animate
              focused={focusedIdx === i}
              onClick={() => router.push(`/influencers/detail/?id=${r.id}`)}
              onMouseEnter={() => setFocusedIdx(i)}
              style={{ padding: '10px 18px' }}
            >
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: 'var(--accent-hi)' }}>{r.influencer_code}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                <Avatar name={r.channel_name || r.person_name || r.influencer_code} seed={r.id} size={34} />
                <span style={{ minWidth: 0 }}>
                  <span style={ellipsis}>{r.channel_name || '—'}</span>
                  {r.person_name && <span style={{ display: 'block', fontSize: 12, color: 'var(--text-4)' }}>{r.person_name}</span>}
                </span>
              </span>
              <span>
                {r.influencer_type
                  ? <span style={typePill}>{r.influencer_type}</span>
                  : <span style={{ color: 'var(--text-4)' }}>—</span>}
              </span>
              <span style={{ ...ellipsis, fontWeight: 400, color: 'var(--text-2)' }}>{(r.categories || []).join(', ') || '—'}</span>
              <NumCell>{r.reach != null ? Number(r.reach).toLocaleString() : '—'}</NumCell>
              <span style={{ color: 'var(--text-2)', minWidth: 0 }}>{r.location || '—'}</span>
              <RatingDot rating={r.quality_rating} size={9} />
            </Row>
          ))}
        </TableCard>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', fontSize: 13, color: 'var(--text-4)' }}>
          <span>
            {shownOf != null
              ? `Showing ${rows.length.toLocaleString()} of ${Number(shownOf).toLocaleString()}`
              : `Showing ${rows.length.toLocaleString()}`}
          </span>
          {shownOf != null && rows.length < Number(shownOf) && (
            <button onClick={loadMore} disabled={loadingMore} className="ig-ghost-btn" style={{
              ...ghostBtn,
              cursor: loadingMore ? 'default' : 'pointer', opacity: loadingMore ? 0.6 : 1,
            }}>
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          )}
        </div>
        </>
      )}

      <NewInfluencerModal open={modal === 'influencer'} onClose={() => setModal(null)} session={session} />
      <NewDealModal open={modal === 'deal'} onClose={() => setModal(null)} session={session} />
    </div>
  );
}

// Table grid (prototype: 90 | 2fr | 90 | 1.4fr | 100 | 1fr | 100).
const COLS = '90px minmax(220px,2fr) 90px minmax(160px,1.4fr) 100px minmax(120px,1fr) 100px';
const ellipsis = { display: 'block', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const typePill = {
  display: 'inline-block', fontSize: 12, fontWeight: 600, padding: '3px 9px', borderRadius: 8,
  background: 'var(--chip-neutral)', color: 'var(--text-2)', textTransform: 'capitalize',
};
const typeCard = {
  textAlign: 'left', minWidth: 0, background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: 'var(--r-tile)', padding: '14px 16px', color: 'var(--text-1)', font: 'inherit',
};
const typeCardValue = { fontFamily: 'var(--font-mono)', fontSize: 24, fontWeight: 700, marginTop: 4, color: 'var(--text-1)' };
const newBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 6, height: 42, padding: '0 16px', background: 'var(--text-1)', color: 'var(--bg, #0e1015)',
  border: 'none', borderRadius: 12, fontSize: 14, fontWeight: 700, cursor: 'pointer',
};
const ghostBtn = {
  background: 'transparent', color: 'var(--text-1)', border: '1px solid var(--border-3)', borderRadius: 10,
  padding: '9px 16px', fontSize: 13, fontWeight: 600,
};

// Broken profile links worklist (S313, Reann approved 2026-08-26). `channel_link` had been
// collecting browser tab titles pasted instead of URLs — "(9) Instagram". The source forms now
// reject those, so this clears what is already stored.
//
// ⚠️ A suggestion is proposed, never applied automatically. instagram.com/<handle> derived from a
// display name could be a completely different person, and in an influencer CRM a link to a
// stranger is worse than a blank one. Every row needs a human click.
function BrokenLinksPanel({ session }) {
  const { showToast: toast } = useToast();
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(null);
  const [drafts, setDrafts] = useState({});

  function load() {
    if (!session) return;
    ignitionopsGet('getBrokenChannelLinks', {}, session).then(setData).catch(() => setData(null));
  }
  useEffect(load, [session]);

  async function save(row, value) {
    const err = channelLinkError(value);
    if (err) { toast(err, 'error'); return; }
    setBusy(row.id);
    try {
      await ignitionopsPost('updateInfluencer', {
        influencer_id: row.id, channel_link: normalizeChannelLink(value) || null,
      }, session);
      toast(`${row.influencer_code} updated`, 'success');
      // Recompute every count from the remaining rows. Decrementing only the headline left the
      // breakdown summing to the OLD total ("31 … 24 + 8"), which is a number contradicting the
      // number beside it — the same class of quietly-wrong figure this panel exists to clear.
      setData(d => {
        if (!d) return d;
        const rows = d.rows.filter(r => r.id !== row.id);
        return {
          ...d, rows,
          count: rows.length,
          suggestable: rows.filter(x => x.suggested).length,
          manual: rows.filter(x => !x.suggested && !x.blank).length,
          blank: rows.filter(x => x.blank).length,
        };
      });
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusy(null); }
  }

  if (!data || !data.count) return null;
  return (
    <div className="ig-up" style={{ animationDelay: '40ms' }}>
      <Banner
        tone="warning"
        icon={<Link2Off size={16} strokeWidth={1.75} />}
        lead={`${data.count} broken channel link${data.count === 1 ? '' : 's'}.`}
        action={open ? 'Hide' : 'Review →'}
        onAction={() => setOpen(o => !o)}
      >
        These profiles can't be opened from a deal until fixed.
      </Banner>
      {open && (
        <div style={{ marginTop: 8, border: '1px solid var(--border)', borderRadius: 'var(--r-row)', background: 'var(--surface)', overflow: 'hidden' }}>
          <div style={{ padding: '10px 16px', fontSize: 13, color: 'var(--text-3)', borderBottom: '1px solid var(--border)' }}>
            {data.suggestable} can be confirmed in one click{data.manual ? ` · ${data.manual} need typing` : ''}
          </div>
          <div style={{ maxHeight: 420, overflowY: 'auto' }}>
          {data.rows.map(r => (
            <div key={r.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 16px', borderTop: '1px solid var(--row-divider)', fontSize: 13, flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--accent-hi)', fontFamily: 'var(--font-mono)', fontWeight: 600, minWidth: 62 }}>{r.influencer_code}</span>
              <span style={{ color: 'var(--text-1)', minWidth: 140 }}>{r.channel_name || r.person_name || '—'}</span>
              <span style={{ color: 'var(--text-3)', minWidth: 70 }}>{r.platform || '—'}</span>
              <span style={{ color: 'var(--text-3)', fontStyle: 'italic', minWidth: 0, overflowWrap: 'anywhere' }} title="What is stored now">
                {r.blank ? '(blank)' : `“${r.current}”`}
              </span>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
                {r.suggested ? (
                  <>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-2)', overflowWrap: 'anywhere' }}>{r.suggested.replace('https://', '')}</span>
                    <button disabled={busy === r.id} onClick={() => save(r, r.suggested)}
                      style={{ padding: '4px 10px', background: '#FF6B00', color: '#0a0a0a', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                      {busy === r.id ? '…' : 'Use'}
                    </button>
                  </>
                ) : (
                  <>
                    <input placeholder="paste the profile URL"
                      value={drafts[r.id] || ''} onChange={e => setDrafts(d => ({ ...d, [r.id]: e.target.value }))}
                      style={{ width: 230, maxWidth: '100%', height: 30, background: 'var(--input)', color: 'var(--text-1)', border: '1px solid var(--border-2)', borderRadius: 8, padding: '0 10px', fontFamily: 'var(--font-mono)', fontSize: 12 }} />
                    <button disabled={busy === r.id || !(drafts[r.id] || '').trim()} onClick={() => save(r, drafts[r.id])}
                      className="ig-ghost-btn"
                      style={{ padding: '4px 10px', background: 'transparent', color: 'var(--text-1)', border: '1px solid var(--border-3)', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                      {busy === r.id ? '…' : 'Save'}
                    </button>
                  </>
                )}
              </span>
            </div>
          ))}
          </div>
        </div>
      )}
    </div>
  );
}
