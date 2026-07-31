'use client';
/* Performance — Instagram analytics for @legendoftoys (Tier 1).
   Pulled published media + insights + daily account metrics, reconciled
   against the planned Social calendar. Read via getSocialAnalytics;
   "Refresh from Instagram" fires syncSocialInsights (throttleops).
   A time filter (Today / This week / This month / Custom) drives the daily
   reach graph window + the follower-gain figure; the post-engagement tiles
   stay as lifetime/all-post totals. */
import React, { useState, useEffect, useMemo } from 'react';
import { useAuth } from '@throttle/auth';
import { AppShell } from '@/components/throttle/AppShell';
import { Card, PrimaryBtn } from '@/components/throttle/ui';
import { toast } from '@/components/throttle/ToastHost';
import ReachChart from '@/components/throttle/ReachChart';
import IgComments from '@/components/throttle/IgComments';
import { fetchSocialAnalytics, syncSocialInsights } from '@/lib/throttleApi';

function fmtNum(n) {
  n = Number(n || 0);
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(Math.round(n));
}

// ── IST date helpers (series dates are 'YYYY-MM-DD' IST; string compare is safe) ──
function todayIST() {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function prettyDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

const FILTERS = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This week' },
  { key: 'month', label: 'This month' },
  { key: 'custom', label: 'Custom' },
];
const FILTER_NOUN = { today: 'today', week: 'this week', month: 'this month', custom: 'in range' };

// Resolve a filter mode → { from, to } inclusive IST date strings.
function windowFor(mode, custom) {
  const today = todayIST();
  if (mode === 'today') return { from: today, to: today };
  if (mode === 'week') {
    const d = new Date(today + 'T00:00:00Z');
    const offset = (d.getUTCDay() + 6) % 7; // Mon = 0
    return { from: addDays(today, -offset), to: today };
  }
  if (mode === 'month') return { from: today.slice(0, 7) + '-01', to: today };
  // custom
  const from = custom.from || today;
  const to = custom.to || today;
  return from <= to ? { from, to } : { from: to, to: from };
}

// Net follower change across [from,to]. Baseline = last snapshot strictly before
// `from`; if none exists yet (sync history is short), fall back to the earliest
// in-window snapshot and flag it via `since`. null when <2 usable snapshots.
function followerGain(series, from, to) {
  const snaps = (series || [])
    .filter(r => Number(r.follower_count) > 0)
    .map(r => ({ date: r.date, v: Number(r.follower_count) }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (snaps.length < 2) return { gain: null, since: null };
  const endRow = [...snaps].reverse().find(s => s.date <= to);
  if (!endRow) return { gain: null, since: null };
  let baseRow = [...snaps].reverse().find(s => s.date < from);
  let since = null;
  if (!baseRow) {
    baseRow = snaps.find(s => s.date >= from && s.date < endRow.date) || null;
    since = baseRow ? baseRow.date : null;
  }
  if (!baseRow || baseRow.date === endRow.date) return { gain: null, since: null };
  return { gain: endRow.v - baseRow.v, since };
}

function FilterBar({ mode, setMode, custom, setCustom }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', gap: 3, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: 3 }}>
        {FILTERS.map(f => {
          const on = mode === f.key;
          return (
            <button key={f.key} type="button" onClick={() => setMode(f.key)} className="num"
              style={{ padding: '5px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 11.5,
                letterSpacing: '0.04em', textTransform: 'uppercase', transition: 'background 140ms, color 140ms',
                background: on ? 'var(--yellow)' : 'transparent', color: on ? '#161318' : 'var(--t3)', fontWeight: on ? 700 : 600 }}>
              {f.label}
            </button>
          );
        })}
      </div>
      {mode === 'custom' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="date" value={custom.from} max={custom.to || todayIST()} onChange={e => setCustom(c => ({ ...c, from: e.target.value }))}
            style={dateInputStyle} />
          <span style={{ color: 'var(--t4)', fontSize: 12 }}>→</span>
          <input type="date" value={custom.to} max={todayIST()} min={custom.from || undefined} onChange={e => setCustom(c => ({ ...c, to: e.target.value }))}
            style={dateInputStyle} />
        </div>
      )}
    </div>
  );
}
const dateInputStyle = {
  background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)',
  color: 'var(--t1)', fontSize: 12, padding: '5px 8px', fontFamily: 'var(--font-mono, monospace)', colorScheme: 'dark',
};

function PerformanceScreen() {
  const { session, role } = useAuth();
  // Mirrors throttleops' gate on replyIgComment (lead/admin) so the Reply control never
  // appears where it would 403. The worker stays the authority — this only avoids offering
  // an action that cannot succeed. Reading the thread is member+, hence a separate flag.
  const canReplyIg = ['lead', 'admin'].includes(role);
  const [openComments, setOpenComments] = useState(null);   // ig_media_id | null
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [mode, setMode] = useState('month'); // MTD default
  const [custom, setCustom] = useState({ from: todayIST().slice(0, 7) + '-01', to: todayIST() });

  const load = React.useCallback(async () => {
    if (!session) { setLoading(false); return; }
    const d = await fetchSocialAnalytics(session);
    setData(d); setLoading(false);
  }, [session]);
  useEffect(() => { load(); }, [load]);

  async function refresh() {
    if (!session || syncing) return;
    setSyncing(true);
    try {
      const r = await syncSocialInsights(session);
      toast(`Synced ${r?.media_upserted ?? 0} posts · ${r?.insights_synced ?? 0} insights${r?.reconciled ? ` · ${r.reconciled} reconciled` : ''}`, 'ok', 'send');
      await load();
    } catch (e) {
      toast('Sync failed — ' + (e?.message || 'try again'), 'warn', 'alert');
    } finally { setSyncing(false); }
  }

  const t = data?.totals || {};
  const series = data?.account_series || [];
  const top = data?.top_posts || [];

  const { from, to } = useMemo(() => windowFor(mode, custom), [mode, custom]);
  const windowSeries = useMemo(() => series.filter(r => r.date >= from && r.date <= to), [series, from, to]);
  const fg = useMemo(() => followerGain(series, from, to), [series, from, to]);

  const noun = FILTER_NOUN[mode];
  const rangeLabel = from === to ? prettyDate(from) : `${prettyDate(from)} – ${prettyDate(to)}`;
  let followerSub = null;
  if (t.followers != null) {
    if (fg.gain == null) {
      followerSub = { text: `— ${noun}`, tone: 'muted' };
    } else {
      const sign = fg.gain > 0 ? '+' : fg.gain < 0 ? '−' : '±';
      const label = fg.since ? `since ${prettyDate(fg.since)}` : noun;
      followerSub = { text: `${sign}${fmtNum(Math.abs(fg.gain))} ${label}`, tone: fg.gain > 0 ? 'up' : fg.gain < 0 ? 'down' : 'muted' };
    }
  }
  const subColor = { up: '#39D98A', down: '#E1306C', muted: 'var(--t4)' };

  const tiles = [
    { label: 'Followers', value: t.followers != null ? fmtNum(t.followers) : '—', accent: 'var(--yellow)', sub: followerSub },
    { label: 'Reach · 30d', value: fmtNum(t.reach_30d), accent: '#E1306C' },
    { label: 'Posts tracked', value: fmtNum(t.posts), accent: 'var(--t2)' },
    { label: 'Reconciled', value: `${t.matched || 0}/${t.posts || 0}`, accent: 'var(--t2)' },
    { label: 'Likes', value: fmtNum(t.likes), accent: 'var(--t2)' },
    { label: 'Comments', value: fmtNum(t.comments), accent: 'var(--t2)' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexShrink: 0, flexWrap: 'wrap', gap: 10 }}>
        <span className="eyebrow" style={{ padding: 0 }}>@legendoftoys · Instagram</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <FilterBar mode={mode} setMode={setMode} custom={custom} setCustom={setCustom} />
          <PrimaryBtn icon="refresh" onClick={refresh}>{syncing ? 'Syncing…' : 'Refresh from Instagram'}</PrimaryBtn>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, paddingRight: 4 }}>
        {loading ? (
          <div style={{ color: 'var(--t3)', fontSize: 13, padding: 24 }}>Loading…</div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
              {tiles.map(tl => (
                <Card key={tl.label} pad={0} style={{ flex: '1 1 140px', minWidth: 130, padding: '14px 16px', position: 'relative', overflow: 'hidden' }}>
                  <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: tl.accent }} />
                  <div className="eyebrow" style={{ padding: 0, marginBottom: 7 }}>{tl.label}</div>
                  <div className="num" style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 24, color: 'var(--t1)', lineHeight: 1 }}>{tl.value}</div>
                  {tl.sub && (
                    <div className="num" style={{ marginTop: 6, fontSize: 11.5, fontWeight: 700, color: subColor[tl.sub.tone] }}>{tl.sub.text}</div>
                  )}
                </Card>
              ))}
            </div>

            <Card style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10, gap: 8, flexWrap: 'wrap' }}>
                <div className="eyebrow" style={{ padding: 0 }}>Daily reach · {FILTERS.find(f => f.key === mode)?.label}</div>
                <div className="num" style={{ fontSize: 11, color: 'var(--t4)' }}>{rangeLabel}</div>
              </div>
              <ReachChart series={windowSeries} />
            </Card>

            <Card>
              <div className="eyebrow" style={{ padding: 0, marginBottom: 12 }}>Top posts by reach</div>
              {top.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--t4)' }}>No posts synced yet — hit Refresh from Instagram.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {top.map(p => {
                    const open = openComments === p.ig_media_id;
                    return (
                    <div key={p.ig_media_id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 8px' }}>
                        <span className="t-chip" data-on style={{ flexShrink: 0 }}>{(p.media_type || '').replace('_ALBUM', '').slice(0, 8) || 'POST'}</span>
                        <a href={p.permalink} target="_blank" rel="noreferrer"
                          style={{ flex: 1, minWidth: 0, fontSize: 13, color: 'var(--t1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textDecoration: 'none' }}>{p.caption || '(no caption)'}</a>
                        {!p.matched_post_id && <span style={{ fontSize: 9.5, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '0.06em', flexShrink: 0 }}>unplanned</span>}
                        <span className="num" style={{ flexShrink: 0, fontSize: 12, color: 'var(--t3)' }}>♥ {fmtNum(p.like_count)}</span>
                        {/* The comment count is the affordance — a separate button would be a
                            second click target for the same intent. Zero-comment posts stay
                            inert rather than opening an empty panel. */}
                        <button className="num" disabled={!Number(p.comments_count)}
                          title={Number(p.comments_count) ? (open ? 'Hide comments' : 'Read + reply to comments') : 'No comments on this post'}
                          onClick={() => setOpenComments(open ? null : p.ig_media_id)}
                          style={{ flexShrink: 0, fontSize: 12, background: 'none', border: 'none', padding: 0,
                                   color: open ? 'var(--yellow)' : 'var(--t3)',
                                   cursor: Number(p.comments_count) ? 'pointer' : 'default',
                                   opacity: Number(p.comments_count) ? 1 : 0.45 }}>
                          💬 {fmtNum(p.comments_count)}
                        </button>
                        <span className="num" style={{ flexShrink: 0, fontSize: 13, fontWeight: 700, color: 'var(--yellow)', minWidth: 54, textAlign: 'right' }}>{fmtNum(p.reach)}</span>
                      </div>
                      {open && (
                        <div style={{ padding: '2px 8px 12px 8px' }}>
                          <IgComments session={session} igMediaId={p.ig_media_id}
                            canReply={canReplyIg} expectedCount={Number(p.comments_count) || 0} />
                        </div>
                      )}
                    </div>
                    );
                  })}
                </div>
              )}
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

export default function PerformancePage() {
  return <AppShell route="performance"><PerformanceScreen /></AppShell>;
}
