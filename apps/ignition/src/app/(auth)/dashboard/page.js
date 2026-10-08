'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { AlertTriangle } from 'lucide-react';
import { ignitionopsGet, ignitionopsPost } from '../../../lib/ignitionopsFetch.js';
import { STAGE_LABELS, HAPPY_PATH } from '../../../lib/stages.js';
import { UGC_STAGE_LABELS, UGC_HAPPY_PATH, UGC_TERMINAL } from '../../../lib/ugcStages.js';
import { productLabel } from '../../../lib/productLabel.js';
import { istMonth } from '../../../lib/istDate.js';
import {
  Card, Segmented, Tile, StagePill, RatingDot, Avatar, Row, ProgressBar, viewsTone, spendTone,
} from '../../../components/ui/index.js';

const OVERDUE_DAYS = 7;

// Pipeline bar segment colours (README "Pipeline bar segment colours"); posting = the .ig-fuse stripe.
const PIPE_COLORS = {
  proposed: 'var(--state-warning)', planning: 'var(--text-5)', shipped: 'var(--info-bar)', delivered: 'var(--brand-green)',
  posting: 'var(--accent)', scheduled: 'var(--info-bar-2)', live: 'var(--state-success-fg)',
  // UGC vocabulary (lib/ugcStages.js): outreach sits where planning does, draft is UGC's "draft in".
  outreach: 'var(--text-5)', draft: 'var(--accent)',
};
// UGC deals run on their own stage names; "active" = not live and not an exit.
// (proposed excluded, as in the video ACTIVE list.)
const UGC_ACTIVE_STAGES = ['outreach', 'shipped', 'delivered', 'draft', 'paused', 'vault'].filter(k => !UGC_TERMINAL.has(k));
const isDraftIn = k => k === 'posting' || k === 'draft';
// Same list as the worker's ACTIVE count (getKpis), so "active deals" agrees with the old Active tile.
const ACTIVE_STAGES = ['planning', 'agreed', 'shipped', 'delivered', 'scheduled', 'posting', 'delayed', 'on_hold'];
const MODES = [{ value: 'video', label: 'Video' }, { value: 'ugc', label: 'UGC' }, { value: 'all', label: 'All' }];
const OVERDUE_COLS = '36px minmax(0,1.4fr) minmax(0,1fr) 110px 70px 50px';

const n0 = v => (v == null || isNaN(Number(v)) ? 0 : Number(v));
const inr = v => `₹${Math.round(n0(v)).toLocaleString('en-IN')}`;
function inrShort(v) {
  const n = n0(v);
  if (Math.abs(n) >= 1e7) return `₹${+(n / 1e7).toFixed(2)}Cr`;
  if (Math.abs(n) >= 1e5) return `₹${+(n / 1e5).toFixed(2)}L`;
  return inr(n);
}
function viewsShort(v) {
  const n = n0(v);
  if (Math.abs(n) >= 1e6) return `${+(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `${+(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString('en-IN');
}

// IST "TUE 07 OCT · WEEK 41" + greeting by IST hour (same +5:30 shift as lib/istDate.js).
function istHeader(now = Date.now()) {
  const d = new Date(now + 5.5 * 3600 * 1000);
  const day = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][d.getUTCDay()];
  const mon = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][d.getUTCMonth()];
  // ISO week: the Thursday of this week decides the year.
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const week = Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
  const h = d.getUTCHours();
  return {
    eyebrow: `${day} ${String(d.getUTCDate()).padStart(2, '0')} ${mon} · WEEK ${week}`,
    greeting: h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : 'Evening',
  };
}

export default function DashboardPage() {
  const { session, perms, user } = useAuth();
  const { showToast: toast } = useToast();
  const router = useRouter();
  const canManage = !!perms?.ignition_manage;
  const [kpis, setKpis] = useState(null);
  const [overdue, setOverdue] = useState(null);
  const [monthRow, setMonthRow] = useState(undefined); // undefined=loading, null=no target
  const [quality, setQuality] = useState(null);
  const [err, setErr] = useState(null);
  const [flagging, setFlagging] = useState(false);
  const [flaggedN, setFlaggedN] = useState(null);
  const [mode, setMode] = useState('video');

  const load = useCallback(() => {
    if (!session) return;
    ignitionopsGet('getKpis', {}, session).then(setKpis).catch(e => setErr(e.message));
    ignitionopsGet('getOverdueEngagements', { days: OVERDUE_DAYS }, session)
      .then(r => setOverdue(r.overdue || [])).catch(() => setOverdue(null));
    ignitionopsGet('getQualityFlags', {}, session).then(setQuality).catch(() => setQuality(null));
    const cm = istMonth();
    ignitionopsGet('getMonthlyTargets', {}, session)
      .then(r => setMonthRow((r.months || []).find(m => m.month === cm) || null))
      .catch(() => setMonthRow(null));
  }, [session]);
  useEffect(load, [load]);

  async function flagAll() {
    setFlagging(true);
    try {
      const r = await ignitionopsPost('flagOverdueRatings', { days: OVERDUE_DAYS }, session);
      toast(r.flagged > 0 ? `Flagged ${r.flagged} influencer${r.flagged === 1 ? '' : 's'} red` : 'Nothing to flag (all already rated)', 'success');
      setFlaggedN(r.flagged > 0 ? r.flagged : null);
      load();
    } catch (e) { setFlaggedN(null); toast(e.message, 'error'); }
    finally { setFlagging(false); }
  }

  if (err) return <div style={{ color: 'var(--state-error-fg)', padding: 16 }}>Error: {err}</div>;
  if (!kpis) return <Spinner />;

  // stage_counts / committed arrive with the W1 worker. On the older worker they are undefined:
  // the page then shows company-wide (All) figures, no toggle and no per-stage numbers.
  const hasPipe = !!kpis.stage_counts;
  const m = hasPipe ? mode : 'all';
  const sc = hasPipe ? (kpis.stage_counts[m] || {}) : null;
  const et = kpis.engagement_totals || {};
  const ugc = kpis.ugc_summary || {};
  // engagement_totals and ugc_summary come from the same scan, so Video = total − UGC exactly.
  const views = m === 'all' ? n0(et.views) : m === 'ugc' ? n0(ugc.views) : n0(et.views) - n0(ugc.views);
  const paid = m === 'all' ? n0(et.paid_views) : m === 'ugc' ? n0(ugc.paid_views) : n0(et.paid_views) - n0(ugc.paid_views);
  const live = sc ? n0(sc.live) : n0(kpis.live);
  // UGC rows run on UGC stage names, so each bucket is summed over its own active list; All = both.
  const sumOf = (bucket, keys) => keys.reduce((s, k) => s + n0(bucket?.[k]), 0);
  const active = !sc ? n0(kpis.active)
    : m === 'ugc' ? sumOf(sc, UGC_ACTIVE_STAGES)
    : m === 'all' ? sumOf(kpis.stage_counts.video, ACTIVE_STAGES) + sumOf(kpis.stage_counts.ugc, UGC_ACTIVE_STAGES)
    : sumOf(sc, ACTIVE_STAGES);
  const committed = kpis.committed ? kpis.committed[m] : null;
  const pathKeys = m === 'ugc' ? ['proposed', ...UGC_HAPPY_PATH]
    : m === 'all' ? [...HAPPY_PATH, ...UGC_HAPPY_PATH.filter(k => !HAPPY_PATH.includes(k) && n0(sc?.[k]) > 0)] : HAPPY_PATH;
  const pipe = sc ? pathKeys.map(k => ({ k, n: n0(sc[k]) })) : [];
  const pipeTotal = pipe.reduce((s, p) => s + p.n, 0);

  // A failed overdue fetch leaves `overdue` null — fall back to getKpis' count, never "All clear".
  const lateN = overdue ? overdue.length : n0(kpis.overdue);
  const drafts = sc ? n0(sc.posting) + n0(sc.draft) : 0;
  const headline = lateN > 0 ? `${lateN} post${lateN === 1 ? ' is' : 's are'} late.`
    : drafts > 0 ? `${drafts} draft${drafts === 1 ? '' : 's'} to review.` : 'All clear.';
  const { eyebrow, greeting } = istHeader();
  const firstName = (user?.full_name || '').trim().split(/\s+/)[0];

  const hasTarget = monthRow && (monthRow.target_views != null || monthRow.budget_amount != null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, paddingBottom: 40, minWidth: 0 }}>
      <div className="ig-up" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, letterSpacing: 'var(--tracking-eyebrow)', color: 'var(--text-4)' }}>{eyebrow}</div>
          <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 32, fontWeight: 700, marginTop: 6, lineHeight: 1.15 }}>
            {greeting}{firstName ? `, ${firstName}` : ''}. <span style={{ color: 'var(--accent)' }}>{headline}</span>
          </h1>
        </div>
        {hasPipe && <Segmented options={MODES} value={mode} onChange={setMode} />}
      </div>

      <Card as="a" href="/engagements" hero hover className="ig-up" style={{ animationDelay: '80ms' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: pipe.length ? 16 : 0 }}>
          <span style={{ fontFamily: 'var(--font-cond)', fontSize: 17, fontWeight: 700 }}>Pipeline</span>
          <span style={{ fontSize: 14, color: 'var(--text-3)' }}>
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-1)', fontWeight: 700 }}>{active}</span> active deals
            {committed != null && <> · {inrShort(committed)} committed</>}
          </span>
        </div>
        {pipe.length > 0 && (
          <>
            {pipeTotal > 0 && (
              <div style={{ display: 'flex', gap: 4, height: 14, borderRadius: 7, overflow: 'hidden' }}>
                {pipe.filter(p => p.n > 0).map((p, i) => (
                  <div key={p.k} className={isDraftIn(p.k) ? 'ig-fuse' : 'ig-growx'} style={{
                    flex: p.n, minWidth: 4, background: isDraftIn(p.k) ? undefined : PIPE_COLORS[p.k],
                    transition: 'flex 500ms var(--ease-out)', animationDelay: isDraftIn(p.k) ? undefined : `${200 + i * 60}ms`,
                  }} />
                ))}
              </div>
            )}
            {/* Labels sit in equal columns, not flex = count: one big stage (Live) would squeeze
                every other label to nothing on real data. */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(84px, 1fr))', gap: '10px 4px', marginTop: 14 }}>
              {pipe.map(p => {
                const hot = isDraftIn(p.k);
                return (
                  <div key={p.k} style={{ minWidth: 0 }}>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 700, color: hot ? 'var(--accent-hi)' : 'var(--text-1)' }}>{p.n}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: hot ? 'var(--accent-hi)' : 'var(--text-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: PIPE_COLORS[p.k], flexShrink: 0 }} />
                      {(m === 'ugc' ? UGC_STAGE_LABELS[p.k] : STAGE_LABELS[p.k] || UGC_STAGE_LABELS[p.k]) || p.k}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
        {/* Organic = views − paid (S373) — getKpis returns it that way; paid (ads) rides as the hint. */}
        <Tile label="Organic views" value={views.toLocaleString('en-IN')} size={28} hover
          hint={paid > 0 ? `+ ${paid.toLocaleString('en-IN')} paid (ads)` : undefined} style={{ borderRadius: 'var(--r-card)', padding: 18 }} />
        <Tile label="Live (done)" value={live.toLocaleString('en-IN')} color="var(--state-success-fg)" size={28} hover
          style={{ borderRadius: 'var(--r-card)', padding: 18 }} />
        {monthRow !== undefined && (hasTarget ? (
          <>
            <TargetTile label="Views vs target" actual={monthRow.actual_views} target={monthRow.target_views} pct={monthRow.views_pct} tone={viewsTone} fmt={viewsShort} />
            <TargetTile label="Spend vs budget" actual={monthRow.actual_spend} target={monthRow.budget_amount} pct={monthRow.spend_pct} tone={spendTone} fmt={inrShort} />
          </>
        ) : (
          <Card padding="18px" style={{ gridColumn: '1 / -1', color: 'var(--text-3)', fontSize: 14 }}>
            No target set for this month. <a href="/targets" style={{ color: 'var(--accent)' }}>Set one →</a>
          </Card>
        ))}
      </div>

      {/* Dropped from the hero row (plan "Deviations"; README §1): still reachable under UGC / All. */}
      {m === 'ugc' && kpis.ugc_summary && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
          <Tile label="UGC deals" value={n0(ugc.deals).toLocaleString('en-IN')} />
          <Tile label="Budget consumed" value={inr(ugc.budget_consumed)} color="var(--accent)" />
          <Tile label="UGC likes" value={n0(ugc.likes).toLocaleString('en-IN')} />
          <Tile label="Orders" value={n0(ugc.orders).toLocaleString('en-IN')} />
          <Tile label="Conv. value" value={inr(ugc.conversions_value)} />
        </div>
      )}
      {m === 'all' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
          <Tile label="Ghosted" value={n0(kpis.ghosted)} color={kpis.ghosted ? 'var(--state-error-fg)' : undefined} />
          <Tile label="Total likes" value={n0(et.likes).toLocaleString('en-IN')} />
          <Tile label="Total shares" value={n0(et.shares).toLocaleString('en-IN')} />
          {quality && <Tile label="Non-compliant" value={n0(quality.noncompliant_count)} color={quality.noncompliant_count ? 'var(--state-error-fg)' : undefined} />}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(380px, 100%), 1fr))', gap: 14 }}>
        {overdue && overdue.length > 0 && (
          <Card padding="0" className="ig-up" style={{ overflow: 'hidden', animationDelay: '400ms' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-cond)', fontSize: 16, fontWeight: 700, color: 'var(--state-error-fg)' }}>
                <AlertTriangle size={15} /> Overdue posts · {overdue.length}
              </span>
              {canManage && (
                <button type="button" onClick={flagAll} disabled={flagging} style={{
                  fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 700, padding: '7px 12px', borderRadius: 10,
                  border: '1px solid rgba(255,123,123,.45)', cursor: flagging ? 'default' : 'pointer', opacity: flagging ? 0.5 : 1,
                  background: flaggedN ? 'var(--state-error-fg)' : 'transparent', color: flaggedN ? 'var(--bg)' : 'var(--state-error-fg)',
                  transition: 'background 160ms, color 160ms', whiteSpace: 'nowrap',
                }}>
                  {flagging ? 'Flagging…' : flaggedN ? `✓ ${flaggedN} flagged red` : 'Flag overdue as red'}
                </button>
              )}
            </div>
            <div style={{ overflowX: 'auto' }}>
              <div style={{ minWidth: 560 }}>
                {overdue.map((e, i) => {
                  const name = e.influencer?.channel_name || e.influencer?.person_name || e.influencer?.influencer_code || '—';
                  return (
                    <Row key={e.id} columns={OVERDUE_COLS} first={i === 0} index={i} animate
                      onClick={() => router.push(`/engagements/detail/?id=${e.id}`)} style={{ padding: '10px 18px' }}>
                      <Avatar name={name} seed={e.influencer?.id || name} size={32} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</div>
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--accent-hi)' }}>{e.engagement_no}</div>
                      </div>
                      <span title={e.expected_post_date ? `Expected ${e.expected_post_date}` : undefined}
                        style={{ color: 'var(--text-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {productLabel(e.product_code, e.product_variant) || '—'}
                      </span>
                      <span style={{ justifySelf: 'start', minWidth: 0 }}><StagePill stage={e.stage} /></span>
                      <RatingDot rating={e.influencer?.quality_rating} style={{ fontSize: 12 }} />
                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--state-error-fg)', textAlign: 'right' }}>
                        {e.days_overdue != null ? `${e.days_overdue}d` : '—'}
                      </span>
                    </Row>
                  );
                })}
              </div>
            </div>
          </Card>
        )}

        {quality && (
          <Card padding="0" className="ig-up" style={{ overflow: 'hidden', animationDelay: '460ms' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontFamily: 'var(--font-cond)', fontSize: 16, fontWeight: 700 }}>Re-engage</span>
              <span style={{ fontSize: 12, color: 'var(--text-3)' }}>Green · 60d+ idle</span>
            </div>
            {(quality.reengage || []).map((r, i) => (
              <div key={r.influencer_id} className="ig-row" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 18px', borderTop: i === 0 ? 'none' : '1px solid var(--row-divider)', fontSize: 14 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--state-success-fg)', flexShrink: 0 }} />
                <a href={`/influencers/detail/?id=${r.influencer_id}`}
                  onClick={ev => { ev.preventDefault(); router.push(`/influencers/detail/?id=${r.influencer_id}`); }}
                  style={{ flex: 1, minWidth: 0, color: 'var(--text-1)' }}>
                  <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.channel_name || r.person_name || '—'}</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-4)' }}>{r.influencer_code} · {r.days_since}d idle</div>
                </a>
              </div>
            ))}
            {!quality.reengage?.length && (
              <div style={{ padding: '14px 18px', fontSize: 13, color: 'var(--text-4)' }}>No green creators idle 60d+.</div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 1, background: 'var(--border)', borderTop: '1px solid var(--border)' }}>
              <div style={{ background: 'var(--surface)', padding: '12px 18px' }}>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 18, fontWeight: 700, color: quality.gifted_no_post_count ? 'var(--state-error-fg)' : 'var(--text-1)' }}>{n0(quality.gifted_no_post_count)}</div>
                <div style={{ fontSize: 12, color: 'var(--text-3)' }}>Gifted · no post</div>
              </div>
              <div style={{ background: 'var(--surface)', padding: '12px 18px' }}>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 18, fontWeight: 700 }}>{inr(quality.unrecovered_value)}</div>
                <div style={{ fontSize: 12, color: 'var(--text-3)' }}>Unrecovered</div>
              </div>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

function TargetTile({ label, actual, target, pct, tone, fmt }) {
  const color = pct != null ? tone(Number(pct)) : 'var(--text-5)';
  return (
    <Card as="a" href="/targets" hover padding="18px" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-3)' }}>{label}</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color }}>{pct != null ? `${pct}%` : '—'}</span>
      </div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 28, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {fmt(actual)} <span style={{ fontSize: 13, color: 'var(--text-4)', fontWeight: 400 }}>/ {target != null ? fmt(target) : '—'}</span>
      </div>
      <ProgressBar pct={pct ?? 0} color={color} delay={400} />
    </Card>
  );
}
