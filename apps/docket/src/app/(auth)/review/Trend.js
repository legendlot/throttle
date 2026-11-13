'use client';
// F9 R9b — the score trend (spec §8.1 #2, §8.5): on-time % per team over the last closed weeks, from
// getScoreTrend (the worker reads docket.week_score — the official score; nothing is recomputed here).
// Inline SVG, no chart library; the chart scrolls inside its card at 375px, never the page.
import { linePath, dots, hasTrend, seriesColor } from '../../../lib/trend.js';
import { fmtPct } from '../../../lib/review.js';
import { shortDay } from '../../../lib/weeks.js';

const W = 560, H = 160, PAD = 14;

// `trend` is read by the page (review/page.js) IN PARALLEL with the pack — it used to start only once the
// pack had landed and this card mounted. null = not yet; { error } = failed (the pack still works without it).
// `team` is the pack's resolved team (display only: the "All teams" line).
export function TrendCard({ trend: t, team }) {
  if (!t || t.error) return null;
  const weeks = t.weeks || [];
  const series = [
    ...(team && team !== 'all' ? [] : [{ id: 'all', name: 'All teams', points: t.overall || [], overall: true }]),
    ...(t.teams || []).filter(Boolean),
  ].map((s, i) => ({ ...s, color: s.overall ? 'var(--text-1)' : seriesColor(i), pts: weeks.map(we => (s.points || []).find(p => p?.week_end === we) || { week_end: we, pct: null }) }));

  return (
    <article className="rv-team rv-trendcard">
      <h2 className="rv-team-h">Score trend<span className="rv-hidden"> · on time, last {weeks.length} closed week{weeks.length === 1 ? '' : 's'}</span></h2>
      {!hasTrend(t) ? <p className="rv-none">The trend starts after two closed weeks.</p> : <>
        <div className="rv-chart-scroll">
          <svg className="rv-chart" viewBox={`0 0 ${W} ${H + 18}`} width={W} height={H + 18} role="img" aria-label="On-time percentage by week">
            {[0, 50, 100].map(g => {
              const y = PAD + ((100 - g) * (H - 2 * PAD)) / 100;
              return <g key={g}><line x1={PAD} x2={W - PAD} y1={y} y2={y} className="rv-grid" /><text x={2} y={y + 3} className="rv-axis">{g}</text></g>;
            })}
            {weeks.map((we, i) => {
              const x = weeks.length <= 1 ? W / 2 : PAD + (i * (W - 2 * PAD)) / (weeks.length - 1);
              return <text key={we} x={x} y={H + 14} textAnchor="middle" className="rv-axis">{shortDay(we).replace(/^\w+ /, '')}</text>;
            })}
            {series.map(s => (
              <g key={s.id}>
                <path d={linePath(s.pts, { w: W, h: H, pad: PAD })} fill="none" stroke={s.color} strokeWidth={s.overall ? 2.5 : 1.5} />
                {dots(s.pts, { w: W, h: H, pad: PAD }).map(d => (
                  <circle key={d.i} cx={d.x} cy={d.y} r={s.overall ? 3 : 2.2} fill={s.color}>
                    <title>{`${s.name} · week ending ${shortDay(d.week_end)} · ${fmtPct(d.pct)}`}</title>
                  </circle>
                ))}
              </g>
            ))}
          </svg>
        </div>
        <div className="rv-legend">
          {series.map(s => <span key={s.id} className="rv-leg"><span className="rv-leg-dot" style={{ background: s.color }} />{s.name}</span>)}
        </div>
      </>}
    </article>
  );
}

// A team card's last-4-weeks sparkline ({ week_end, pct|null } oldest first).
export function Sparkline({ points = [], w = 84, h = 24 }) {
  if (points.filter(p => p?.pct != null).length === 0) return null;
  return (
    <svg className="rv-spark" viewBox={`0 0 ${w} ${h}`} width={w} height={h} role="img"
      aria-label={'Last weeks on time: ' + points.map(p => fmtPct(p.pct)).join(', ')}>
      <path d={linePath(points, { w, h, pad: 3 })} fill="none" stroke="var(--accent)" strokeWidth="1.6" />
      {dots(points, { w, h, pad: 3 }).map(d => <circle key={d.i} cx={d.x} cy={d.y} r="2" fill="var(--accent)"><title>{`Week ending ${shortDay(d.week_end)} · ${fmtPct(d.pct)}`}</title></circle>)}
    </svg>
  );
}
