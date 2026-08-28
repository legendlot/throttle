'use client';
/* ════════════════════════════════════════════════════════════
   QC — Pit Wall v2 (redesign-reference/app/qc.jsx). Diagnostic
   screen: FPY scorecard with root-cause callout · cycle-time
   strip · defect Pareto (line/type filters + drill-down drawer)
   · by-product breakdown · repeat-failure watchlist.
   Data: getQCView (fpy, cycle_time, cycle_time_lines, heatmap,
   defect_breakdown, repeat_defects). The prototype's 6-day
   trends, affected-unit lists, recommendations and action
   buttons have no backing data/mutations — omitted.
   ════════════════════════════════════════════════════════════ */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner } from '@throttle/ui';
import { todayStr, dateStr } from '@throttle/domain';
import { useRefreshState } from '../layout.js';
import {
  Icon, Panel, FilterChip, ToneBadge, Drawer, fmt, lineColor, lineRgb,
} from '../../../components/kit/index.js';

const FPY_TARGET = 95;

/* Step a YYYY-MM-DD by whole days using local calendar fields. Never round-trip
   through toISOString() — in IST that returns the previous day (PATTERN-221). */
function shiftDay(ymd, delta) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  if (!y || !m || !d) return ymd;
  return dateStr(new Date(y, m - 1, d + delta));
}

/* "22 Aug 2026" for the scorecard eyebrow when a past day is selected. */
function fmtDay(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  if (!y || !m || !d) return ymd;
  return new Date(y, m - 1, d).toLocaleDateString('en-GB',
    { day: 'numeric', month: 'short', year: 'numeric' });
}

const dayNavStyle = {
  background: 'transparent', border: 'none', color: 'var(--t2)', cursor: 'pointer',
  fontSize: 15, lineHeight: 1, padding: 0, width: 14, textAlign: 'center',
  fontFamily: 'var(--font-ui)',
};

/* severity → semantic tones (status colors only, per design rules) */
// ⚠️ Keys must match the distinct severities in public.defect_master. `Cosmetic` was added
// 2026-08-28 (S322) — its 5 codes existed and were offered on the scanner, but the
// qc_fail_defects CHECK rejected them, so none had ever reached this screen.
const SEV_T = {
  Critical: { fg: 'var(--bad-fg)',  dot: 'var(--red)',      tone: 'bad'  },
  Major:    { fg: 'var(--warn-fg)', dot: 'var(--amber)',    tone: 'warn' },
  Minor:    { fg: 'var(--t2)',      dot: 'var(--t4)',       tone: 'mute' },
  Cosmetic: { fg: 'var(--t2)',      dot: 'var(--blue)',     tone: 'mute' },
};
const sevT = (s) => SEV_T[s] || SEV_T.Minor;

function fmtMins(mins) {
  if (mins == null) return '—';
  const m = Number(mins);
  if (m < 60) return m.toFixed(1) + 'm';
  const h   = Math.floor(m / 60);
  const rem = (m % 60).toFixed(0);
  return `${h}h ${rem}m`;
}

/* ── empty state — lucide icon in a muted circle ────────────── */
function Empty({ icon = 'shield', message }) {
  return (
    <div style={{ padding: '36px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
      <div style={{ width: 44, height: 44, borderRadius: '50%', background: 'var(--surface-2)',
        border: '1px solid var(--border-2)', display: 'grid', placeItems: 'center', color: 'var(--t3)' }}>
        <Icon name={icon} size={20} />
      </div>
      <span style={{ fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--t3)' }}>{message}</span>
    </div>
  );
}

/* ── FPY scorecard — overall + per line/product vs target ───── */
function FpyScorecard({ rows, defects, dayLabel }) {
  if (!rows.length) {
    return (
      <Panel title="First-pass yield" icon="shield" style={{ marginBottom: 16 }}>
        <Empty icon="shield" message="No QC data for selected period" />
      </Panel>
    );
  }

  const totPass = rows.reduce((s, r) => s + (Number(r.first_pass_count) || 0), 0);
  const totInsp = rows.reduce((s, r) => s + (Number(r.total_inspected)  || 0), 0);
  // `total_inspected - first_pass_count` is NOT the fail count — a unit that passes on a
  // re-inspection carries loop_count > 0, so it sits inside total_inspected and outside
  // first_pass_count. Reporting that as "fail" told the floor 61 units had failed on a day
  // with zero QC_FAIL scans (2026-08-22, Maheshreddy). Read both counts from the view.
  const totFail   = rows.reduce((s, r) => s + (Number(r.fail_count)        || 0), 0);
  const totRework = rows.reduce((s, r) => s + (Number(r.rework_pass_count) || 0), 0);
  const overall = totInsp > 0 ? +(totPass / totInsp * 100).toFixed(1) : 0;

  const sorted = [...rows].sort((a, b) => (Number(a.fpy_pct) || 0) - (Number(b.fpy_pct) || 0));
  const worst = sorted[0];
  const worstBelow = worst && Number(worst.fpy_pct) < FPY_TARGET ? worst : null;
  const lead = worstBelow
    ? defects.filter(d => d.line === worstBelow.line).sort((a, b) => b.count - a.count).slice(0, 2)
    : [];

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)',
      boxShadow: 'var(--shadow-card)', overflow: 'hidden', marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'stretch', flexWrap: 'wrap' }}>
        {/* overall */}
        <div style={{ padding: '20px 26px', flexShrink: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', minWidth: 230 }}>
          <span className="eyebrow">First-pass yield · {dayLabel}</span>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 8 }}>
            <span className="num" style={{ fontSize: 46, fontWeight: 700, lineHeight: 1,
              color: overall >= FPY_TARGET ? 'var(--ok-fg)' : 'var(--warn-fg)' }}>{overall}%</span>
          </div>
          <div className="num" style={{ fontSize: 12.5, color: 'var(--t3)', marginTop: 8 }}>
            {fmt(totPass)} first-pass · {fmt(totRework)} rework · {fmt(totFail)} fail
          </div>
          <div className="num" style={{ fontSize: 11.5, color: 'var(--t3)', marginTop: 3 }}>
            {fmt(totInsp)} inspected · target {FPY_TARGET}%
          </div>
        </div>
        {/* per-line bars */}
        <div style={{ flex: 1, minWidth: 320, borderLeft: '1px solid var(--border)', padding: '18px 26px',
          display: 'flex', flexDirection: 'column', gap: 13, justifyContent: 'center' }}>
          {rows.map((r, i) => {
            const pct = Number(r.fpy_pct) || 0;
            const below = pct < FPY_TARGET;
            const c = pct >= FPY_TARGET ? 'var(--ok-fg)' : pct >= 85 ? 'var(--warn-fg)' : 'var(--bad-fg)';
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: lineColor(r.line), flexShrink: 0 }} />
                <span className="font-display" style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', color: 'var(--t1)', width: 24, flexShrink: 0 }}>{r.line || '—'}</span>
                <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t2)', width: 120, flexShrink: 0,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.product || '—'}</span>
                <div style={{ flex: 1, position: 'relative', height: 8, background: 'var(--bg-2)', borderRadius: 4, overflow: 'hidden' }}>
                  <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${Math.min(pct, 100)}%`, background: c, borderRadius: 4, transition: 'width 600ms var(--ease)' }} />
                  <div title={`target ${FPY_TARGET}%`} style={{ position: 'absolute', left: `${FPY_TARGET}%`, top: -1, bottom: -1, width: 2, background: 'rgba(255,255,255,0.7)' }} />
                </div>
                <span className="num" style={{ fontSize: 14, fontWeight: 700, color: c, width: 54, textAlign: 'right', flexShrink: 0 }}>{pct}%</span>
                {below
                  ? <span className="num" style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--bad-fg)', background: 'var(--bad-bg)',
                      border: '1px solid var(--bad-bd)', borderRadius: 3, padding: '1px 5px', flexShrink: 0 }}>−{(FPY_TARGET - pct).toFixed(1)}</span>
                  : <span style={{ width: 36, flexShrink: 0 }} />}
              </div>
            );
          })}
        </div>
      </div>
      {/* diagnosis callout */}
      {worstBelow && (
        <div style={{ borderTop: '1px solid var(--border)', background: 'var(--bad-bg)', padding: '11px 26px',
          display: 'flex', alignItems: 'center', gap: 10 }}>
          <Icon name="alert" size={15} style={{ color: 'var(--bad-fg)' }} />
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--t1)' }}>
            <strong style={{ color: 'var(--bad-fg)' }}>{worstBelow.line} {worstBelow.product}</strong> is {(FPY_TARGET - Number(worstBelow.fpy_pct)).toFixed(1)} pts below target.
            {lead.length > 0 && <> Led by{lead.map((d, i) => (
              <span key={d.code}>{i ? ' and ' : ' '}<strong style={{ color: 'var(--t1)' }}>{(d.issue || d.code || '').toLowerCase()}</strong> ({d.count})</span>
            ))}.</>}
          </span>
        </div>
      )}
    </div>
  );
}

/* ── cycle-time strip ───────────────────────────────────────── */
function CycleStrip({ ct, ctByLine }) {
  if (!ct || !Number(ct.units_measured)) {
    return (
      <Panel title="QC cycle time · INW → outcome" icon="clock" style={{ marginBottom: 16 }}>
        <Empty icon="clock" message="No cycle-time data for period" />
      </Panel>
    );
  }
  const avg = Number(ct.avg_mins_all);
  const cards = [
    ['Avg cycle', fmtMins(ct.avg_mins_all), `All lines · ${fmt(ct.units_measured)} units`, avg <= 30 ? 'ok' : avg <= 60 ? 'warn' : 'bad'],
    ['Pass avg', fmtMins(ct.avg_mins_pass), 'Passed units', 'ok'],
    ['Fail avg', fmtMins(ct.avg_mins_fail), 'Failed units', 'bad'],
    ['Median', fmtMins(ct.median_mins), '50th percentile', null],
    ['Slowest', fmtMins(ct.slowest_normal_mins), 'Within fence', null],
  ];
  const lines = Object.keys(ctByLine || {}).filter(l => ctByLine[l] && Number(ctByLine[l].units_measured)).sort();
  return (
    <Panel title="QC cycle time · INW → outcome" icon="clock" pad={14} style={{ marginBottom: 16 }}
      action={Number(ct.outlier_count) > 0 ? (
        <span className="num" style={{ fontSize: 11, color: 'var(--bad-fg)', background: 'var(--bad-bg)',
          border: '1px solid var(--bad-bd)', borderRadius: 'var(--r-full)', padding: '2px 9px', whiteSpace: 'nowrap' }}>
          {fmt(ct.outlier_count)} outliers excluded · max {fmtMins(ct.outlier_max_mins)} · fence {fmtMins(ct.outlier_threshold_mins)}
        </span>
      ) : null}>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {/* stat cards */}
        <div style={{ flex: 1, minWidth: 420, display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 10 }}>
          {cards.map(([l, v, s, tone]) => {
            const tc = { ok: 'var(--ok-fg)', warn: 'var(--warn-fg)', bad: 'var(--bad-fg)' }[tone] || 'var(--t1)';
            return (
              <div key={l} style={{ background: 'var(--surface-2)', borderRadius: 'var(--r-sm)', padding: '11px 13px',
                borderTop: `2px solid ${tone ? tc : 'var(--border-2)'}` }}>
                <div className="eyebrow">{l}</div>
                <div className="num" style={{ fontSize: 21, fontWeight: 700, color: tone ? tc : 'var(--t1)', marginTop: 5, whiteSpace: 'nowrap' }}>{v}</div>
                <div style={{ fontFamily: 'var(--font-ui)', fontSize: 10.5, color: 'var(--t3)', marginTop: 3 }}>{s}</div>
              </div>
            );
          })}
        </div>
        {/* per-line */}
        {lines.length > 0 && (
          <div style={{ width: 220, flexShrink: 0, borderLeft: '1px solid var(--border)', paddingLeft: 14,
            display: 'flex', flexDirection: 'column', gap: 9, justifyContent: 'center' }}>
            <div className="eyebrow">Avg cycle by line</div>
            {lines.map(line => {
              const d = ctByLine[line];
              const lAvg = Number(d.avg_mins_all);
              const slow = lAvg > 30;
              return (
                <div key={line} style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                  title={`${line} — pass ${fmtMins(d.avg_mins_pass)} · fail ${fmtMins(d.avg_mins_fail)} · ${fmt(d.units_measured)} units`}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: lineColor(line) }} />
                  <span className="font-display" style={{ fontSize: 11, fontWeight: 700, color: 'var(--t1)', width: 22 }}>{line}</span>
                  <div style={{ flex: 1, height: 6, background: 'var(--bg-2)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${Math.min(lAvg / 45 * 100, 100)}%`,
                      background: slow ? 'var(--red)' : lineColor(line), borderRadius: 3 }} />
                  </div>
                  <span className="num" style={{ fontSize: 12, fontWeight: 700, color: slow ? 'var(--bad-fg)' : 'var(--t2)', width: 50, textAlign: 'right' }}>{fmtMins(lAvg)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Panel>
  );
}

/* ── defect Pareto rows ─────────────────────────────────────── */
function DefectPareto({ rows, total, onRow }) {
  if (!rows.length) {
    return <Empty icon="shield" message="No defects match these filters" />;
  }
  const max = Math.max(...rows.map(d => d.count), 1);
  let n80 = 0, run = 0;
  for (const d of rows) { run += d.count; n80++; if (run / total >= 0.8) break; }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 12, color: 'var(--t3)' }}>
        <Icon name="activity" size={13} /> Top <strong style={{ color: 'var(--t1)' }}>{n80}</strong> of {rows.length} defects = <strong style={{ color: 'var(--t1)' }}>80%</strong> of fails. Tackle these first.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {rows.map((d, i) => {
          const s = sevT(d.severity);
          const pct = (d.count / total * 100);
          const within80 = i < n80;
          return (
            <div key={`${d.line}|${d.code}`} onClick={() => onRow(d)}
              style={{ display: 'grid', gridTemplateColumns: '22px minmax(200px,1.3fr) 1fr 44px 44px', gap: 12, alignItems: 'center',
                padding: '9px 11px', borderRadius: 'var(--r-sm)', cursor: 'pointer', border: '1px solid transparent',
                transition: 'background var(--fast), border-color var(--fast)' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface-2)'; e.currentTarget.style.borderColor = 'var(--border-2)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'transparent'; }}>
              <span className="num" style={{ fontSize: 12, fontWeight: 700, color: within80 ? 'var(--yellow)' : 'var(--t4)', textAlign: 'center' }}>{i + 1}</span>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: s.dot, flexShrink: 0 }} />
                  <span style={{ fontFamily: 'var(--font-ui)', fontSize: 13.5, fontWeight: 600, color: 'var(--t1)',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.issue || d.code}</span>
                  {d.training && <span title="Training flag" style={{ flexShrink: 0, color: 'var(--info-fg)', display: 'flex' }}><Icon name="users" size={12} /></span>}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
                  <span className="num" style={{ fontSize: 10, color: 'var(--t4)' }}>{d.code}</span>
                  <span className="num" style={{ fontSize: 9.5, fontWeight: 700, color: lineColor(d.line),
                    background: `rgba(${lineRgb(d.line)},0.12)`, borderRadius: 3, padding: '0 4px' }}>{d.line}</span>
                  <span style={{ fontFamily: 'var(--font-ui)', fontSize: 10, color: 'var(--t3)' }}>{d.category || '—'} · {d.severity || '—'}</span>
                </div>
              </div>
              <div style={{ height: 8, background: 'var(--bg-2)', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${d.count / max * 100}%`, background: s.dot, opacity: within80 ? 1 : 0.5, borderRadius: 4, transition: 'width 500ms var(--ease)' }} />
              </div>
              <span className="num" style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)', textAlign: 'right' }}>{fmt(d.count)}</span>
              <span className="num" style={{ fontSize: 11, color: 'var(--t3)', textAlign: 'right' }}>{pct.toFixed(0)}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── by-product tree (defect_breakdown payload) ─────────────── */
function ByProduct({ rows }) {
  const [open, setOpen] = useState(() => new Set());
  if (!rows.length) {
    return <Empty icon="box" message="No defect data for selected period" />;
  }

  const SEV_ORDER = { Critical: 0, Major: 1, Minor: 2, Cosmetic: 3 };
  const byProduct = {};
  rows.forEach(r => {
    const p = r.product || 'Unknown';
    const c = r.component_type || 'car';
    if (!byProduct[p]) byProduct[p] = { total: 0, components: {} };
    if (!byProduct[p].components[c]) byProduct[p].components[c] = { total: 0, defects: [] };
    const n = Number(r.defect_count) || 0;
    byProduct[p].total += n;
    byProduct[p].components[c].total += n;
    byProduct[p].components[c].defects.push({ code: r.defect_code, issue: r.issue, severity: r.severity, count: n, training: r.training_flag });
  });
  const prods = Object.keys(byProduct).sort((a, b) => byProduct[b].total - byProduct[a].total);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {prods.map(p => {
        const pd = byProduct[p];
        const isOpen = open.has(p);
        const comps = Object.keys(pd.components).sort();
        return (
          <div key={p}>
            <div onClick={() => setOpen(s => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; })}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 13px', background: 'var(--surface-2)',
                border: '1px solid var(--border-2)', borderRadius: isOpen ? 'var(--r-sm) var(--r-sm) 0 0' : 'var(--r-sm)',
                cursor: 'pointer', userSelect: 'none' }}>
              <span style={{ color: 'var(--t4)', transform: isOpen ? 'rotate(0)' : 'rotate(-90deg)', transition: 'transform var(--fast)', display: 'flex' }}>
                <Icon name="chevD" size={14} /></span>
              <span style={{ fontFamily: 'var(--font-ui)', fontSize: 14, fontWeight: 600, color: 'var(--t1)' }}>{p}</span>
              <span className="num" style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--t3)' }}>
                <strong style={{ color: 'var(--t1)' }}>{fmt(pd.total)}</strong> occurrences</span>
            </div>
            {isOpen && (
              <div style={{ border: '1px solid var(--border-2)', borderTop: 'none', borderRadius: '0 0 var(--r-sm) var(--r-sm)',
                padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
                {comps.map(comp => {
                  const cd = pd.components[comp];
                  const defects = [...cd.defects].sort((a, b) =>
                    (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9) || b.count - a.count);
                  return (
                    <div key={comp}>
                      <div className="eyebrow" style={{ marginBottom: 7, color: comp === 'car' ? 'var(--yellow)' : 'var(--blue-bright)' }}>
                        {comp === 'car' ? 'Car' : 'Remote'} · {fmt(cd.total)}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                        {defects.map((d, di) => {
                          const s = sevT(d.severity);
                          return (
                            <div key={di} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 9px', borderRadius: 'var(--r-xs)' }}>
                              <span style={{ width: 7, height: 7, borderRadius: '50%', background: s.dot, flexShrink: 0 }} />
                              <span className="num" style={{ fontSize: 10.5, color: 'var(--t4)', width: 64, flexShrink: 0 }}>{d.code}</span>
                              <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t1)', flex: 1, minWidth: 0,
                                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.issue || '—'}</span>
                              {d.training && <ToneBadge tone="info">Training</ToneBadge>}
                              <span className="label" style={{ fontSize: 9, color: s.fg }}>{d.severity || '—'}</span>
                              <span className="num" style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)', width: 30, textAlign: 'right' }}>{fmt(d.count)}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ── repeat-failure watchlist ───────────────────────────────── */
function RepeatWatchlist({ rows }) {
  return (
    <Panel title="Repeat failures" icon="undo" pad={8}
      action={rows.length ? (
        <span className="num" style={{ fontSize: 11, color: 'var(--warn-fg)', background: 'var(--warn-bg)',
          border: '1px solid var(--warn-bd)', borderRadius: 'var(--r-full)', padding: '2px 9px' }}>{rows.length}</span>
      ) : null}>
      {!rows.length ? (
        <Empty icon="undo" message="No repeat failures" />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {rows.slice(0, 20).map((r, i) => (
            <div key={r.upc || i} style={{ padding: '10px 11px', borderRadius: 'var(--r-sm)',
              borderTop: i ? '1px solid var(--border)' : 'none' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="num" style={{ fontSize: 12, color: 'var(--t1)', fontWeight: 600 }}>{r.upc}</span>
                <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span className="num" style={{ fontSize: 10.5, color: 'var(--t3)' }}>{fmt(r.unique_defect_codes)} codes</span>
                  <span className="num" style={{ fontSize: 12, fontWeight: 700, color: 'var(--bad-fg)' }}>{fmt(r.total_defects)}×</span>
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5, flexWrap: 'wrap' }}>
                <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--t3)' }}>{r.product || '—'}</span>
                <span style={{ color: 'var(--border-2)' }}>·</span>
                {(r.defect_codes || []).map(c => (
                  <span key={c} className="num" style={{ fontSize: 9.5, color: 'var(--t3)', background: 'var(--surface-2)',
                    border: '1px solid var(--border-2)', borderRadius: 3, padding: '1px 5px' }}>{c}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

/* ── defect drill-down drawer ───────────────────────────────── */
function DefectDrawer({ d, total, onClose }) {
  if (!d) return null;
  const s = sevT(d.severity);
  const pct = total > 0 ? (d.count / total * 100).toFixed(1) : '0';
  return (
    <Drawer open onClose={onClose} width={420}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
        <span className="num" style={{ fontSize: 12, color: 'var(--t2)' }}>{d.code}</span>
        <ToneBadge tone={s.tone}>{d.severity || 'Minor'}</ToneBadge>
        {d.training && <ToneBadge tone="info">Training flag</ToneBadge>}
        <span style={{ flex: 1 }} />
        <button onClick={onClose} style={{ background: 'none', border: '1px solid var(--border-2)', borderRadius: 'var(--r-xs)',
          width: 26, height: 26, color: 'var(--t3)', cursor: 'pointer', display: 'grid', placeItems: 'center' }}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <div style={{ overflowY: 'auto', padding: 20, flex: 1 }}>
        <div style={{ fontFamily: 'var(--font-ui)', fontSize: 18, fontWeight: 700, color: 'var(--t1)', marginBottom: 4 }}>{d.issue || d.code}</div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          <span className="num" style={{ fontSize: 10.5, fontWeight: 700, color: lineColor(d.line),
            background: `rgba(${lineRgb(d.line)},0.12)`, borderRadius: 3, padding: '2px 7px' }}>{d.line}</span>
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--t2)', background: 'var(--surface-2)',
            border: '1px solid var(--border-2)', borderRadius: 3, padding: '2px 8px' }}>{d.category || '—'}</span>
        </div>
        <div style={{ background: 'var(--surface-2)', borderRadius: 'var(--r-sm)', padding: '13px 15px' }}>
          <div className="eyebrow">Occurrences · period</div>
          <div className="num" style={{ fontSize: 26, fontWeight: 700, color: 'var(--t1)', marginTop: 4 }}>{fmt(d.count)}</div>
          <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--t3)', marginTop: 3 }}>{pct}% of all defects in view</div>
        </div>
        <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t3)', marginTop: 16, lineHeight: 1.5 }}>
          Unit-level detail is available in Scans — filter QC fails by this defect code.
        </div>
      </div>
    </Drawer>
  );
}

/* ── page ───────────────────────────────────────────────────── */
export default function QcPage() {
  const { session, userId }                 = useAuth();
  const { setRefreshing, setLastRefreshed } = useRefreshState();

  // Read the token from a ref inside the callback rather than closing over `session`,
  // which goes stale — and key the loads on `userId` (CORE.md / AuthProvider).
  const sessionRef = useRef(session);
  useEffect(() => { sessionRef.current = session; }, [session]);

  const [cycleTime,   setCycleTime]   = useState(null);
  const [ctByLine,    setCtByLine]    = useState({});
  const [fpy,         setFpy]         = useState([]);
  const [heatmap,     setHeatmap]     = useState([]);
  const [breakdown,   setBreakdown]   = useState([]);
  const [repeats,     setRepeats]     = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState(null);

  const [view,    setView]    = useState('pareto');   // 'pareto' | 'product'
  const [filters, setFilters] = useState({ line: 'all', cat: 'all' });
  const [drawer,  setDrawer]  = useState(null);
  // Defaults to today, per the standing rule for every date picker in every app.
  const [date,    setDate]    = useState(() => todayStr());
  const isToday = date === todayStr();

  const loadAll = useCallback(async () => {
    const s = sessionRef.current;
    if (!s) return;
    setRefreshing(true);
    try {
      const data  = await garageFetch('getQCView', { from: date, to: date }, s);

      setCycleTime(data.cycle_time       || null);
      setCtByLine(data.cycle_time_lines  || {});
      setFpy(data.fpy                    || []);
      setHeatmap(data.heatmap            || []);
      setBreakdown(data.defect_breakdown || []);
      setRepeats(data.repeat_defects     || []);
      setError(null);
    } catch (e) {
      setError(e.message || 'Failed to load QC data');
    } finally {
      setLoading(false);
      setRefreshing(false);
      setLastRefreshed(new Date());
    }
  }, [date, setRefreshing, setLastRefreshed]);

  // Load on mount and on every date change. NB `useAutoRefresh` cannot carry this —
  // it keys its effect on [skip, intervalMs] and holds fn in a ref, so a date change
  // would never re-fetch.
  useEffect(() => { if (userId) loadAll(); }, [userId, loadAll]);

  // Poll only while looking at today. A past day is settled, so re-fetching it every
  // 30s just churns and makes the "Updated hh:mm" stamp read as if it were live.
  useEffect(() => {
    if (!userId || !isToday) return;
    const id = setInterval(() => loadAll(), 30000);
    return () => clearInterval(id);
  }, [userId, isToday, loadAll]);

  /* aggregate heatmap rows by line+code for the Pareto */
  const defects = useMemo(() => {
    const map = {};
    (heatmap || []).forEach(r => {
      const key = `${r.line || '—'}|${r.defect_code}`;
      if (!map[key]) {
        map[key] = { code: r.defect_code, issue: r.issue, category: r.category,
          severity: r.severity, line: r.line || '—', count: 0, training: false };
      }
      map[key].count += Number(r.defect_count) || 0;
      if (r.training_flag) map[key].training = true;
    });
    return Object.values(map).sort((a, b) => b.count - a.count);
  }, [heatmap]);

  const defectTotal = useMemo(() => defects.reduce((s, d) => s + d.count, 0), [defects]);
  const defectLines = useMemo(() => [...new Set(defects.map(d => d.line))].sort(), [defects]);

  const filtered = useMemo(() => defects.filter(d =>
    (filters.line === 'all' || d.line === filters.line) &&
    (filters.cat === 'all' ||
      (filters.cat === 'Functional'
        ? (d.category || '').includes('Functional')
        : !(d.category || '').includes('Functional')))
  ), [defects, filters]);
  const filteredTotal = useMemo(() => filtered.reduce((s, d) => s + d.count, 0), [filtered]);

  if (loading) {
    return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 60 }}><Spinner /></div>;
  }

  const setF = (k, v) => setFilters(f => ({ ...f, [k]: v }));
  const Seg = () => (
    <div style={{ display: 'flex', gap: 3, padding: 3, background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-sm)' }}>
      {[['pareto', 'Pareto', 'activity'], ['product', 'By product', 'box']].map(([k, l, ic]) => (
        <button key={k} onClick={() => setView(k)} style={{ display: 'flex', alignItems: 'center', gap: 6, border: 'none', cursor: 'pointer',
          borderRadius: 'var(--r-xs)', padding: '6px 12px', fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 600,
          letterSpacing: '0.05em', textTransform: 'uppercase', whiteSpace: 'nowrap',
          background: view === k ? 'var(--surface-3)' : 'transparent', color: view === k ? 'var(--t1)' : 'var(--t3)' }}>
          <Icon name={ic} size={13} />{l}</button>
      ))}
    </div>
  );

  return (
    <div style={{ maxWidth: 1240, margin: '0 auto', fontFamily: 'var(--font-ui)' }}>
      {/* controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface)',
          border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '6px 11px', color: 'var(--t2)' }}>
          <Icon name="clock" size={14} />
          <button type="button" title="Previous day" onClick={() => setDate(shiftDay(date, -1))}
            style={dayNavStyle}>‹</button>
          <input type="date" value={date} max={todayStr()}
            onChange={e => { if (e.target.value) setDate(e.target.value); }}
            className="num"
            style={{ fontSize: 12.5, color: 'var(--t1)', background: 'transparent', border: 'none',
              outline: 'none', fontFamily: 'inherit', colorScheme: 'dark', padding: 0, cursor: 'pointer' }} />
          <button type="button" title="Next day" disabled={isToday}
            onClick={() => setDate(shiftDay(date, 1))}
            style={{ ...dayNavStyle, opacity: isToday ? 0.3 : 1,
              cursor: isToday ? 'default' : 'pointer' }}>›</button>
        </div>
        {!isToday && (
          <button type="button" onClick={() => setDate(todayStr())}
            style={{ ...dayNavStyle, width: 'auto', padding: '6px 11px', fontSize: 11.5,
              letterSpacing: '0.05em', textTransform: 'uppercase', border: '1px solid var(--border)',
              borderRadius: 'var(--r-sm)', background: 'var(--surface)' }}>Today</button>
        )}
        {isToday ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--t3)' }}>
            <span className="rl-pulse" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--green)' }} /> Auto-refresh 30s
          </span>
        ) : (
          <span style={{ fontSize: 12, color: 'var(--t3)' }}>Showing a past day — not live</span>
        )}
      </div>

      {error && (
        <div style={{ background: 'var(--bad-bg)', border: '1px solid var(--bad-bd)', borderRadius: 'var(--r-sm)',
          padding: '12px 14px', fontSize: 13, color: 'var(--bad-fg)', marginBottom: 18 }}>
          {error}
        </div>
      )}

      <FpyScorecard rows={fpy} defects={defects} dayLabel={isToday ? 'today' : fmtDay(date)} />
      <CycleStrip ct={cycleTime} ctByLine={ctByLine} />

      {/* defects + repeats */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.62fr 1fr', gap: 16, alignItems: 'start' }}>
        <Panel title={view === 'pareto' ? 'Defect Pareto' : 'Defects by product'} icon="shield" pad={12}
          action={<Seg />}>
          {view === 'pareto' ? (
            <>
              {/* filters */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, paddingBottom: 12, marginBottom: 4, borderBottom: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span className="eyebrow">Line</span>
                  <FilterChip active={filters.line === 'all'} onClick={() => setF('line', 'all')}>All</FilterChip>
                  {defectLines.map(l => (
                    <FilterChip key={l} active={filters.line === l} onClick={() => setF('line', l)} dot={lineColor(l)}>{l}</FilterChip>
                  ))}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span className="eyebrow">Type</span>
                  <FilterChip active={filters.cat === 'all'} onClick={() => setF('cat', 'all')}>All</FilterChip>
                  <FilterChip active={filters.cat === 'Functional'} onClick={() => setF('cat', 'Functional')}>Functional</FilterChip>
                  <FilterChip active={filters.cat === 'Visual'} onClick={() => setF('cat', 'Visual')}>Visual</FilterChip>
                </div>
              </div>
              <div style={{ marginTop: 12 }}>
                <DefectPareto rows={filtered} total={filteredTotal || 1} onRow={setDrawer} />
              </div>
            </>
          ) : (
            <ByProduct rows={breakdown} />
          )}
        </Panel>

        <RepeatWatchlist rows={repeats} />
      </div>

      <DefectDrawer d={drawer} total={defectTotal} onClose={() => setDrawer(null)} />
    </div>
  );
}
