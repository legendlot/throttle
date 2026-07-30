'use client';
/* ════════════════════════════════════════════════════════════
   MANPOWER (Depot) — DISPATCH-ONLY. Dispatch has two lines D1/D2
   and its own activities (logged on Dispatch → Dispatch Roster),
   no production lines/stations. Four tabs, all scoped to the
   dispatch team: Attendance (team=dispatch) · Daily Roster (assign
   dispatch operators to D1/D2 — assignManpower/removeManpower/
   bulkAssignManpower, pickers, multi-select, drag-drop, auto-assign)
   · Analytics (team=dispatch) · Shifts (dispatch dept only).
   The production-only components (Live floor map / Performance /
   production attendance) remain defined but are not surfaced here.
   ════════════════════════════════════════════════════════════ */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { workerFetch } from '@throttle/db';
import { ConfirmModal, Modal, Spinner, useToast } from '@throttle/ui';
import { useAutoRefresh } from '../../../hooks/useAutoRefresh.js';
import { useRefreshState } from '../layout.js';
import {
  Icon, Panel, ToneBadge, btnPrimary, btnGhost,
  inputStyle as kitInput,
} from '../../../components/kit/index.js';
import { dateStr } from '@throttle/domain';

// ── Constants ───────────────────────────────────────────────────────────────
const DISPATCH_LINE_ORDER = ['D1', 'D2'];

// Dispatch line accents (D1/D2).
const BUCKET_COLOR = { D1: '#ec4899', D2: '#06b6d4' };

// ── Shared styles ───────────────────────────────────────────────────────────
const inputStyle  = { ...kitInput, width: 'auto', fontSize: 13, padding: '8px 11px' };
const selectStyle = { ...inputStyle, cursor: 'pointer' };
const smallGhost  = { ...btnGhost, padding: '6px 10px', fontSize: 12 };

// ── Display helpers ─────────────────────────────────────────────────────────
function capitalize(s) { return (s || '').charAt(0).toUpperCase() + (s || '').slice(1); }
// Manual day classification (sick / half-day / leave …) — feeds the future salary/OT engine.
const DAY_STATUS_OPTS = [
  { value: '',         label: 'Normal' },
  { value: 'full_day', label: 'Full day' },
  { value: 'half_day', label: 'Half day' },
  { value: 'absent',   label: 'Absent' },
  { value: 'leave',    label: 'Leave' },
  { value: 'holiday',  label: 'Holiday' },
];
const DAY_STATUS_TONE = { half_day: 'warn', absent: 'bad', leave: 'brand', holiday: 'mute', full_day: 'ok' };
function istToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}
function fmtIstTime(ts) {
  if (!ts) return null;
  try {
    return new Date(ts).toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
    });
  } catch { return null; }
}
function fmtIstDate(d) {
  try {
    return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
    });
  } catch { return d; }
}
function fmtDuration(clockIn, clockOut) {
  if (!clockIn || !clockOut) return '—';
  const ms = new Date(clockOut).getTime() - new Date(clockIn).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${m}m`;
}

// ── Operator card helpers ────────────────────────────────────────────────────
function getInitials(name) {
  const parts = (name || '').trim().split(/\s+/);
  return parts.length >= 2
    ? (parts[0][0] + parts[1][0]).toUpperCase()
    : (parts[0] || '?').slice(0, 2).toUpperCase();
}

function Avatar({ name, size = 26, color }) {
  return (
    <div style={{ width: size, height: size, borderRadius: '50%', background: 'var(--surface-2)',
      border: `1px solid ${color || 'var(--border-2)'}`, display: 'grid', placeItems: 'center', flexShrink: 0,
      fontFamily: 'var(--font-display)', fontSize: Math.max(size * 0.36, 8.5), fontWeight: 700,
      color: color || 'var(--t2)' }}>
      {getInitials(name)}
    </div>
  );
}

// Restricted / empty notes — lucide icon in a muted circle, no emoji.
function EmptyNote({ icon = 'users', title, sub }) {
  return (
    <div style={{ padding: '42px 0', textAlign: 'center' }}>
      <div style={{ display: 'inline-grid', placeItems: 'center', width: 44, height: 44, borderRadius: '50%',
        background: 'var(--surface-2)', color: 'var(--t3)', border: '1px solid var(--border-2)', marginBottom: 11 }}>
        <Icon name={icon} size={20} />
      </div>
      <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13.5, color: 'var(--t1)', fontWeight: 600 }}>{title}</div>
      {sub && <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--t3)', marginTop: 3 }}>{sub}</div>}
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// Manpower page (Depot, dispatch-only) — 4 tabs: Attendance · Daily Roster ·
// Analytics · Shifts. All scoped to the dispatch team (D1/D2).
// ═══════════════════════════════════════════════════════════════════════════
export default function ManpowerPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [activeTab, setActiveTab] = useState('dispatch');
  // Page-level operators cache, shared by Attendance / Daily Roster / Performance.
  const [allOperators, setAllOperators] = useState([]);

  const canManageFloor = !!(perms?.users_manage || perms?.production_view || perms?.procurement_approve);

  useEffect(() => {
    if (!session || !canManageFloor) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await workerFetch('getOperators', { data: { status: '' } }, session);
        const list = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
        if (!cancelled) setAllOperators(list);
      } catch (e) {
        if (!cancelled) showToast(e.message || 'Failed to load operators', 'error');
      }
    })();
    return () => { cancelled = true; };
  }, [session, canManageFloor, showToast, activeTab]);

  if (perms && !canManageFloor) {
    return (
      <Panel>
        <EmptyNote icon="users" title="Restricted" sub="Manpower view is restricted to floor supervisors." />
      </Panel>
    );
  }

  // Depot is dispatch-only — show the dispatch-team manpower tabs. The
  // production tabs (live floor map / production attendance / performance)
  // stay defined + rendered below but are intentionally not surfaced here.
  const TABS = [
    { key: 'dispatch',    label: 'Attendance',   icon: 'clock' },
    { key: 'roster',      label: 'Daily roster', icon: 'layers' },
    { key: 'analytics',   label: 'Analytics',    icon: 'gauge' },
    { key: 'shifts',      label: 'Shifts',       icon: 'clock' },
  ];

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', color: 'var(--t1)' }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        {TABS.map((t) => {
          const on = t.key === activeTab;
          return (
            <button key={t.key} onClick={() => setActiveTab(t.key)}
              style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer',
                background: on ? 'var(--surface-3)' : 'transparent',
                border: `1px solid ${on ? 'var(--border-3)' : 'var(--border)'}`,
                color: on ? 'var(--t1)' : 'var(--t3)', borderRadius: 'var(--r-full)',
                padding: '7px 14px', whiteSpace: 'nowrap',
                fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 600 }}>
              <Icon name={t.icon} size={14} /> {t.label}
            </button>
          );
        })}
      </div>

      {activeTab === 'dispatch'    && <AttendanceTab session={session} canManageFloor={canManageFloor} operators={allOperators} team="dispatch" />}
      {activeTab === 'roster'      && <DailyRosterTab session={session} canManageFloor={canManageFloor} operators={allOperators} />}
      {activeTab === 'analytics'   && <ManpowerAnalyticsTab session={session} canManageFloor={canManageFloor} operators={allOperators} team="dispatch" />}
      {activeTab === 'shifts'      && <ShiftsTab session={session} canManageFloor={canManageFloor} />}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// AttendanceTab — daily clock-in/out view with close-shift action.
// Worker: getOperatorAttendance + closeAttendanceShift (canManageFloor gate).
// ═══════════════════════════════════════════════════════════════════════════
function AttendanceTab({ session, canManageFloor, operators, team }) {
  const { showToast } = useToast();
  const [date, setDate] = useState(istToday());
  const [rows, setRows] = useState([]);
  const [stats, setStats] = useState({});   // operator_id → { streak, absent_month }
  const [dept, setDept] = useState('');      // '' = all departments
  const [loading, setLoading] = useState(true);
  const [closeTarget, setCloseTarget] = useState(null);
  const [closing, setClosing] = useState(false);
  const [savingStatus, setSavingStatus] = useState({}); // attendance_id → bool (day_status save in flight)

  // employee_id lookup — attendance rows don't include it.
  const opMap = useMemo(() => {
    const m = {};
    for (const op of operators || []) m[op.id] = op;
    return m;
  }, [operators]);

  const load = useCallback(async () => {
    if (!session || !canManageFloor || !date) return;
    setLoading(true);
    try {
      const [attRes, statRes] = await Promise.all([
        workerFetch('getOperatorAttendance', { data: { date_from: date, date_to: date, ...(team ? { team } : {}) } }, session),
        workerFetch('getAttendanceStats',    { data: { date } },                            session).catch(() => null),
      ]);
      const list = Array.isArray(attRes?.data) ? attRes.data : Array.isArray(attRes) ? attRes : [];
      setRows(list);
      const statList = Array.isArray(statRes?.data) ? statRes.data : [];
      const map = {};
      for (const s of statList) map[s.operator_id] = { streak: s.streak, absent_month: s.absent_month };
      setStats(map);
    } catch (e) {
      showToast(e.message || 'Failed to load attendance', 'error');
      setRows([]);
      setStats({});
    } finally {
      setLoading(false);
    }
  }, [session, canManageFloor, date, team, showToast]);

  useEffect(() => { load(); }, [load]);

  async function setDayStatus(row, day_status) {
    setSavingStatus((s) => ({ ...s, [row.id]: true }));
    // optimistic
    setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, day_status: day_status || null } : r)));
    try {
      await workerFetch('setDayStatus', { data: { attendance_id: row.id, day_status: day_status || null } }, session);
    } catch (e) {
      showToast(e.message || 'Failed to set day status', 'error');
      load(); // revert to server truth
    } finally {
      setSavingStatus((s) => { const n = { ...s }; delete n[row.id]; return n; });
    }
  }

  // Department helpers — options derived from the day's records; filter client-side.
  const deptOf = useCallback(
    (row) => (row.operator_department || opMap[row.operator_id]?.department || '').toLowerCase(),
    [opMap]
  );
  const deptOptions = useMemo(() => {
    const set = new Set();
    for (const r of rows) { const dpt = deptOf(r); if (dpt) set.add(dpt); }
    return [...set].sort();
  }, [rows, deptOf]);
  const visibleRows = useMemo(
    () => (dept ? rows.filter((r) => deptOf(r) === dept) : rows),
    [rows, dept, deptOf]
  );

  async function confirmClose() {
    if (!closeTarget) return;
    setClosing(true);
    try {
      const res = await workerFetch(
        'closeAttendanceShift',
        { data: { attendance_id: closeTarget.id } },
        session
      );
      const inner = res?.data;
      if (inner && inner.ok === false) {
        showToast(inner.error || 'Could not close shift', 'error');
      } else {
        showToast(`Shift closed for ${closeTarget.operator_name || 'operator'}`, 'success');
      }
      setCloseTarget(null);
      load();
    } catch (e) {
      showToast(e.message || 'Close shift failed', 'error');
    } finally {
      setClosing(false);
    }
  }

  if (!canManageFloor) {
    return (
      <Panel>
        <EmptyNote icon="clock" title="Restricted" sub="Attendance is restricted to floor supervisors." />
      </Panel>
    );
  }

  // All tracks fixed except the operator column, which uses a minmax() floor so it
  // can't collapse to the avatar width. The header row and each data row are separate
  // grids; a bare `fr` whose body content has overflow:hidden (min-content 0) would
  // size differently between header and body and drift the columns out of sync.
  const cols = '102px minmax(160px, 1.4fr) 104px 84px 80px 102px 74px 56px 80px 104px 124px 88px';

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 14 }}>
        <div>
          <span className="eyebrow" style={{ display: 'block', marginBottom: 6 }}>Date</span>
          <input type="date" className="num" value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <span className="eyebrow" style={{ display: 'block', marginBottom: 6 }}>Department</span>
          <select value={dept} onChange={(e) => setDept(e.target.value)} style={selectStyle}>
            <option value="">All departments</option>
            {deptOptions.map((dpt) => (
              <option key={dpt} value={dpt}>{capitalize(dpt)}</option>
            ))}
          </select>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>
          <span className="num" style={{ fontSize: 11.5, color: 'var(--t3)' }}>
            {new Set(visibleRows.map(r => r.operator_id)).size} present · {visibleRows.length} record{visibleRows.length === 1 ? '' : 's'}
            {dept ? ` · ${capitalize(dept)}` : ''}
          </span>
          <button style={smallGhost} onClick={load} disabled={loading} title="Refresh">
            <Icon name="undo" size={13} /> Refresh
          </button>
        </div>
      </div>

      <Panel pad={8}>
        {loading ? (
          <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        ) : visibleRows.length === 0 ? (
          <EmptyNote icon="clock" title="No attendance records"
            sub={dept ? `No ${capitalize(dept)} records for ${fmtIstDate(date)}.` : `Nothing logged for ${fmtIstDate(date)}.`} />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <div style={{ minWidth: 1320 }}>
              <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 12, padding: '0 12px 9px', borderBottom: '1px solid var(--border)' }}>
                {['Employee ID', 'Operator', 'Department', 'Shift', 'Clock in', 'Clock out', 'Duration', 'Streak', 'Absent (mo)', 'Device', 'Day status', ''].map((h, i) => (
                  <div key={h || `c${i}`} className="eyebrow">{h}</div>
                ))}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {visibleRows.map((row, i) => {
                  const op = opMap[row.operator_id];
                  const isOvertime = (row.shift_type || '').toLowerCase() === 'overtime';
                  const st = stats[row.operator_id];
                  return (
                    <div key={row.id} style={{ display: 'grid', gridTemplateColumns: cols, gap: 12, alignItems: 'center',
                      padding: '9px 12px', borderTop: i ? '1px solid var(--border)' : 'none' }}>
                      <span className="num" style={{ fontSize: 11.5, color: 'var(--t2)' }}>{op?.employee_id || '—'}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
                        <Avatar name={row.operator_name || op?.name} size={26} />
                        <span style={{ fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--t1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {row.operator_name || op?.name || '—'}
                        </span>
                      </div>
                      <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t2)' }}>
                        {capitalize(row.operator_department || op?.department || '') || '—'}
                      </span>
                      <ToneBadge tone={isOvertime ? 'brand' : 'mute'} style={{ justifySelf: 'start' }}>
                        {capitalize(row.shift_type || '') || '—'}
                      </ToneBadge>
                      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                        <span className="num" style={{ fontSize: 12.5, color: 'var(--t1)' }}>{fmtIstTime(row.clock_in) || '—'}</span>
                        {row.late_minutes > 0 && (
                          <span className="num" style={{ fontSize: 9.5, color: 'var(--bad-fg)' }}
                            title={`${row.late_minutes} min late vs scheduled start`}>+{row.late_minutes}m late</span>
                        )}
                      </span>
                      {row.clock_out
                        ? (
                          <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                              <span className="num" style={{ fontSize: 12.5, color: 'var(--t1)' }}>{fmtIstTime(row.clock_out)}</span>
                              {row.auto_closed && <ToneBadge tone="mute" style={{ fontSize: 9 }} title="Auto-closed at 1:00 AM IST">Auto</ToneBadge>}
                            </span>
                            {row.overtime_minutes > 0 && (
                              <span className="num" style={{ fontSize: 9.5, color: 'var(--brand-fg, var(--t2))' }}
                                title={`${row.overtime_minutes} min past scheduled end`}>+{row.overtime_minutes}m OT</span>
                            )}
                          </span>
                        )
                        : <ToneBadge tone="warn" style={{ justifySelf: 'start' }}>Open</ToneBadge>}
                      <span className="num" style={{ fontSize: 12, color: 'var(--t2)' }}>{fmtDuration(row.clock_in, row.clock_out)}</span>
                      <span className="num" style={{ fontSize: 12.5, fontWeight: 600, color: st && st.streak > 0 ? 'var(--ok-fg)' : 'var(--t3)' }}
                        title={st ? `${st.streak} consecutive working day${st.streak === 1 ? '' : 's'} (Mon–Sat)` : ''}>
                        {st ? `${st.streak}d` : '—'}
                      </span>
                      <span className="num" style={{ fontSize: 12.5, fontWeight: 600, color: st && st.absent_month > 0 ? 'var(--bad-fg)' : 'var(--t3)' }}
                        title={st ? `${st.absent_month} working day${st.absent_month === 1 ? '' : 's'} absent this month` : ''}>
                        {st ? st.absent_month : '—'}
                      </span>
                      <span className="num" style={{ fontSize: 10.5, color: 'var(--t3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {row.clock_in_device || '—'}
                      </span>
                      <select
                        value={row.day_status || ''}
                        disabled={!!savingStatus[row.id]}
                        onChange={(e) => setDayStatus(row, e.target.value)}
                        title={row.day_status_note || 'Manual day classification (feeds payroll)'}
                        style={{ ...selectStyle, padding: '4px 6px', fontSize: 11.5, width: '100%',
                          color: row.day_status ? `var(--${DAY_STATUS_TONE[row.day_status] || 'mute'}-fg, var(--t1))` : 'var(--t3)' }}
                      >
                        {DAY_STATUS_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                      <div style={{ textAlign: 'right' }}>
                        {!row.clock_out && (
                          <button
                            onClick={(e) => { e.stopPropagation(); setCloseTarget(row); }}
                            style={{ ...smallGhost, padding: '4px 9px', fontSize: 11.5 }}
                            title="Close shift"
                          >
                            Close shift
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </Panel>

      <ConfirmModal
        open={!!closeTarget}
        onClose={() => !closing && setCloseTarget(null)}
        title="Close Shift"
        confirmLabel={closing ? 'Closing…' : 'Close Shift'}
        onConfirm={confirmClose}
        loading={closing}
        message={
          closeTarget
            ? `Close shift for ${closeTarget.operator_name || 'this operator'}? This will set their clock-out to the current time.`
            : ''
        }
      />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ManpowerAnalyticsTab — attendance reliability by department, to help the
// production manager spot absenteeism and reallocate irregular operators.
// Read-only. Worker: getManpowerAnalytics (RPC get_manpower_analytics).
// Working days = Mon–Sat. Tiers: Reliable ≥90 / Steady ≥75 / Irregular ≥50 / Critical.
// ═══════════════════════════════════════════════════════════════════════════
const ANALYTICS_WINDOWS = [
  { key: '30',    label: '30d',        days: 30 },
  { key: '60',    label: '60 days',    days: 60 },
  { key: '90',    label: '90d',        days: 90 },
  { key: 'month', label: 'This month', days: null },
];
const DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function tierOf(rate) {
  if (rate >= 90) return { key: 'reliable',  label: 'Reliable',  tone: 'ok'   };
  if (rate >= 75) return { key: 'steady',    label: 'Steady',    tone: 'info' };
  if (rate >= 50) return { key: 'irregular', label: 'Irregular', tone: 'warn' };
  return            { key: 'critical',  label: 'Critical',  tone: 'bad'  };
}
function analyticsRange(winKey) {
  const end = istToday();
  if (winKey === 'month') return { start: end.slice(0, 8) + '01', end };
  const days = (ANALYTICS_WINDOWS.find((w) => w.key === winKey)?.days) || 60;
  const d = new Date(end + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return { start: dateStr(d), end };
}
function fmtMin(m) {
  if (m === null || m === undefined) return null;
  const h = Math.floor(m / 60), mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
function absentDowHint(dow) {
  if (!Array.isArray(dow)) return null;
  const tot = dow.reduce((a, b) => a + (b || 0), 0);
  if (tot < 3) return null;
  let mi = 0;
  for (let i = 1; i < 6; i++) if ((dow[i] || 0) > (dow[mi] || 0)) mi = i;
  if (dow[mi] >= 3 && dow[mi] / tot >= 0.4) return `Often off ${DOW_LABELS[mi]}`;
  return null;
}

function ManpowerAnalyticsTab({ session, canManageFloor, operators, team }) {
  const { showToast } = useToast();
  const [winKey, setWinKey] = useState('60');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [hideZero, setHideZero] = useState(true);

  const range = useMemo(() => analyticsRange(winKey), [winKey]);

  // operator_id → team, so we can scope analytics to this surface's team (production).
  const teamOf = useMemo(() => {
    const m = {};
    for (const op of operators || []) m[op.id] = op.team;
    return m;
  }, [operators]);

  const load = useCallback(async () => {
    if (!session || !canManageFloor) return;
    setLoading(true);
    try {
      const res = await workerFetch('getManpowerAnalytics', { data: { start: range.start, end: range.end } }, session);
      const list = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
      // The RPC analyses every active operator; scope to this surface's team when given.
      setRows(team ? list.filter((r) => (teamOf[r.operator_id] || 'production') === team) : list);
    } catch (e) {
      showToast(e.message || 'Failed to load analytics', 'error');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [session, canManageFloor, range, team, teamOf, showToast]);

  useEffect(() => { load(); }, [load]);

  // Only operators with eligible working days in the window are analysable.
  const withData = useMemo(() => rows.filter((r) => (r.working_days || 0) > 0), [rows]);
  const zeroCount = useMemo(() => withData.filter((r) => (r.present_days || 0) === 0).length, [withData]);
  const shown = useMemo(
    () => (hideZero ? withData.filter((r) => (r.present_days || 0) > 0) : withData),
    [withData, hideZero]
  );

  const overview = useMemo(() => {
    const n = shown.length;
    const avg = n ? Math.round(shown.reduce((a, r) => a + (r.attendance_rate || 0), 0) / n) : 0;
    let reliable = 0, steady = 0, risk = 0;
    for (const r of shown) {
      const t = tierOf(r.attendance_rate || 0).key;
      if (t === 'reliable') reliable++;
      else if (t === 'steady') steady++;
      else risk++;
    }
    return { n, avg, reliable, steady, risk };
  }, [shown]);

  // Group by department; sort sections worst-avg-first, operators worst-first within.
  const sections = useMemo(() => {
    const byDept = {};
    for (const r of shown) {
      const d = (r.department || 'unassigned').toLowerCase();
      (byDept[d] = byDept[d] || []).push(r);
    }
    const out = Object.entries(byDept).map(([dept, ops]) => {
      ops.sort((a, b) => (a.attendance_rate || 0) - (b.attendance_rate || 0));
      const counts = { reliable: 0, steady: 0, irregular: 0, critical: 0 };
      let sum = 0;
      for (const o of ops) { counts[tierOf(o.attendance_rate || 0).key]++; sum += (o.attendance_rate || 0); }
      return { dept, ops, counts, avg: ops.length ? Math.round(sum / ops.length) : 0 };
    });
    out.sort((a, b) => a.avg - b.avg);
    return out;
  }, [shown]);

  const stripLen = shown[0]?.day_strip?.length || 0;
  const cellW = stripLen ? Math.max(4, Math.min(11, Math.floor(470 / stripLen))) : 9;
  const cellGap = stripLen > 45 ? 1 : 2;

  if (!canManageFloor) {
    return <Panel><EmptyNote icon="gauge" title="Restricted" sub="Manpower analytics is restricted to floor supervisors." /></Panel>;
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        <span className="eyebrow">Window</span>
        {ANALYTICS_WINDOWS.map((w) => {
          const on = w.key === winKey;
          return (
            <button key={w.key} onClick={() => setWinKey(w.key)}
              style={{ cursor: 'pointer', borderRadius: 'var(--r-sm)', padding: '5px 11px', fontSize: 12, fontWeight: 600,
                fontFamily: 'var(--font-ui)', whiteSpace: 'nowrap',
                background: on ? 'var(--yellow)' : 'var(--surface-2)', color: on ? '#1a1a1a' : 'var(--t3)',
                border: `1px solid ${on ? 'var(--yellow)' : 'var(--border-2)'}` }}>
              {w.label}
            </button>
          );
        })}
        <span className="num" style={{ fontSize: 11, color: 'var(--t4)' }}>
          {stripLen} working day{stripLen === 1 ? '' : 's'} · Mon–Sat · as of {fmtIstDate(range.end)}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--t3)', cursor: 'pointer', fontFamily: 'var(--font-ui)' }}>
            <input type="checkbox" checked={hideZero} onChange={(e) => setHideZero(e.target.checked)} style={{ accentColor: 'var(--accent)', cursor: 'pointer' }} />
            Hide never-present ({zeroCount})
          </label>
          <button style={smallGhost} onClick={load} disabled={loading} title="Refresh">
            <Icon name="undo" size={13} /> Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <Panel><div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div></Panel>
      ) : shown.length === 0 ? (
        <Panel><EmptyNote icon="gauge" title="No attendance to analyse" sub={`Nothing recorded in this window${hideZero && zeroCount ? ` (${zeroCount} never-present hidden)` : ''}.`} /></Panel>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10, marginBottom: 18 }}>
            {[
              { label: 'Operators', value: overview.n, color: 'var(--t1)' },
              { label: 'Avg attendance', value: `${overview.avg}%`, color: overview.avg >= 75 ? 'var(--ok-fg)' : 'var(--warn-fg)' },
              { label: 'Reliable', value: overview.reliable, color: 'var(--ok-fg)' },
              { label: 'Steady', value: overview.steady, color: 'var(--info-fg)' },
              { label: 'At risk', value: overview.risk, color: overview.risk ? 'var(--bad-fg)' : 'var(--t1)' },
            ].map((c) => (
              <div key={c.label} style={{ background: 'var(--surface-2)', borderRadius: 'var(--r-sm)', padding: '11px 13px' }}>
                <div style={{ fontSize: 11, color: 'var(--t3)', fontFamily: 'var(--font-ui)' }}>{c.label}</div>
                <div className="num" style={{ fontSize: 22, fontWeight: 700, marginTop: 3, color: c.color }}>{c.value}</div>
              </div>
            ))}
          </div>

          {sections.map((sec) => (
            <Panel key={sec.dept} pad={14} style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 14, marginBottom: 10, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontFamily: 'var(--font-ui)', fontSize: 15, fontWeight: 700, color: 'var(--t1)' }}>{capitalize(sec.dept)}</span>
                  <span className="num" style={{ fontSize: 11.5, color: 'var(--t3)' }}>{sec.ops.length} operators · {sec.avg}% avg</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                  <div style={{ width: 150, height: 6, borderRadius: 3, overflow: 'hidden', display: 'flex' }}>
                    {[['reliable', 'var(--ok-fg)'], ['steady', 'var(--info-fg)'], ['irregular', 'var(--warn-fg)'], ['critical', 'var(--bad-fg)']].map(([k, col]) =>
                      sec.counts[k] ? <span key={k} title={`${sec.counts[k]} ${k}`} style={{ flex: sec.counts[k], background: col }} /> : null
                    )}
                  </div>
                  <span className="num" style={{ fontSize: 10.5, color: 'var(--t4)' }}>
                    {sec.counts.reliable}·{sec.counts.steady}·{sec.counts.irregular}·{sec.counts.critical}
                  </span>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {sec.ops.map((o, i) => {
                  const tier = tierOf(o.attendance_rate || 0);
                  const hint = absentDowHint(o.dow_absent);
                  const arr = fmtMin(o.avg_arrival_min);
                  const td = o.trend_delta || 0;
                  return (
                    <div key={o.operator_id} style={{ display: 'grid',
                      gridTemplateColumns: '210px 92px 56px 92px minmax(120px, 1fr) 156px', gap: 12, alignItems: 'center',
                      padding: '9px 2px', borderTop: i ? '1px solid var(--border)' : 'none' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
                        <Avatar name={o.name} size={26} />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--t1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.name || '—'}</div>
                          <div className="num" style={{ fontSize: 10, color: 'var(--t4)' }}>{o.employee_id || ''}</div>
                        </div>
                      </div>
                      <ToneBadge tone={tier.tone} style={{ justifySelf: 'start' }}>{tier.label}</ToneBadge>
                      <span className="num" style={{ fontSize: 14, fontWeight: 700, color: (o.attendance_rate || 0) >= 75 ? 'var(--t1)' : 'var(--bad-fg)' }}>{o.attendance_rate || 0}%</span>
                      <span className="num" style={{ fontSize: 11.5, color: 'var(--t2)' }} title={`Current streak ${o.current_streak || 0} · longest ${o.longest_streak || 0} (working days)`}>
                        {o.current_streak || 0}d <span style={{ color: 'var(--t4)' }}>/ {o.longest_streak || 0}</span>
                      </span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                        <span style={{ display: 'flex', alignItems: 'center', flexShrink: 0, fontSize: 12, color: td >= 5 ? 'var(--ok-fg)' : td <= -5 ? 'var(--bad-fg)' : 'var(--t4)' }}
                          title={`Trend ${td > 0 ? '+' : ''}${td}pp (recent vs earlier half)`}>
                          {td >= 5 ? <Icon name="arrowUp" size={13} /> : td <= -5 ? <Icon name="arrowDown" size={13} /> : '–'}
                        </span>
                        <div style={{ display: 'flex', gap: cellGap, overflow: 'hidden' }} title={`${o.present_days}/${o.working_days} working days present`}>
                          {(o.day_strip || '').split('').map((ch, idx) => {
                            let bg = 'var(--surface-2)', bd = 'none';
                            if (ch === '1') { bg = 'var(--ok-fg)'; }
                            else if (ch === '0') { bg = 'rgba(222,42,42,0.20)'; bd = '1px solid var(--bad-bd)'; }
                            return <span key={idx} style={{ width: cellW, height: 14, borderRadius: 2, background: bg, border: bd, flexShrink: 0 }} />;
                          })}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right', lineHeight: 1.35 }}>
                        {hint && <div style={{ fontSize: 10.5, color: 'var(--warn-fg)', fontFamily: 'var(--font-ui)' }}>{hint}</div>}
                        <div className="num" style={{ fontSize: 10.5, color: 'var(--t4)' }}>
                          {arr ? `avg ${arr}` : 'no day shifts'}{o.late_days ? ` · ${o.late_days} late` : ''}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Panel>
          ))}

          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 4, fontSize: 11, color: 'var(--t3)', fontFamily: 'var(--font-ui)' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 11, height: 11, borderRadius: 3, background: 'var(--ok-fg)' }} /> Present</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 11, height: 11, borderRadius: 3, background: 'rgba(222,42,42,0.20)', border: '1px solid var(--bad-bd)' }} /> Absent</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 11, height: 11, borderRadius: 3, background: 'var(--surface-2)' }} /> Before joining</span>
            <span style={{ color: 'var(--t4)' }}>· streak = current / longest · trend = recent vs earlier half · newest day on the right</span>
          </div>
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// DailyRosterTab — line assignment roster backed by store.manpower_assignments.
// HTML5 drag-and-drop from operators panel into L1/L2/L3 columns + dropdown
// fallback. assignManpower upserts (operator+date+line UNIQUE).
// removeManpower DELETEs a single (operator_id, shift_date, line) row.
// ═══════════════════════════════════════════════════════════════════════════
function DailyRosterTab({ session, canManageFloor, operators }) {
  const { showToast } = useToast();
  const [date, setDate] = useState(istToday());
  const [grouped, setGrouped] = useState({});
  const [attendanceRows, setAttendanceRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pickerOpen, setPickerOpen]       = useState({});
  const [pickerQuery, setPickerQuery]     = useState({});
  const [pickerHighlight, setPickerHighlight] = useState({});
  const pickerRefs = useRef({});
  const highlightedPickerRef = useRef(null);

  // Dispatch-only: two flat lines D1/D2, no production stations.
  const [targets, setTargets] = useState({ D1: '', D2: '' });
  const [selectedOpIds, setSelectedOpIds] = useState(() => new Set());

  // Pool = dispatch-team operators only (Depot is dispatch-only).
  const activeOperators = useMemo(
    () => (operators || []).filter(
      (o) => o.status !== 'inactive' && (o.team || '').toLowerCase() === 'dispatch'
    ),
    [operators]
  );

  const assignedOpIds = useMemo(() => {
    const s = new Set();
    for (const line of DISPATCH_LINE_ORDER) {
      for (const row of grouped[line] || []) s.add(row.operator_id);
    }
    return s;
  }, [grouped]);

  const clockedInIds = useMemo(() => {
    const s = new Set();
    for (const a of attendanceRows || []) {
      if (!a.clock_out) s.add(a.operator_id);
    }
    return s;
  }, [attendanceRows]);

  const availableOperators = useMemo(
    () => activeOperators.filter((o) => clockedInIds.has(o.id) && !assignedOpIds.has(o.id)),
    [activeOperators, clockedInIds, assignedOpIds]
  );

  const totalAssigned = useMemo(
    () => DISPATCH_LINE_ORDER.reduce((n, line) => n + (grouped[line] || []).length, 0),
    [grouped]
  );

  const load = useCallback(async () => {
    if (!session || !canManageFloor || !date) return;
    setLoading(true);
    try {
      const [rosterRes, attRes] = await Promise.all([
        workerFetch('getManpowerLog', { data: { shift_date: date } }, session),
        workerFetch('getOperatorAttendance', { data: { date_from: date, date_to: date, team: 'dispatch' } }, session),
      ]);
      const inner = rosterRes?.data;
      const obj = inner && typeof inner === 'object' && !Array.isArray(inner) ? inner : {};
      setGrouped(obj);
      const attList = Array.isArray(attRes?.data) ? attRes.data : Array.isArray(attRes) ? attRes : [];
      setAttendanceRows(attList);
    } catch (e) {
      showToast(e.message || 'Failed to load roster', 'error');
      setGrouped({});
      setAttendanceRows([]);
    } finally {
      setLoading(false);
    }
  }, [session, canManageFloor, date, showToast]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const openKeys = Object.keys(pickerOpen).filter((k) => pickerOpen[k]);
    if (openKeys.length === 0) return;
    function onDocClick(e) {
      const stillOpen = {};
      for (const key of openKeys) {
        const el = pickerRefs.current[key];
        if (el && el.contains(e.target)) stillOpen[key] = true;
      }
      setPickerOpen(stillOpen);
    }
    function onKey(e) {
      if (e.key === 'Escape') { setPickerOpen({}); setPickerHighlight({}); }
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [pickerOpen]);

  useEffect(() => {
    if (highlightedPickerRef.current) {
      highlightedPickerRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [pickerHighlight]);

  async function handleAssign(operatorId, line) {
    if (!canManageFloor || !operatorId || !line) return;
    try {
      await workerFetch('assignManpower', { data: { operator_id: operatorId, line, shift_date: date } }, session);
      const op = activeOperators.find((o) => o.id === operatorId);
      showToast(`Assigned ${op?.name || 'operator'} to ${line}`, 'success');
      load();
    } catch (e) {
      showToast(e.message || 'Assign failed', 'error');
    }
  }

  async function handleUnassign(row, line) {
    if (!canManageFloor || !row?.operator_id || !line) return;
    try {
      await workerFetch(
        'removeManpower',
        { data: { operator_id: row.operator_id, line, shift_date: date } },
        session
      );
      showToast(`Removed ${row.operator_name || 'operator'} from ${line}`, 'success');
      load();
    } catch (e) {
      showToast(e.message || 'Unassign failed', 'error');
    }
  }

  function onPoolDragStart(e, op) {
    const isSelected = selectedOpIds.has(op.id);
    const opIds = isSelected ? [...selectedOpIds] : [op.id];
    e.dataTransfer.setData('application/json', JSON.stringify({ opIds }));
    e.dataTransfer.setData('operatorId', op.id);
    e.dataTransfer.effectAllowed = 'move';
  }

  function readDropOpIds(e) {
    const jsonRaw = e.dataTransfer.getData('application/json');
    if (jsonRaw) {
      try {
        const parsed = JSON.parse(jsonRaw);
        if (Array.isArray(parsed.opIds) && parsed.opIds.length) return parsed.opIds;
      } catch {}
    }
    const single = e.dataTransfer.getData('operatorId');
    return single ? [single] : [];
  }

  async function handleBulkAssign(opIds, line) {
    if (!canManageFloor || !opIds.length || !line) return;
    try {
      if (opIds.length === 1) {
        await workerFetch('assignManpower', { data: { operator_id: opIds[0], line, shift_date: date } }, session);
      } else {
        const assignments = opIds.map((id) => ({ operator_id: id, line }));
        await workerFetch('bulkAssignManpower', { data: { assignments, shift_date: date } }, session);
      }
      const noun = opIds.length === 1 ? 'operator' : `${opIds.length} operators`;
      showToast(`Assigned ${noun} to ${line}`, 'success');
      setSelectedOpIds(new Set());
      load();
    } catch (e) {
      showToast(e.message || 'Assign failed', 'error');
    }
  }

  function onDropToLine(e, line) {
    e.preventDefault();
    const opIds = readDropOpIds(e);
    if (opIds.length) handleBulkAssign(opIds, line);
  }

  async function handleAutoAssign() {
    if (!canManageFloor) return;
    if (availableOperators.length === 0) {
      showToast('No available operators (clocked-in and unassigned)', 'error');
      return;
    }

    const slots = [];
    for (const line of DISPATCH_LINE_ORDER) {
      const n = Math.max(0, parseInt(targets[line], 10) || 0);
      for (let i = 0; i < n; i++) slots.push(line);
    }

    if (slots.length === 0) {
      showToast('Enter a D1/D2 target headcount before auto-assigning', 'error');
      return;
    }

    const pairCount = Math.min(availableOperators.length, slots.length);
    const assignments = [];
    for (let i = 0; i < pairCount; i++) {
      assignments.push({ operator_id: availableOperators[i].id, line: slots[i] });
    }

    const skipped  = availableOperators.length - assignments.length;
    const unfilled = slots.length - assignments.length;

    try {
      await workerFetch('bulkAssignManpower',
        { data: { assignments, shift_date: date } },
        session
      );
      const pieces = [`Assigned ${assignments.length} operator${assignments.length === 1 ? '' : 's'}`];
      if (skipped > 0)  pieces.push(`${skipped} had no slot`);
      if (unfilled > 0) pieces.push(`${unfilled} slot${unfilled === 1 ? '' : 's'} unfilled`);
      showToast(pieces.join(' · '), 'success');
      setSelectedOpIds(new Set());
      load();
    } catch (e) {
      showToast(e.message || 'Auto-assign failed', 'error');
    }
  }

  function toggleSelected(opId) {
    setSelectedOpIds((prev) => {
      const next = new Set(prev);
      if (next.has(opId)) next.delete(opId);
      else next.add(opId);
      return next;
    });
  }

  if (!canManageFloor) {
    return (
      <Panel>
        <EmptyNote icon="layers" title="Restricted" sub="Daily Roster is restricted to floor supervisors." />
      </Panel>
    );
  }

  // shared picker dropdown (assign fallback) — logic identical, restyled
  function Picker({ pkey, line, ops }) {
    const open = !!pickerOpen[pkey];
    return (
      <div ref={(el) => { pickerRefs.current[pkey] = el; }} style={{ position: 'relative' }}>
        <button
          style={{ width: 22, height: 22, borderRadius: 'var(--r-xs)', background: 'var(--surface-3)',
            border: '1px solid var(--border-2)', color: 'var(--t2)', cursor: 'pointer',
            display: 'grid', placeItems: 'center' }}
          onClick={() => {
            setPickerOpen((s) => ({ ...s, [pkey]: !s[pkey] }));
            setPickerQuery((s) => ({ ...s, [pkey]: '' }));
          }}
          title={open ? 'Close' : `Assign to ${line}`}
        >
          <Icon name={open ? 'x' : 'plus'} size={13} />
        </button>
        {open && (
          <div style={{
            position: 'absolute', top: '100%', right: 0,
            marginTop: 4, zIndex: 20, width: 250,
            background: 'var(--surface-2)', border: '1px solid var(--border-2)',
            borderRadius: 'var(--r-sm)', boxShadow: 'var(--shadow-pop)',
            animation: 'rl-pop-in 140ms var(--ease)', overflow: 'hidden',
          }}>
            <input
              type="text"
              autoFocus
              placeholder="Search name or ID…"
              value={pickerQuery[pkey] || ''}
              onChange={(e) => {
                setPickerQuery((s) => ({ ...s, [pkey]: e.target.value }));
                setPickerHighlight((s) => ({ ...s, [pkey]: -1 }));
              }}
              onKeyDown={(e) => {
                const visible = ops.slice(0, 50);
                const hi = pickerHighlight[pkey] ?? -1;
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setPickerHighlight((s) => ({ ...s, [pkey]: Math.min((hi < 0 ? -1 : hi) + 1, visible.length - 1) }));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setPickerHighlight((s) => ({ ...s, [pkey]: Math.max(hi - 1, 0) }));
                } else if (e.key === 'Enter') {
                  if (hi >= 0 && visible[hi]) {
                    e.preventDefault();
                    handleAssign(visible[hi].id, line);
                    setPickerOpen((s) => ({ ...s, [pkey]: false }));
                    setPickerQuery((s) => ({ ...s, [pkey]: '' }));
                    setPickerHighlight((s) => ({ ...s, [pkey]: -1 }));
                  }
                } else if (e.key === 'Escape') {
                  setPickerOpen((s) => ({ ...s, [pkey]: false }));
                  setPickerHighlight((s) => ({ ...s, [pkey]: -1 }));
                }
              }}
              style={{ ...kitInput, fontSize: 12.5, borderRadius: 0, border: 'none', borderBottom: '1px solid var(--border)' }}
            />
            <div style={{ maxHeight: 220, overflowY: 'auto' }}>
              {ops.length === 0 ? (
                <div style={{ padding: '9px 12px', color: 'var(--t3)', fontFamily: 'var(--font-ui)', fontSize: 12 }}>
                  No available operators
                </div>
              ) : (
                ops.slice(0, 50).map((op, opIdx) => {
                  const isHi = (pickerHighlight[pkey] ?? -1) === opIdx;
                  return (
                    <div
                      key={op.id}
                      ref={isHi ? highlightedPickerRef : null}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        handleAssign(op.id, line);
                        setPickerOpen((s) => ({ ...s, [pkey]: false }));
                        setPickerQuery((s) => ({ ...s, [pkey]: '' }));
                        setPickerHighlight((s) => ({ ...s, [pkey]: -1 }));
                      }}
                      onMouseEnter={() => setPickerHighlight((s) => ({ ...s, [pkey]: opIdx }))}
                      style={{ padding: '7px 11px', cursor: 'pointer', fontFamily: 'var(--font-ui)', fontSize: 12.5,
                        color: 'var(--t1)', background: isHi ? 'var(--surface-3)' : 'transparent' }}
                    >
                      <div>{op.name}</div>
                      <div className="num" style={{ fontSize: 9.5, color: 'var(--t3)', marginTop: 1 }}>
                        {op.employee_id || '—'} · {(op.department || '').toUpperCase()}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  function AssignedCard({ row, accent, onRemove, removeTitle, dashed }) {
    return (
      <div style={{
        background: 'var(--surface)',
        border: dashed ? '1px dashed var(--orange)' : '1px solid var(--border)',
        borderRadius: 'var(--r-sm)',
        padding: '7px 9px',
        marginBottom: 4,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <Avatar name={row.operator_name} size={24} color={accent} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 500, color: 'var(--t1)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {row.operator_name || '(unknown)'}
          </div>
          {dashed ? (
            <div style={{ fontFamily: 'var(--font-ui)', fontSize: 10, color: 'var(--orange)', marginTop: 2 }}>
              Legacy row · re-drag to a section
            </div>
          ) : row.operator_department ? (
            <div className="eyebrow" style={{ fontSize: 9, marginTop: 2 }}>
              {row.operator_department}
            </div>
          ) : null}
        </div>
        <button
          onClick={onRemove}
          title={removeTitle}
          style={{
            background: 'transparent', border: '1px solid var(--border-2)', color: 'var(--bad-fg)',
            cursor: 'pointer', borderRadius: 'var(--r-xs)', width: 20, height: 20,
            display: 'grid', placeItems: 'center', flexShrink: 0,
          }}
        >
          <Icon name="x" size={11} />
        </button>
      </div>
    );
  }

  const dropZone = {
    border: '1.5px dashed var(--border-2)', borderRadius: 'var(--r-sm)',
    padding: '13px 10px', textAlign: 'center',
  };

  return (
    <div>
      {/* date + totals */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 14 }}>
        <div>
          <span className="eyebrow" style={{ display: 'block', marginBottom: 6 }}>Date</span>
          <input type="date" className="num" value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle} />
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>
          <span className="num" style={{ fontSize: 11.5, color: 'var(--t3)' }}>{totalAssigned} assigned</span>
          <button style={smallGhost} onClick={load} disabled={loading} title="Refresh">
            <Icon name="undo" size={13} /> Refresh
          </button>
        </div>
      </div>

      {/* targets — optional D1/D2 headcounts for auto-assign */}
      <Panel pad={0} style={{ marginBottom: 14 }}>
        <div style={{ padding: '12px 15px', display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
          <span className="eyebrow">Targets</span>
          {DISPATCH_LINE_ORDER.map((line) => (
            <label key={line} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="num" style={{ fontSize: 11.5, color: BUCKET_COLOR[line], minWidth: 18, fontWeight: 700 }}>{line}</span>
              <input
                type="number"
                min="0"
                className="num"
                value={targets[line]}
                onChange={(e) => setTargets((prev) => ({ ...prev, [line]: e.target.value }))}
                style={{ ...inputStyle, width: 48, textAlign: 'center', padding: '3px 6px', fontSize: 12 }}
              />
            </label>
          ))}
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--t3)' }}>
            Auto-assign fills D1 then D2 from the available pool.
          </span>
          <button
            onClick={handleAutoAssign}
            disabled={availableOperators.length === 0}
            style={{
              ...btnPrimary,
              marginLeft: 'auto',
              padding: '7px 13px',
              opacity: availableOperators.length === 0 ? 0.5 : 1,
              cursor: availableOperators.length === 0 ? 'not-allowed' : 'pointer',
            }}
          >
            Auto-assign ({availableOperators.length} available)
          </button>
        </div>
      </Panel>

      {/* available pool */}
      <Panel pad={0} style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          padding: '11px 15px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
          <span className="label" style={{ fontSize: 12, color: 'var(--t1)' }}>
            Available <span className="num" style={{ color: 'var(--t3)' }}>({availableOperators.length})</span>
          </span>
          {selectedOpIds.size > 0 && (
            <span className="num" style={{ fontSize: 11, color: 'var(--yellow)' }}>
              {selectedOpIds.size} selected · drag to assign
            </span>
          )}
        </div>
        <div style={{ padding: '11px 15px', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {availableOperators.length === 0 ? (
            <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--t3)' }}>
              {loading
                ? 'Loading…'
                : activeOperators.length === 0
                  ? 'No operators loaded'
                  : 'No clocked-in operators left to assign'}
            </div>
          ) : (
            availableOperators.map((op) => {
              const isSelected = selectedOpIds.has(op.id);
              return (
                <div
                  key={op.id}
                  draggable
                  onDragStart={(e) => onPoolDragStart(e, op)}
                  title={isSelected ? 'Drag to assign selected operators' : 'Click checkbox to multi-select, or drag this chip'}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '4px 9px 4px 6px', borderRadius: 'var(--r-full)',
                    background: isSelected ? 'var(--yellow)' : 'var(--surface-2)',
                    color: isSelected ? '#1a1a1a' : 'var(--t1)',
                    border: `1px solid ${isSelected ? 'var(--yellow)' : 'var(--border-2)'}`,
                    cursor: 'grab', userSelect: 'none',
                    fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 500,
                  }}
                >
                  <span
                    onClick={(e) => { e.stopPropagation(); toggleSelected(op.id); }}
                    style={{
                      width: 14, height: 14, borderRadius: 3, flexShrink: 0,
                      border: `1.5px solid ${isSelected ? '#1a1a1a' : 'var(--border-3)'}`,
                      background: isSelected ? '#1a1a1a' : 'transparent',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      cursor: 'pointer',
                    }}
                  >
                    {isSelected && (
                      <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                        <path d="M1 4l2 2 4-4" stroke="var(--yellow)" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                    )}
                  </span>
                  <span>{op.name}</span>
                  <span className="eyebrow" style={{ fontSize: 8.5, color: isSelected ? '#1a1a1a' : 'var(--t3)' }}>
                    {(op.department || '').slice(0, 4)}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </Panel>

      <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11.5, color: 'var(--t3)', marginBottom: 10 }}>
        Assign dispatch operators to a line. Log what each one is doing (Order Packing · Returns ·
        Admin) on <strong style={{ color: 'var(--t2)' }}>Dispatch → Dispatch Roster</strong>.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
          {DISPATCH_LINE_ORDER.map((line) => {
            const lineRows = grouped[line] || [];
            const accent = BUCKET_COLOR[line];
            const key = line;
            const q = (pickerQuery[key] || '').trim().toLowerCase();
            const pickerOps = activeOperators.filter((op) => {
              if (assignedOpIds.has(op.id)) return false;
              if (!q) return true;
              return (op.name || '').toLowerCase().includes(q) ||
                     (op.employee_id || '').toLowerCase().includes(q);
            });
            return (
              <div key={line} style={{ background: 'var(--surface)', border: '1px solid var(--border)',
                borderTop: `3px solid ${accent}`, borderRadius: 'var(--r-md)', boxShadow: 'var(--shadow-card)', minHeight: 220 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '11px 13px', borderBottom: '1px solid var(--border)' }}>
                  <span className="font-display" style={{ fontSize: 16, fontWeight: 700, letterSpacing: '0.04em', color: accent }}>
                    {line}
                  </span>
                  <span className="num" style={{ fontSize: 11.5, fontWeight: 600, padding: '1px 8px',
                    borderRadius: 'var(--r-full)', background: 'var(--surface-2)', color: 'var(--t2)' }}>
                    {lineRows.length}
                  </span>
                </div>
                <div
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => onDropToLine(e, line)}
                  style={{ padding: '8px 8px 10px' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 7 }}>
                    <span className="eyebrow">
                      Operators <span className="num" style={{ color: 'var(--t4)' }}>({lineRows.length})</span>
                    </span>
                    <Picker pkey={key} line={line} ops={pickerOps} />
                  </div>
                  {loading ? (
                    <div style={{ padding: 12, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
                  ) : lineRows.length === 0 ? (
                    <div style={dropZone}>
                      <span className="eyebrow" style={{ fontSize: 9 }}>Drop operator here</span>
                    </div>
                  ) : (
                    lineRows.map((row) => (
                      <AssignedCard
                        key={row.id}
                        row={row}
                        accent={accent}
                        onRemove={() => handleUnassign(row, line)}
                        removeTitle={`Remove ${row.operator_name || 'operator'} from ${line}`}
                      />
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
    </div>
  );
}

function Field({ label, full, children }) {
  return (
    <div style={{ gridColumn: full ? '1 / -1' : 'auto' }}>
      <span className="eyebrow" style={{ display: 'block', marginBottom: 6 }}>{label}</span>
      {children}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ShiftsTab (Phase 2) — team-owned, effective-dated, audited shift timings.
// Production + Dispatch manage their shifts here (Store manages in Garage).
// Editing a time writes a NEW effective-dated version (never overwrites) → full
// audit trail. Worker: getShifts / createShift / renameShift / setShiftActive /
// addShiftVersion / getShiftHistory. Read by the recordAttendance resolver.
// ═══════════════════════════════════════════════════════════════════════════
// Depot is dispatch-only — it manages dispatch shifts here. Production
// (assembly/qc/packaging/admin) shifts live in Redline; store in Garage.
const SHIFT_DEPTS = ['dispatch'];
const modalInput = { ...kitInput, width: '100%', fontSize: 13, padding: '8px 11px' };
const shTd = { padding: '9px 10px', fontSize: 13, color: 'var(--t2)', borderBottom: '1px solid var(--border)' };
const shTh = { textAlign: 'left', padding: '8px 10px', fontSize: 11, textTransform: 'uppercase',
  letterSpacing: '.08em', color: 'var(--t3)', borderBottom: '1px solid var(--border)' };
function fmtHM(t) { return t ? String(t).slice(0, 5) : null; }

function ShiftsTab({ session, canManageFloor }) {
  const { showToast } = useToast();
  const [shifts, setShifts] = useState([]);
  const [dispatchOps, setDispatchOps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editTarget, setEditTarget] = useState(null);
  const [histTarget, setHistTarget] = useState(null);
  const [addDept, setAddDept] = useState(null);

  const load = useCallback(async () => {
    if (!session || !canManageFloor) return;
    setLoading(true);
    try {
      const [shRes, opRes] = await Promise.all([
        workerFetch('getShifts', { data: {} }, session),
        workerFetch('getOperators', { data: { department: 'dispatch', status: 'active' } }, session),
      ]);
      const list = Array.isArray(shRes?.data) ? shRes.data : [];
      setShifts(list.filter((s) => SHIFT_DEPTS.includes(s.department)));
      setDispatchOps(Array.isArray(opRes?.data) ? opRes.data : []);
    } catch (e) {
      showToast(e.message || 'Failed to load shifts', 'error');
    } finally { setLoading(false); }
  }, [session, canManageFloor, showToast]);
  useEffect(() => { load(); }, [load]);

  async function toggleActive(s) {
    try {
      await workerFetch('setShiftActive', { data: { shift_id: s.id, is_active: !s.is_active } }, session);
      load();
    } catch (e) { showToast(e.message || 'Failed', 'error'); }
  }
  async function assignOp(operator_id, shift_id) {
    try {
      await workerFetch('setOperatorShift', { data: { operator_id, shift_id: shift_id || null } }, session);
      load();
    } catch (e) { showToast(e.message || 'Failed', 'error'); }
  }

  if (!canManageFloor) return <Panel><div style={{ padding: 20, color: 'var(--t3)' }}>Restricted to floor supervisors.</div></Panel>;
  if (loading) return <div style={{ padding: 40, textAlign: 'center' }}><Spinner /></div>;

  const byDept = {};
  for (const s of shifts) (byDept[s.department] = byDept[s.department] || []).push(s);

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ fontSize: 13, color: 'var(--t3)', maxWidth: 700 }}>
        Dispatch shift timings drive attendance — the clock-in window, the end time, and overtime.
        Changing a time takes effect from the date you pick and is saved as a new version;
        older versions stay for the record. Names are yours to set. (Production shifts are managed
        in Redline; store in Garage.)
      </div>
      {SHIFT_DEPTS.map((dept) => (
        <Panel key={dept} title={capitalize(dept)}
          action={<button style={smallGhost} onClick={() => setAddDept(dept)}>+ Add shift</button>}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={shTh}>Shift</th><th style={shTh}>Timing</th>
                <th style={shTh}>Effective</th><th style={shTh}>Status</th>
                <th style={{ ...shTh, textAlign: 'right' }}></th>
              </tr></thead>
              <tbody>
                {(byDept[dept] || []).map((s) => (
                  <tr key={s.id} style={{ opacity: s.is_active ? 1 : 0.55 }}>
                    <td style={shTd}>{s.name}</td>
                    <td style={shTd}>{s.current
                      ? `${fmtHM(s.current.start_time)}–${fmtHM(s.current.end_time)}${s.current.ends_next_day ? ' (+1d)' : ''}`
                      : <span style={{ color: 'var(--t3)' }}>— not set —</span>}</td>
                    <td style={shTd}>{s.current?.effective_from || '—'}</td>
                    <td style={shTd}><ToneBadge tone={s.is_active ? 'ok' : 'mute'}>{s.is_active ? 'Active' : 'Off'}</ToneBadge></td>
                    <td style={{ ...shTd, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button style={smallGhost} onClick={() => setEditTarget(s)}>Edit timing</button>{' '}
                      <button style={smallGhost} onClick={() => setHistTarget(s)}>History</button>{' '}
                      <button style={smallGhost} onClick={() => toggleActive(s)}>{s.is_active ? 'Disable' : 'Enable'}</button>
                    </td>
                  </tr>
                ))}
                {!(byDept[dept] || []).length && (
                  <tr><td colSpan={5} style={{ ...shTd, color: 'var(--t3)' }}>No shifts yet — add one.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>
      ))}

      {(byDept['dispatch'] || []).length > 1 && (
        <Panel title="Dispatch — assign operators to shifts">
          <div style={{ fontSize: 12.5, color: 'var(--t3)', marginBottom: 10 }}>
            Dispatch shifts overlap, so a person's shift can't be read from scan time — set each
            operator's home shift here. (Unassigned falls back to the earliest matching shift.)
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={shTh}>Operator</th><th style={shTh}>ID</th><th style={shTh}>Home shift</th></tr></thead>
              <tbody>
                {dispatchOps.map((o) => (
                  <tr key={o.id}>
                    <td style={shTd}>{o.name}</td>
                    <td style={shTd}>{o.employee_id}</td>
                    <td style={shTd}>
                      <select value={o.shift_id || ''} onChange={(e) => assignOp(o.id, e.target.value)} style={selectStyle}>
                        <option value="">— unassigned —</option>
                        {(byDept['dispatch'] || []).map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}{s.current ? ` (${fmtHM(s.current.start_time)}–${fmtHM(s.current.end_time)})` : ''}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
                {!dispatchOps.length && <tr><td colSpan={3} style={{ ...shTd, color: 'var(--t3)' }}>No active dispatch operators.</td></tr>}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {editTarget && <EditTimingModal shift={editTarget} session={session} onClose={() => setEditTarget(null)} onSaved={() => { setEditTarget(null); load(); }} />}
      {histTarget && <ShiftHistoryModal shift={histTarget} session={session} onClose={() => setHistTarget(null)} />}
      {addDept && <AddShiftModal dept={addDept} session={session} onClose={() => setAddDept(null)} onSaved={() => { setAddDept(null); load(); }} />}
    </div>
  );
}

function EditTimingModal({ shift, session, onClose, onSaved }) {
  const { showToast } = useToast();
  const c = shift.current || {};
  const [f, setF] = useState({
    effective_from: istToday(),
    start_time: fmtHM(c.start_time) || '09:00',
    end_time:   fmtHM(c.end_time)   || '18:00',
    ends_next_day: !!c.ends_next_day,
    in_open_lead_min:  c.in_open_lead_min  ?? 60,
    out_open_lead_min: c.out_open_lead_min ?? 60,
    grace_min:     c.grace_min     ?? 30,
    min_dwell_min: c.min_dwell_min ?? 30,
    note: '',
  });
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  async function save() {
    setSaving(true);
    try {
      const res = await workerFetch('addShiftVersion', { data: {
        shift_id: shift.id, effective_from: f.effective_from,
        start_time: f.start_time, end_time: f.end_time, ends_next_day: f.ends_next_day,
        in_open_lead_min: Number(f.in_open_lead_min), out_open_lead_min: Number(f.out_open_lead_min),
        grace_min: Number(f.grace_min), min_dwell_min: Number(f.min_dwell_min), note: f.note || null,
      } }, session);
      if (res?.data?.ok === false) { showToast(res.data.error || 'Failed', 'error'); setSaving(false); return; }
      showToast('Shift timing updated', 'success');
      onSaved();
    } catch (e) { showToast(e.message || 'Failed', 'error'); setSaving(false); }
  }

  return (
    <Modal open onClose={onClose} title={`${capitalize(shift.department)} · ${shift.name} — edit timing`}
      confirmLabel="Save new version" onConfirm={save} loading={saving}>
      <div style={{ display: 'grid', gap: 12 }}>
        <Field label="Effective from"><input type="date" value={f.effective_from} onChange={set('effective_from')} style={modalInput} /></Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Start"><input type="time" value={f.start_time} onChange={set('start_time')} style={modalInput} /></Field>
          <Field label="End"><input type="time" value={f.end_time} onChange={set('end_time')} style={modalInput} /></Field>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: 'var(--t2)' }}>
          <input type="checkbox" checked={f.ends_next_day} onChange={set('ends_next_day')} /> Ends next day (overnight shift)
        </label>
        <details>
          <summary style={{ cursor: 'pointer', fontSize: 12.5, color: 'var(--t3)' }}>Advanced — windows · grace · min-dwell</summary>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
            <Field label="Clock-in opens (min before start)"><input type="number" value={f.in_open_lead_min} onChange={set('in_open_lead_min')} style={modalInput} /></Field>
            <Field label="Clock-out opens (min before end)"><input type="number" value={f.out_open_lead_min} onChange={set('out_open_lead_min')} style={modalInput} /></Field>
            <Field label="OT grace (min past end)"><input type="number" value={f.grace_min} onChange={set('grace_min')} style={modalInput} /></Field>
            <Field label="Min dwell before clock-out (min)"><input type="number" value={f.min_dwell_min} onChange={set('min_dwell_min')} style={modalInput} /></Field>
          </div>
        </details>
        <Field label="Note (optional — why the change)"><input value={f.note} onChange={set('note')} style={modalInput} placeholder="e.g. summer hours" /></Field>
      </div>
    </Modal>
  );
}

function AddShiftModal({ dept, session, onClose, onSaved }) {
  const { showToast } = useToast();
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  async function save() {
    if (!name.trim()) { showToast('Name required', 'error'); return; }
    setSaving(true);
    try {
      await workerFetch('createShift', { data: { department: dept, name: name.trim() } }, session);
      showToast('Shift added — set its timing next', 'success');
      onSaved();
    } catch (e) { showToast(e.message || 'Failed', 'error'); setSaving(false); }
  }
  return (
    <Modal open onClose={onClose} title={`Add shift — ${capitalize(dept)}`}
      confirmLabel="Add shift" onConfirm={save} loading={saving}>
      <Field label="Shift name"><input value={name} onChange={(e) => setName(e.target.value)} style={modalInput} placeholder="e.g. First, GT, Night…" autoFocus /></Field>
    </Modal>
  );
}

function ShiftHistoryModal({ shift, session, onClose }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    workerFetch('getShiftHistory', { data: { shift_id: shift.id } }, session)
      .then((r) => setRows(Array.isArray(r?.data) ? r.data : []))
      .catch(() => setRows([]));
  }, [shift, session]);
  return (
    <Modal open onClose={onClose} title={`${shift.name} — version history`}>
      {rows === null ? <div style={{ padding: 20, textAlign: 'center' }}><Spinner /></div>
        : !rows.length ? <div style={{ color: 'var(--t3)' }}>No versions.</div> : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={shTh}>Effective</th><th style={shTh}>Timing</th><th style={shTh}>Added · note</th></tr></thead>
          <tbody>
            {rows.map((v) => (
              <tr key={v.id}>
                <td style={shTd}>{v.effective_from}</td>
                <td style={shTd}>{fmtHM(v.start_time)}–{fmtHM(v.end_time)}{v.ends_next_day ? ' (+1d)' : ''}</td>
                <td style={shTd}>{v.created_at ? new Date(v.created_at).toLocaleDateString('en-IN') : '—'}{v.note ? ` · ${v.note}` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
