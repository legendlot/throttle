'use client';
import { useCallback, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { KpiCard, Spinner, Panel, Chip, StatusBadge } from '@throttle/ui';
import { todayStr } from '@throttle/domain';
import { useAutoRefresh } from '../../../hooks/useAutoRefresh.js';
import { useRefreshState } from '../layout.js';

// ── Helpers ───────────────────────────────────────────────────
function fmt(n) { return n != null ? Number(n).toLocaleString('en-IN') : '0'; }

function getMondayISO() {
  const d = new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(new Date().setDate(diff)).toISOString().split('T')[0];
}

function getFirstOfMonthISO() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().split('T')[0];
}

// Map production run status → StatusBadge variant + icon.
// Per DESIGN.md "State Triple Rule" — color + label, plus an icon where it helps.
function runStatusConfig(status) {
  if (!status)               return { variant: 'neutral', icon: null,  label: '—' };
  if (status === 'Submitted')   return { variant: 'info',    icon: '◐', label: status };
  if (status === 'Issued')      return { variant: 'brand',   icon: null, label: status };
  if (status === 'In Progress') return { variant: 'success', icon: '●', label: status };
  if (status === 'Completed')   return { variant: 'success', icon: '✓', label: status };
  if (status === 'Cancelled')   return { variant: 'error',   icon: '✗', label: status };
  if (status === 'Rejected')    return { variant: 'error',   icon: '✗', label: status };
  return { variant: 'neutral', icon: null, label: status };
}

function RunStatus({ status }) {
  const cfg = runStatusConfig(status);
  return <StatusBadge variant={cfg.variant} icon={cfg.icon}>{cfg.label}</StatusBadge>;
}

// ── Hourly dispatch chart (signature component — preserve) ───
// Each row = one line. Each column = one hour (9..endHour).
// Fill % per cell is based on count vs hourly target.
function HourlyChart({ rows, pvaRows }) {
  if (!rows || (!rows.length && !(pvaRows || []).some(r => r.target_qty > 0))) {
    return (
      <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--t3)', fontSize: 13 }}>
        📦 No dispatch data for selected date
      </div>
    );
  }

  const LINE_ORDER  = ['L1', 'L2', 'L3'];
  const LINE_COLORS = { L1: 'var(--yellow)', L2: 'var(--blue)', L3: 'var(--green)' };
  const LINE_RGB    = { L1: '242,205,26',    L2: '33,60,226',   L3: '34,197,94'   };
  const SHIFT_HRS   = 9;
  const SHIFT_END   = 18;

  const byLine = {};
  rows.forEach(r => {
    if (!byLine[r.line]) byLine[r.line] = {};
    byLine[r.line][r.hour] = (byLine[r.line][r.hour] || 0) + (r.dispatched || r.unit_count || 0);
  });

  const targetByLine = {};
  (pvaRows || []).forEach(r => {
    if (r.line_no) targetByLine[r.line_no] = Number(r.target_qty) || 0;
  });

  const maxDataHour = rows.reduce((max, r) => Math.max(max, Number(r.hour) || 0), 0);
  const endHour     = Math.max(SHIFT_END, maxDataHour);
  const shiftHours  = Array.from({ length: endHour - 9 + 1 }, (_, i) => i + 9);
  const CELL_H      = 64;

  const nowIST    = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const currentHr = nowIST.getHours();

  const activeLines = LINE_ORDER.filter(l => byLine[l] || targetByLine[l]);

  if (!activeLines.length) {
    return (
      <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--t3)', fontSize: 13 }}>
        No active line data
      </div>
    );
  }

  return (
    <div>
      {activeLines.map((line, li) => {
        const data      = byLine[line] || {};
        const dayTarget = targetByLine[line] || 0;
        const hrTarget  = dayTarget > 0 ? dayTarget / SHIFT_HRS : 0;
        const rgb       = LINE_RGB[line];

        const totalActual = Object.values(data).reduce((s, v) => s + v, 0);
        const hrsElapsed  = Math.max(0, Math.min(currentHr - 9, SHIFT_HRS));
        const paceTarget  = Math.round(hrTarget * hrsElapsed);
        const gap         = paceTarget - totalActual;

        const paceColor = gap > 5 ? 'var(--red)' : gap < -5 ? 'var(--green)' : 'var(--t2)';
        const paceLabel = gap > 5 ? `▼ ${gap} behind` : gap < -5 ? `▲ ${Math.abs(gap)} ahead` : 'on pace';

        const isLast = li === activeLines.length - 1;

        return (
          <div key={line} style={{
            padding: '16px 0',
            borderBottom: isLast ? 'none' : '1px solid var(--border)',
            marginBottom: isLast ? 0 : 6,
          }}>
            {/* Line header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: LINE_COLORS[line], flexShrink: 0 }} />
                <span style={{
                  fontFamily: 'var(--cond)', fontSize: 14, fontWeight: 700,
                  letterSpacing: '0.06em', color: 'var(--t1)',
                }}>{line}</span>
                {hrTarget > 0
                  ? <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>· {Math.round(hrTarget)}/hr · {fmt(dayTarget)} today</span>
                  : <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>· no target set</span>}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t2)' }}>{fmt(totalActual)} dispatched</span>
                {hrTarget > 0 && hrsElapsed > 0 && (
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700, color: paceColor, letterSpacing: '0.04em' }}>{paceLabel}</span>
                )}
              </div>
            </div>

            {/* Hour cells */}
            <div style={{ display: 'flex', gap: 4 }}>
              {shiftHours.map(h => {
                const count     = data[h] || 0;
                const isFuture  = h > currentHr;
                const isOT      = h > SHIFT_END;
                const isCurrent = h === currentHr;

                let fillPct   = 0;
                let fillColor = 'transparent';
                let cellBorder = isOT ? `rgba(${rgb},.25)` : `rgba(${rgb},.15)`;

                if (!isFuture) {
                  cellBorder = `rgba(${rgb},.3)`;
                  if (hrTarget > 0) {
                    fillPct = Math.min((count / hrTarget) * 100, 100);
                    if (isCurrent)              fillColor = `rgba(${rgb},.45)`;
                    else if (count >= hrTarget) fillColor = `rgba(34,197,94,.8)`;
                    else if (count >= hrTarget * 0.7) fillColor = `rgba(245,158,11,.8)`;
                    else if (count > 0)         fillColor = `rgba(222,42,42,.8)`;
                  } else if (count > 0) {
                    fillPct   = 55;
                    fillColor = `rgba(${rgb},.5)`;
                  }
                }

                const numColor = fillPct > 45 ? '#fff' : (isFuture ? 'var(--t3)' : LINE_COLORS[line]);
                const isOver   = !isFuture && !isCurrent && hrTarget > 0 && count >= hrTarget;
                const fontSize = count > 99 ? 12 : 13;

                return (
                  <div key={h} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5 }}>
                    <div style={{
                      width: '100%', height: CELL_H,
                      border: `1px solid ${cellBorder}`,
                      borderRadius: 3,
                      background: 'var(--surface3)',
                      position: 'relative',
                      overflow: 'hidden',
                    }}>
                      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: `${fillPct}%`, background: fillColor, transition: 'height 260ms cubic-bezier(0.22, 1, 0.36, 1)' }} />
                      <div style={{
                        position: 'absolute', inset: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize, fontWeight: 700,
                        color: numColor, fontFamily: 'var(--mono)',
                        zIndex: 1,
                      }}>
                        {!isFuture && count > 0 ? count : ''}
                      </div>
                      {isOver && (
                        <div style={{ position: 'absolute', top: 4, right: 4, width: 5, height: 5, borderRadius: '50%', background: 'var(--green)', zIndex: 2 }} />
                      )}
                    </div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', letterSpacing: '0.04em' }}>
                      {h}{isOT ? ' OT' : ''}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Legend */}
            <div style={{ display: 'flex', gap: 16, marginTop: 10 }}>
              {[
                ['rgba(34,197,94,.8)',  'met target'],
                ['rgba(245,158,11,.8)', 'close'],
                ['rgba(222,42,42,.8)',  'missed'],
                [`rgba(${rgb},.45)`,    'in progress'],
              ].map(([bg, lbl]) => (
                <div key={lbl} style={{
                  fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)',
                  letterSpacing: '0.04em',
                  display: 'flex', alignItems: 'center', gap: 6,
                }}>
                  <div style={{ width: 9, height: 9, borderRadius: 2, background: bg }} />
                  {lbl}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Plan-vs-Actual cards ─────────────────────────────────────
function PvaCards({ rows }) {
  if (!rows.length) {
    return (
      <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--t3)', fontSize: 13 }}>
        📋 No production runs for selected date
      </div>
    );
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
      {rows.map(r => {
        const pct = r.completion_pct || 0;
        const pctCol = pct >= 90 ? 'var(--green)' : pct >= 60 ? 'var(--yellow)' : pct > 0 ? 'var(--orange)' : 'var(--red)';
        const bar = Math.min(pct, 100);
        return (
          <div key={r.run_no} style={{
            background: 'var(--surface2)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: 16,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{
                  fontFamily: 'var(--cond)', fontWeight: 700,
                  fontSize: 16, color: 'var(--yellow)', letterSpacing: '0.04em',
                }}>
                  {r.run_no}
                </div>
                <div style={{ fontSize: 13, color: 'var(--t1)', marginTop: 4 }}>{r.product}</div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', marginTop: 3, letterSpacing: '0.04em' }}>{r.line_no || '—'}</div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <RunStatus status={r.run_status} />
                <div style={{
                  fontFamily: 'var(--cond)', fontSize: 24, fontWeight: 700,
                  color: pctCol, marginTop: 8, lineHeight: 1,
                }}>
                  {pct}%
                </div>
              </div>
            </div>
            <div style={{ background: 'var(--border)', borderRadius: 3, height: 5, marginBottom: 10, overflow: 'hidden' }}>
              <div style={{
                height: '100%', width: `${bar}%`,
                background: pctCol, borderRadius: 3,
                transition: 'width 260ms cubic-bezier(0.22, 1, 0.36, 1)',
              }} />
            </div>
            <div style={{
              display: 'flex', justifyContent: 'space-between',
              fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)',
              letterSpacing: '0.04em', flexWrap: 'wrap', gap: 6,
            }}>
              <span>Target <span style={{ color: 'var(--t1)', fontWeight: 600 }}>{fmt(r.target_qty)}</span></span>
              <span>QC <span style={{ color: 'var(--green)', fontWeight: 600 }}>{fmt(r.actual_qc_pass)}</span></span>
              <span>RTR <span style={{ color: 'var(--t1)', fontWeight: 600 }}>{fmt(r.actual_rtr)}</span></span>
              <span>RTE <span style={{ color: 'var(--t1)', fontWeight: 600 }}>{fmt(r.actual_rte)}</span></span>
            </div>
            <div style={{ marginTop: 10, fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.04em' }}>
              {r.gap > 0
                ? <span style={{ color: 'var(--red)' }}>−{fmt(r.gap)} short</span>
                : <span style={{ color: 'var(--green)' }}>✓ On track</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Production runs table ─────────────────────────────────────
function RunsTable({ runs, date }) {
  const active   = runs.filter(r => r.run_date === date && ['Issued', 'In Progress'].includes(r.status));
  const upcoming = runs.filter(r => r.status === 'Submitted');

  if (!active.length && !upcoming.length) {
    return (
      <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--t3)', fontSize: 13 }}>
        🏭 No active or upcoming runs
      </div>
    );
  }

  const thStyle = {
    padding: '10px 14px',
    fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
    letterSpacing: '0.08em', textTransform: 'uppercase',
    color: 'var(--t3)',
    borderBottom: '1px solid var(--border)',
    whiteSpace: 'nowrap', textAlign: 'left',
  };
  const tdStyle = {
    padding: '10px 14px',
    fontFamily: 'var(--mono)', fontSize: 13,
    color: 'var(--t1)',
    borderBottom: '1px solid rgba(64,64,64,.5)',
    whiteSpace: 'nowrap',
  };

  function SectionHeaderRow({ label, dotColor }) {
    return (
      <tr>
        <td colSpan={8} style={{
          padding: '8px 14px',
          background: 'var(--surface2)',
          borderBottom: '1px solid var(--border)',
          borderTop: '1px solid var(--border)',
        }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
            fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
            letterSpacing: '0.08em', textTransform: 'uppercase',
            color: 'var(--t2)',
          }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: dotColor, display: 'inline-block', flexShrink: 0 }} />
            {label}
          </span>
        </td>
      </tr>
    );
  }

  function RunRow({ r }) {
    return (
      <tr>
        <td style={{ ...tdStyle, fontFamily: 'var(--cond)', fontWeight: 700, color: 'var(--yellow)', letterSpacing: '0.04em' }}>{r.run_no}</td>
        <td style={tdStyle}>{r.product}</td>
        <td style={tdStyle}>{r.line_no || '—'}</td>
        <td style={tdStyle}>{r.run_date}</td>
        <td style={{ ...tdStyle, textAlign: 'right' }}>{fmt(r.target_qty)}</td>
        <td style={{ ...tdStyle, textAlign: 'right' }}>{fmt(r.target_retail)}</td>
        <td style={{ ...tdStyle, textAlign: 'right' }}>{fmt(r.target_ecom)}</td>
        <td style={tdStyle}><RunStatus status={r.status} /></td>
      </tr>
    );
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {[
              { label: 'Run',     align: 'left'  },
              { label: 'Product', align: 'left'  },
              { label: 'Line',    align: 'left'  },
              { label: 'Date',    align: 'left'  },
              { label: 'Target',  align: 'right' },
              { label: 'Retail',  align: 'right' },
              { label: 'Ecom',    align: 'right' },
              { label: 'Status',  align: 'left'  },
            ].map(h => (
              <th key={h.label} style={{ ...thStyle, textAlign: h.align }}>{h.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {active.length > 0 && (
            <>
              <SectionHeaderRow label="Active Today" dotColor="var(--green)" />
              {active.map(r => <RunRow key={r.run_no} r={r} />)}
            </>
          )}
          {upcoming.length > 0 && (
            <>
              <SectionHeaderRow label="Upcoming" dotColor="var(--blue)" />
              {upcoming.map(r => <RunRow key={r.run_no} r={r} />)}
            </>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ── Section — semantic h2 wrapper between Panels ──────────────
function Section({ label, children }) {
  return (
    <section style={{ marginBottom: 32 }}>
      <h2 style={{
        margin: '0 0 14px 0',
        fontFamily: 'var(--cond)',
        fontSize: 12,
        fontWeight: 700,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: 'var(--t2)',
      }}>
        {label}
      </h2>
      {children}
    </section>
  );
}

// ══════════════════════════════════════════════════════════════
// PAGE
// ══════════════════════════════════════════════════════════════
export default function ExecPage() {
  const { session } = useAuth();
  const { setRefreshing, setLastRefreshed } = useRefreshState();

  const [dateTo,   setDateTo]   = useState(() => todayStr());
  const [dateFrom, setDateFrom] = useState(() => todayStr());
  const [summary,     setSummary]     = useState(null);
  const [hourly,      setHourly]      = useState([]);
  const [pva,         setPva]         = useState([]);
  const [runs,        setRuns]        = useState([]);
  const [scanSummary, setScanSummary] = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState(null);

  const loadData = useCallback(async () => {
    if (!session) return;
    setRefreshing(true);
    try {
      const date = dateTo;
      const [dashData, pvaData, scanData] = await Promise.allSettled([
        garageFetch('getProductionDashboard', { date }, session),
        garageFetch('getPlanVsActual',        { from: date, to: date }, session),
        garageFetch('getScanSummary',          { date }, session),
      ]);

      if (dashData.status === 'fulfilled') {
        const d = dashData.value;
        setSummary(d.summary || null);
        setRuns(d.open_runs || []);
        setHourly(d.hourly_dispatch?.length ? d.hourly_dispatch : (d.hourly_chart || []));
      } else {
        setError('Dashboard data unavailable');
      }

      setPva(pvaData.status === 'fulfilled' ? (pvaData.value || []) : []);
      setScanSummary(scanData.status === 'fulfilled' ? (scanData.value || null) : null);
      setError(null);
    } catch (e) {
      setError(e.message || 'Failed to load data');
    } finally {
      setLoading(false);
      setRefreshing(false);
      setLastRefreshed(
        new Date().toLocaleTimeString('en-IN', {
          hour: '2-digit', minute: '2-digit', second: '2-digit',
          hour12: true, timeZone: 'Asia/Kolkata',
        })
      );
    }
  }, [session, dateTo, setRefreshing, setLastRefreshed]);

  useAutoRefresh(loadData, 30000, !session);

  function handlePreset(preset) {
    const today = todayStr();
    if (preset === 'today') {
      setDateFrom(today);
      setDateTo(today);
    } else if (preset === 'week') {
      setDateFrom(getMondayISO());
      setDateTo(today);
    } else if (preset === 'month') {
      setDateFrom(getFirstOfMonthISO());
      setDateTo(today);
    }
  }

  const isRange = dateFrom !== dateTo;
  const today = todayStr();
  const presetActive = (preset) => {
    if (preset === 'today') return dateFrom === today && dateTo === today;
    if (preset === 'week')  return dateFrom === getMondayISO() && dateTo === today;
    if (preset === 'month') return dateFrom === getFirstOfMonthISO() && dateTo === today;
    return false;
  };

  const dateInputStyle = {
    background: 'var(--surface2)',
    color: 'var(--t1)',
    border: '1px solid var(--border)',
    padding: '6px 10px',
    borderRadius: 3,
    fontFamily: 'var(--mono)',
    fontSize: 13,
    outline: 'none',
  };
  const dateLabelStyle = {
    fontFamily: 'var(--mono)',
    fontSize: 11,
    color: 'var(--t3)',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
  };

  // ── KPI source ─────────────────────────────────────────────
  const s = summary || {};
  const scan = scanSummary || {};
  const passRate = s.today_pass_rate != null ? s.today_pass_rate + '%' : '—';
  const prColor  = s.today_pass_rate >= 95 ? 'green' : s.today_pass_rate >= 85 ? 'yellow' : s.today_pass_rate != null ? 'red' : undefined;
  const qcCarSub    = scan.QC_PASS_remote != null ? `${fmt(scan.QC_PASS_remote)} remotes tracked`  : `${fmt(s.today_inw)} inwarded`;
  const inwRemoteSub = scan.INW_remote    != null ? `${fmt(scan.INW_remote)} remotes tracked`       : undefined;

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 60 }}>
        <Spinner />
      </div>
    );
  }

  return (
    <div>
      {/* Date bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24, flexWrap: 'wrap' }}>
        {isRange && (
          <>
            <span style={dateLabelStyle}>From</span>
            <input type="date" style={dateInputStyle} value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
            <span style={dateLabelStyle}>to</span>
          </>
        )}
        <input
          type="date"
          style={dateInputStyle}
          value={dateTo}
          onChange={e => setDateTo(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 6, marginLeft: 4 }}>
          <Chip active={presetActive('today')} onClick={() => handlePreset('today')}>Today</Chip>
          <Chip active={presetActive('week')}  onClick={() => handlePreset('week')}>This Week</Chip>
          <Chip active={presetActive('month')} onClick={() => handlePreset('month')}>This Month</Chip>
        </div>
      </div>

      {error && (
        <div style={{
          background: 'rgba(222,42,42,.1)',
          border: '1px solid rgba(222,42,42,.3)',
          borderRadius: 4,
          padding: '12px 14px',
          fontFamily: 'var(--mono)',
          fontSize: 13,
          color: '#ff7070',
          marginBottom: 20,
        }}>
          ⚠ {error}
        </div>
      )}

      {/* Today at a Glance */}
      <Section label="Today at a Glance">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
          <KpiCard label="QC Pass — Today"    value={fmt(s.today_qc_pass)}      sub={qcCarSub}                                              color="yellow" />
          <KpiCard label="Inwarded — Today"   value={fmt(s.today_inw)}           sub={inwRemoteSub || ' '}                              />
          <KpiCard label="QC Fail — Today"    value={fmt(s.today_qc_fail)}       sub={s.qc_fail_car != null ? `${fmt(s.qc_fail_car)}C · ${fmt(s.qc_fail_remote||0)}R` : ' '} color={s.today_qc_fail > 0 ? 'red' : undefined} />
          <KpiCard label="Pass Rate"          value={passRate}                    sub="First-pass yield"                                     color={prColor} />
          <KpiCard label="Dispatched — Today" value={fmt(s.today_dispatched)}    sub={`${fmt(s.today_rtr)} retail · ${fmt(s.today_rte)} ecom`} color="green" />
          <KpiCard label="WTD Pass"           value={fmt(s.wtd_pass)}            sub="This week"                                            />
          <KpiCard label="MTD Pass"           value={fmt(s.mtd_pass)}            sub="This month"                                           />
          <KpiCard label="PKG Out"            value={fmt(s.dispatch_stock)}      sub="Units at RTD"                                         color="blue" />
          <KpiCard label="Repair Queue"       value={fmt(s.repair_queue)}        sub="In workshop"                                          color={s.repair_queue > 50 ? 'yellow' : undefined} />
          <KpiCard label="Open Runs"          value={fmt(s.open_runs)}           sub={`${fmt(s.downtime_mins)} mins downtime`}               />
          {s.open_findings > 0 && (
            <KpiCard label="Open Findings"    value={fmt(s.open_findings)}       sub="Audit findings"                                       color="red" />
          )}
        </div>
      </Section>

      {/* Plan vs Actual */}
      <Section label="Plan vs Actual — Today">
        <PvaCards rows={pva} />
      </Section>

      {/* Hourly Output */}
      <Section label="Hourly Output — Today">
        <Panel header="Hourly Dispatch — Achievement vs Target">
          <HourlyChart rows={hourly} pvaRows={pva} />
        </Panel>
      </Section>

      {/* Production Runs */}
      <Section label="Production Runs">
        <Panel padding={0}>
          <RunsTable runs={runs} date={dateTo} />
        </Panel>
      </Section>
    </div>
  );
}
