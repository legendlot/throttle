'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, Chip, useListNav, useToast } from '@throttle/ui';
import { ignitionopsGet } from '../../../lib/ignitionopsFetch.js';
import StageBadge from '../../../components/StageBadge.js';
import DealTypeBadge from '../../../components/DealTypeBadge.js';
import { STAGE_VALUES, STAGE_LABELS } from '../../../lib/stages.js';

// 'Live' is the terminal success stage (S214 ⑤) — the old 'Completed' tab is gone.
const TABS = [
  { id: 'all',       label: 'All',       filter: null },
  { id: 'live',      label: 'Live',      filter: 'live' },
  { id: 'scheduled', label: 'Scheduled', filter: 'scheduled' },
  { id: 'posting',   label: 'Draft rcvd', filter: 'posting' },
  { id: 'delivered', label: 'Delivered', filter: 'delivered' },
];

export default function EngagementsPage() {
  const { session } = useAuth();
  const { showToast: toast } = useToast();
  const router = useRouter();
  const [tab, setTab] = useState('all');
  const [type, setType] = useState('all');
  const [stages, setStages] = useState([]); // multi-select (#11)
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const { focusedIdx, setFocusedIdx } = useListNav(rows.length, (i) => {
    const r = rows[i]; if (r) router.push(`/engagements/detail/?id=${r.id}`);
  });

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setLoading(true);
    const base = { type };
    const tabFilter = TABS.find(t => t.id === tab)?.filter;
    if (tabFilter) base.stage = tabFilter;
    else if (stages.length) base.stages = stages.join(',');
    if (search) base.search = search;

    // Reann, 2026-08-18: "I can only see around 95 videos, but I should have close to 200."
    // This asked for ONE page of 100 and stopped, so everything past the 100th row was
    // invisible with nothing on screen to say so — there were 233. The worker caps a page at
    // 200 and returns no total, so "a short page is the last page" is the only end signal
    // available; walk the pages until one comes back short.
    (async () => {
      const PAGE = 200;
      const MAX_PAGES = 25;   // 5,000-row backstop against a runaway loop, not an expected ceiling
      const all = [];
      for (let p = 0; p < MAX_PAGES; p++) {
        const r = await ignitionopsGet('getEngagements', { ...base, limit: PAGE, offset: p * PAGE }, session);
        if (cancelled) return;
        const batch = r.engagements || [];
        all.push(...batch);
        if (batch.length < PAGE) break;
      }
      if (!cancelled) setRows(all);
    })()
      // Paging widens the window in which the filters can change mid-flight, so every state
      // write is guarded — otherwise page 2 of the previous query lands on top of page 1 of
      // the current one and the list silently mixes two filters.
      .catch(e => { if (!cancelled) toast(e.message || 'Failed to load engagements', 'error'); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [tab, type, stages, search, session]);

  function toggleStage(s) {
    setStages(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]);
  }

  return (
    <div>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          Engagements
        </h1>
        <button
          onClick={() => router.push('/engagements/new/')}
          style={{
            padding: '8px 14px', background: '#FF6B00', color: '#fff',
            border: 'none', borderRadius: 'var(--radius-sm)',
            fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700,
            letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer',
          }}
        >+ New Deal</button>
      </header>

      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {TABS.map(t => <Chip key={t.id} active={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</Chip>)}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
        <input
          data-search-primary
          placeholder="Search engagement #, video link, tracking, order…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={inputStyle(280)}
        />
        <select value={type} onChange={e => setType(e.target.value)} style={inputStyle(140)}>
          <option value="all">All types</option>
          <option value="video_tracking">Video</option>
          <option value="ugc">UGC</option>
        </select>
      </div>

      {tab === 'all' && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          {STAGE_VALUES.map(s => (
            <Chip key={s} active={stages.includes(s)} onClick={() => toggleStage(s)}>{STAGE_LABELS[s]}</Chip>
          ))}
          {stages.length > 0 && (
            <button onClick={() => setStages([])} style={{ marginLeft: 4, padding: '4px 8px', background: 'transparent', color: 'var(--text-3)', border: 'none', fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer', textDecoration: 'underline' }}>clear</button>
          )}
        </div>
      )}

      {loading ? <Spinner /> : (
        <div style={{
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)', overflow: 'hidden',
        }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
                <th style={th}>Engagement #</th>
                <th style={th}>Influencer</th>
                <th style={th}>Type</th>
                <th style={th}>Stage</th>
                <th style={th}>Deal</th>
                <th style={th}>Product</th>
                <th style={th}>Post date</th>
                <th style={th}>Total cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={8} style={{ ...td, color: 'var(--text-3)', textAlign: 'center' }}>No engagements</td></tr>
              )}
              {rows.map((r, i) => (
                <tr key={r.id}
                  onClick={() => router.push(`/engagements/detail/?id=${r.id}`)}
                  style={{
                    cursor: 'pointer', borderTop: '1px solid var(--border)',
                    background: focusedIdx === i ? 'var(--surface-2)' : 'transparent',
                    outline: focusedIdx === i ? '2px solid #FF6B00' : 'none', outlineOffset: '-2px',
                  }}
                  onMouseEnter={() => setFocusedIdx(i)}
                >
                  <td style={td}><span style={{ color: '#FF6B00', fontWeight: 600 }}>{r.engagement_no}</span></td>
                  <td style={td}>
                    <div>{r.influencer?.channel_name || '—'}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{r.influencer?.influencer_code}</div>
                  </td>
                  <td style={td}>{r.engagement_type === 'ugc' ? 'UGC' : 'Video'}</td>
                  <td style={td}><StageBadge stage={r.stage} /></td>
                  <td style={td}><DealTypeBadge dealType={r.deal_type} /></td>
                  <td style={td}>{r.product_variant || r.product_code || '—'}</td>
                  <td style={td}>{r.post_date || '—'}</td>
                  <td style={td}>₹{Number(r.total_cost || 0).toLocaleString()}</td>
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
