'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, Chip, useListNav, useToast } from '@throttle/ui';
import { Plus, ChevronDown } from 'lucide-react';
import { ignitionopsGet, ignitionopsPost } from '../../../lib/ignitionopsFetch.js';
import { channelLinkError, normalizeChannelLink } from '../../../lib/channelLink.js';
import RatingBadge from '../../../components/RatingBadge.js';
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
    <div>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1 style={{
          fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700,
          letterSpacing: '0.04em', textTransform: 'uppercase',
        }}>Influencers</h1>
        <div style={{ position: 'relative' }}>
          <button onClick={() => setMenuOpen(o => !o)} style={newBtn}>
            <Plus size={15} strokeWidth={2.25} /> New <ChevronDown size={14} />
          </button>
          {menuOpen && (
            <>
              <div onClick={() => setMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 20 }} />
              <div style={menuStyle}>
                <button style={menuItem} onClick={() => { setMenuOpen(false); setModal('influencer'); }}>Add Influencer</button>
                <button style={menuItem} onClick={() => { setMenuOpen(false); setModal('deal'); }}>Add Deal</button>
              </div>
            </>
          )}
        </div>
      </header>

      <BrokenLinksPanel session={session} />

      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {TABS.map(t => (
          <Chip key={t.id} active={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</Chip>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        {cardDefs.map(c => {
          const active = type === c.id;
          return (
            <button
              key={c.id || 'all'}
              type="button"
              onClick={() => (c.id === '' ? setType('') : toggleType(c.id))}
              style={{
                flex: '1 1 120px', minWidth: 110, textAlign: 'left', cursor: 'pointer',
                background: active ? 'rgba(255,107,0,0.08)' : 'var(--surface)',
                border: `1px solid ${active ? '#FF6B00' : 'var(--border)'}`,
                borderRadius: 'var(--radius-md)', padding: '12px 14px',
              }}
            >
              <div style={{ fontSize: 11, color: active ? '#FF6B00' : 'var(--text-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600 }}>
                {c.label}
              </div>
              <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-1)', fontFamily: 'var(--font-cond)', marginTop: 2 }}>
                {c.count == null ? '–' : c.count.toLocaleString()}
              </div>
            </button>
          );
        })}
        <div
          style={{
            flex: '1 1 120px', minWidth: 110, textAlign: 'left',
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)', padding: '12px 14px',
          }}
          title={counts?.total_reach != null ? `${counts.total_reach.toLocaleString()} total reach` : undefined}
        >
          <div style={{ fontSize: 11, color: 'var(--text-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600 }}>
            Total reach
          </div>
          <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-1)', fontFamily: 'var(--font-cond)', marginTop: 2 }}>
            {counts?.total_reach == null ? '–' : fmtReach(counts.total_reach)}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
        <input
          data-search-primary
          placeholder="Search code, handle, name, phone, email…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={inputStyle(280)}
        />
        <select value={rating} onChange={e => setRating(e.target.value)} style={inputStyle(140)}>
          <option value="">All ratings</option>
          <option value="green">Green</option>
          <option value="yellow">Yellow</option>
          <option value="red">Red</option>
          <option value="unrated">Unrated</option>
        </select>
        <select value={reach} onChange={e => setReach(e.target.value)} style={inputStyle(150)}>
          {REACH_BUCKETS.map(b => <option key={b.id || 'all'} value={b.id}>{b.label}</option>)}
        </select>
        <select value={location} onChange={e => setLocation(e.target.value)} style={inputStyle(170)}>
          <option value="">All locations</option>
          {locations.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
        <select value={niche} onChange={e => setNiche(e.target.value)} style={inputStyle(160)}>
          <option value="">All niches</option>
          {(catalogs?.category_options?.niche || []).map(n => <option key={n} value={n}>{n}</option>)}
        </select>
        <select value={ageRange} onChange={e => setAgeRange(e.target.value)} style={inputStyle(130)}>
          <option value="">All ages</option>
          {(catalogs?.age_ranges || []).map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        <select value={gender} onChange={e => setGender(e.target.value)} style={inputStyle(150)}>
          <option value="">All genders</option>
          {(catalogs?.gender_majorities || []).map(g => <option key={g} value={g}>{GENDER_LABELS[g] || g}</option>)}
        </select>
        <select value={sort} onChange={e => setSort(e.target.value)} style={inputStyle(180)}>
          {SORTS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </div>

      {loading ? <Spinner /> : (
        <>
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
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, gap: 12 }}>
          <span style={{ fontSize: 12, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
            {counts?.total != null
              ? `Showing ${rows.length.toLocaleString()} of ${counts.total.toLocaleString()}`
              : `Showing ${rows.length.toLocaleString()}`}
          </span>
          {counts?.total != null && rows.length < counts.total && (
            <button onClick={loadMore} disabled={loadingMore} style={{
              background: 'var(--surface-2)', color: 'var(--text-1)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
              padding: '8px 16px', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700,
              letterSpacing: '0.06em', textTransform: 'uppercase',
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

const th = { padding: '10px 12px', fontSize: 11, color: 'var(--text-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600 };
const td = { padding: '10px 12px' };
const newBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 6, background: '#FF6B00', color: '#fff',
  border: 'none', borderRadius: 'var(--radius-sm)', padding: '8px 14px',
  fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700,
  letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer',
};
const menuStyle = {
  position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 21,
  background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
  minWidth: 180, overflow: 'hidden', boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
};
const menuItem = {
  display: 'block', width: '100%', textAlign: 'left', background: 'transparent',
  color: 'var(--text-1)', border: 'none', borderBottom: '1px solid var(--border)',
  padding: '10px 14px', fontFamily: 'var(--font-mono)', fontSize: 13, cursor: 'pointer',
};
function inputStyle(w) {
  return {
    background: 'var(--surface-2)', color: 'var(--text-1)',
    border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
    padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 13,
    width: w,
  };
}

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
    <div style={{ marginBottom: 12, border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: 'var(--surface)' }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-1)', fontFamily: 'var(--font-mono)', fontSize: 12, textAlign: 'left' }}>
        <span style={{ color: '#FF6B00', fontWeight: 700 }}>{data.count}</span>
        <span>profiles have no usable channel link</span>
        <span style={{ color: 'var(--text-3)' }}>
          · {data.suggestable} can be confirmed in one click{data.manual ? ` · ${data.manual} need typing` : ''}
        </span>
        <span style={{ marginLeft: 'auto', color: 'var(--text-3)' }}>{open ? 'hide' : 'fix these'}</span>
      </button>
      {open && (
        <div style={{ borderTop: '1px solid var(--border)', maxHeight: 420, overflowY: 'auto' }}>
          {data.rows.map(r => (
            <div key={r.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid var(--border)', fontSize: 12, flexWrap: 'wrap' }}>
              <span style={{ color: '#FF6B00', fontFamily: 'var(--font-mono)', minWidth: 62 }}>{r.influencer_code}</span>
              <span style={{ color: 'var(--text-1)', minWidth: 140 }}>{r.channel_name || r.person_name || '—'}</span>
              <span style={{ color: 'var(--text-3)', minWidth: 70 }}>{r.platform || '—'}</span>
              <span style={{ color: 'var(--text-3)', fontStyle: 'italic' }} title="What is stored now">
                {r.blank ? '(blank)' : `“${r.current}”`}
              </span>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
                {r.suggested ? (
                  <>
                    <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-2)' }}>{r.suggested.replace('https://', '')}</span>
                    <button disabled={busy === r.id} onClick={() => save(r, r.suggested)}
                      style={{ padding: '3px 9px', background: '#FF6B00', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
                      {busy === r.id ? '…' : 'Use'}
                    </button>
                  </>
                ) : (
                  <>
                    <input placeholder="paste the profile URL"
                      value={drafts[r.id] || ''} onChange={e => setDrafts(d => ({ ...d, [r.id]: e.target.value }))}
                      style={{ width: 230, background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '4px 8px', fontFamily: 'var(--font-mono)', fontSize: 11 }} />
                    <button disabled={busy === r.id || !(drafts[r.id] || '').trim()} onClick={() => save(r, drafts[r.id])}
                      style={{ padding: '3px 9px', background: 'var(--surface-3)', color: 'var(--text-1)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer' }}>
                      {busy === r.id ? '…' : 'Save'}
                    </button>
                  </>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
