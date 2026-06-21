'use client';
/* Performance — Instagram analytics for @legendoftoys (Tier 1).
   Pulled published media + insights + daily account metrics, reconciled
   against the planned Social calendar. Read via getSocialAnalytics;
   "Refresh from Instagram" fires syncSocialInsights (throttleops). */
import React, { useState, useEffect } from 'react';
import { useAuth } from '@throttle/auth';
import { AppShell } from '@/components/throttle/AppShell';
import { Card, PrimaryBtn } from '@/components/throttle/ui';
import { toast } from '@/components/throttle/ToastHost';
import ReachChart from '@/components/throttle/ReachChart';
import { fetchSocialAnalytics, syncSocialInsights } from '@/lib/throttleApi';

function fmtNum(n) {
  n = Number(n || 0);
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(Math.round(n));
}

function PerformanceScreen() {
  const { session } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

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
  const tiles = [
    { label: 'Followers', value: t.followers != null ? fmtNum(t.followers) : '—', accent: 'var(--yellow)' },
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
        <PrimaryBtn icon="refresh" onClick={refresh}>{syncing ? 'Syncing…' : 'Refresh from Instagram'}</PrimaryBtn>
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
                </Card>
              ))}
            </div>

            <Card style={{ marginBottom: 16 }}>
              <div className="eyebrow" style={{ padding: 0, marginBottom: 10 }}>Daily reach</div>
              <ReachChart series={series} />
            </Card>

            <Card>
              <div className="eyebrow" style={{ padding: 0, marginBottom: 12 }}>Top posts by reach</div>
              {top.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--t4)' }}>No posts synced yet — hit Refresh from Instagram.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {top.map(p => (
                    <a key={p.ig_media_id} href={p.permalink} target="_blank" rel="noreferrer"
                      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 8px', borderRadius: 'var(--r-sm)', textDecoration: 'none', borderBottom: '1px solid var(--border)' }}>
                      <span className="t-chip" data-on style={{ flexShrink: 0 }}>{(p.media_type || '').replace('_ALBUM', '').slice(0, 8) || 'POST'}</span>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: 'var(--t1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.caption || '(no caption)'}</span>
                      {!p.matched_post_id && <span style={{ fontSize: 9.5, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '0.06em', flexShrink: 0 }}>unplanned</span>}
                      <span className="num" style={{ flexShrink: 0, fontSize: 12, color: 'var(--t3)' }}>♥ {fmtNum(p.like_count)}</span>
                      <span className="num" style={{ flexShrink: 0, fontSize: 12, color: 'var(--t3)' }}>💬 {fmtNum(p.comments_count)}</span>
                      <span className="num" style={{ flexShrink: 0, fontSize: 13, fontWeight: 700, color: 'var(--yellow)', minWidth: 54, textAlign: 'right' }}>{fmtNum(p.reach)}</span>
                    </a>
                  ))}
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
