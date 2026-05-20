'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Badge, ConfirmModal, DataTable, EmptyState, Modal, Spinner, useToast } from '@throttle/ui';
import { useAutoRefresh } from '../../../hooks/useAutoRefresh.js';
import { useRefreshState } from '../layout.js';

// ── Constants ───────────────────────────────────────────────────────────────
const LINE_ORDER          = ['L1', 'L2', 'L3'];
const DISPATCH_LINE_ORDER = ['D1', 'D2'];
const OTHERS_DEPT_BUCKETS = ['Admin', 'Store'];  // visual split of line='Others' by operator department
const LINE_COLORS         = { L1: 'var(--yellow)', L2: 'var(--blue)', L3: 'var(--green)', D1: '#ec4899', D2: '#06b6d4', Others: '#f97316', Admin: '#f59e0b', Store: '#a855f7' };
const ROSTER_LINE_COLORS  = { L1: '#22c55e', L2: '#3b82f6', L3: '#a855f7', D1: '#ec4899', D2: '#06b6d4', Others: '#f97316', Admin: '#f59e0b', Store: '#f97316' };
const ROSTER_SECTIONS     = ['Assembly', 'QC', 'Packaging'];
const PERFORMANCE_CATEGORIES = [
  { value: 'attendance', label: 'Attendance' },
  { value: 'quality',    label: 'Quality' },
  { value: 'behaviour',  label: 'Behaviour' },
  { value: 'output',     label: 'Output' },
  { value: 'other',      label: 'Other' },
];

// ── Shared styles ───────────────────────────────────────────────────────────
const panelStyle       = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const panelHeaderStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)', gap: 8, flexWrap: 'wrap' };
const panelBodyStyle   = { padding: '12px 14px' };
const inputStyle       = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px', fontSize: 12, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit' };
const selectStyle      = { ...inputStyle, cursor: 'pointer' };
const labelStyle       = { fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block' };
const btnPrimary       = { background: 'var(--yellow)', border: '1px solid var(--yellow)', borderRadius: 3, padding: '10px 16px', fontSize: 12, fontWeight: 700, color: '#000', cursor: 'pointer', fontFamily: 'var(--cond)', letterSpacing: '0.04em' };
const btnSecondary     = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 12px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)' };

// ── Display helpers ─────────────────────────────────────────────────────────
function capitalize(s) { return (s || '').charAt(0).toUpperCase() + (s || '').slice(1); }
function fmtDate(d) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return '—'; }
}
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

// getManpowerLog returns { L1: { Assembly:[], QC:[], Packaging:[], Unassigned:[] }, ...,
// Others: [...], D1: [...], D2: [...] }. L1/L2/L3 nested by station; D1/D2 and
// Others arrive flat. flattenRoster collapses everything to flat arrays per line.
function flattenRoster(nested) {
  const out = { L1: [], L2: [], L3: [], D1: [], D2: [], Others: [] };
  for (const line of LINE_ORDER) {
    const sections = nested?.[line];
    if (!sections) continue;
    if (Array.isArray(sections)) { out[line] = sections; continue; } // legacy shape
    out[line] = [
      ...(sections.Assembly   || []),
      ...(sections.QC         || []),
      ...(sections.Packaging  || []),
      ...(sections.Unassigned || []),
    ];
  }
  for (const line of DISPATCH_LINE_ORDER) {
    if (Array.isArray(nested?.[line])) out[line] = nested[line];
  }
  if (Array.isArray(nested?.Others)) out.Others = nested.Others;
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// Manpower page — 4 tabs: Live View, Attendance, Daily Roster, Performance.
// Live View keeps the existing read-only floor view (60s auto-refresh).
// The other three are ports of Garage /manpower tabs (now removed from Garage).
// ═══════════════════════════════════════════════════════════════════════════
export default function ManpowerPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [activeTab, setActiveTab] = useState('live');
  // Page-level operators cache, shared by Attendance / Daily Roster / Performance.
  const [allOperators, setAllOperators] = useState([]);

  const canManageFloor = !!(perms?.users_manage || perms?.production_view || perms?.procurement_approve);

  useEffect(() => {
    if (!session || !canManageFloor) return;
    if (activeTab === 'live') return; // live view fetches its own data
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
      <div style={{ padding: 24 }}>
        <EmptyState message="Manpower view is restricted to floor supervisors." />
      </div>
    );
  }

  return (
    <div style={{ color: 'var(--t1)' }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontFamily: 'var(--cond)', fontSize: 28, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.03em', margin: 0 }}>
          Manpower
        </h1>
        <p style={{ color: 'var(--t3)', fontSize: 11, marginTop: 4, fontFamily: 'var(--mono)' }}>
          Live floor view, attendance, daily roster, and performance.
        </p>
      </div>

      <TabBar
        tabs={[
          { key: 'live',        label: 'Live View' },
          { key: 'attendance',  label: 'Attendance' },
          { key: 'roster',      label: 'Daily Roster' },
          { key: 'performance', label: 'Performance' },
        ]}
        active={activeTab}
        onChange={setActiveTab}
      />

      {activeTab === 'live'        && <LiveViewTab session={session} canManageFloor={canManageFloor} />}
      {activeTab === 'attendance'  && <AttendanceTab session={session} canManageFloor={canManageFloor} operators={allOperators} />}
      {activeTab === 'roster'      && <DailyRosterTab session={session} canManageFloor={canManageFloor} operators={allOperators} />}
      {activeTab === 'performance' && <PerformanceTab session={session} canManageFloor={canManageFloor} operators={allOperators} />}
    </div>
  );
}

// ── TabBar ──────────────────────────────────────────────────────────────────
function TabBar({ tabs, active, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)', marginBottom: 16 }}>
      {tabs.map((t) => {
        const on = t.key === active;
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            style={{
              background: 'transparent',
              border: 'none',
              borderBottom: on ? '2px solid var(--yellow)' : '2px solid transparent',
              padding: '8px 14px',
              fontFamily: 'var(--cond)',
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              color: on ? 'var(--yellow)' : 'var(--t2)',
              cursor: 'pointer',
              marginBottom: -1,
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// LiveViewTab — existing read-only floor view. Auto-refresh every 60s.
// ═══════════════════════════════════════════════════════════════════════════
function LiveViewTab({ session, canManageFloor }) {
  const { showToast } = useToast();
  const { setRefreshing, setLastRefreshed } = useRefreshState();
  const [today] = useState(() => istToday());
  const [openShifts, setOpenShifts] = useState([]);
  const [rosterByLine, setRosterByLine] = useState({});
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);

  const loadData = useCallback(async () => {
    if (!session || !canManageFloor) return;
    setRefreshing(true);
    try {
      const [attRes, rosterRes] = await Promise.all([
        workerFetch('getOperatorAttendance', { data: { date_from: today, date_to: today } }, session),
        workerFetch('getManpowerLog',         { data: { shift_date: today } },                session),
      ]);

      const attRows = Array.isArray(attRes?.data) ? attRes.data : Array.isArray(attRes) ? attRes : [];
      setOpenShifts(attRows.filter((r) => !r.clock_out));

      const rosterInner = rosterRes?.data;
      const grouped = rosterInner && typeof rosterInner === 'object' && !Array.isArray(rosterInner)
        ? rosterInner
        : {};
      setRosterByLine(flattenRoster(grouped));
      setForbidden(false);
    } catch (e) {
      const msg = e.message || 'Failed to load manpower';
      if (msg.toLowerCase().includes('permission') || msg.includes('403')) {
        setForbidden(true);
      } else {
        showToast(msg, 'error');
      }
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
  }, [session, canManageFloor, today, setRefreshing, setLastRefreshed, showToast]);

  useAutoRefresh(loadData, 60000, !session || !canManageFloor);

  const assignedLineByOpId = useMemo(() => {
    const m = {};
    for (const line of LINE_ORDER) {
      for (const a of rosterByLine[line] || []) m[a.operator_id] = line;
    }
    for (const line of DISPATCH_LINE_ORDER) {
      for (const a of rosterByLine[line] || []) m[a.operator_id] = line;
    }
    for (const a of rosterByLine.Others || []) m[a.operator_id] = 'Others';
    return m;
  }, [rosterByLine]);

  const { byLine, dispatch, store, others, unassigned } = useMemo(() => {
    const lines = { L1: [], L2: [], L3: [] };
    const disp = [];
    const str = [];
    const oth = [];
    const unas = [];
    for (const row of openShifts) {
      const line = assignedLineByOpId[row.operator_id];
      if (line === 'D1' || line === 'D2') disp.push(row);
      else if (line === 'Others') {
        if ((row.operator_department || '').toLowerCase() === 'store') str.push(row);
        else oth.push(row);
      }
      else if (line && lines[line]) lines[line].push(row);
      else unas.push(row);
    }
    return { byLine: lines, dispatch: disp, store: str, others: oth, unassigned: unas };
  }, [openShifts, assignedLineByOpId]);

  if (forbidden) {
    return (
      <div style={{ padding: 24 }}>
        <EmptyState message="Manpower view is restricted to floor supervisors." />
      </div>
    );
  }

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <span style={{ color: 'var(--t3)', fontSize: 11, fontFamily: 'var(--mono)' }}>
          {fmtIstDate(today)} · open shifts only · refreshes every 60s.
        </span>
      </div>

      {loading && openShifts.length === 0 && Object.keys(rosterByLine).length === 0 ? (
        <div style={{ padding: 48, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
      ) : (
        <>
          {/* Headcount bar */}
          {(() => {
            const othersAssigned = (rosterByLine.Others || []).filter(
              (r) => (r.operator_department || '').toLowerCase() !== 'store',
            );
            const storeAssigned = (rosterByLine.Others || []).filter(
              (r) => (r.operator_department || '').toLowerCase() === 'store',
            );
            return (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 12, marginBottom: 16 }}>
            {LINE_ORDER.map((line) => (
              <HeadcountCard
                key={line}
                label={line}
                accent={LINE_COLORS[line]}
                count={byLine[line].length}
                sub={`${(rosterByLine[line] || []).length} assigned`}
              />
            ))}
            <HeadcountCard
              label="Dispatch"
              accent={LINE_COLORS.D1}
              count={dispatch.length}
              sub={`${((rosterByLine.D1 || []).length) + ((rosterByLine.D2 || []).length)} assigned`}
            />
            <HeadcountCard
              label="Store"
              accent={LINE_COLORS.Store}
              count={store.length}
              sub={`${storeAssigned.length} assigned`}
            />
            <HeadcountCard
              label="Others"
              accent={LINE_COLORS.Others}
              count={others.length}
              sub={`${othersAssigned.length} assigned`}
            />
            <HeadcountCard
              label="Unassigned"
              accent="var(--t3)"
              count={unassigned.length}
              sub="open shift, no line"
            />
          </div>
            );
          })()}

          {/* Line sections */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12, marginBottom: 16 }}>
            {LINE_ORDER.map((line) => (
              <LineColumn key={line} line={line} rows={byLine[line]} accent={LINE_COLORS[line]} />
            ))}
          </div>

          {others.length > 0 && (
            <OthersSection rows={others} accent={LINE_COLORS.Others} />
          )}

          {unassigned.length > 0 && (
            <UnassignedSection rows={unassigned} />
          )}
        </>
      )}
    </div>
  );
}

function HeadcountCard({ label, accent, count, sub }) {
  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderLeft: `3px solid ${accent}`,
      borderRadius: 3,
      padding: '12px 14px',
      display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        {label}
      </span>
      <span style={{ fontFamily: 'var(--cond)', fontSize: 28, fontWeight: 800, color: accent, lineHeight: 1 }}>
        {count}
      </span>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>
        {count === 1 ? '1 on floor' : `${count} on floor`}{sub ? ` · ${sub}` : ''}
      </span>
    </div>
  );
}

function LineColumn({ line, rows, accent }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4 }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 14px', borderBottom: '1px solid var(--border)',
        fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700,
        letterSpacing: '0.06em', textTransform: 'uppercase',
        color: accent,
      }}>
        <span>{line}</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>({rows.length})</span>
      </div>
      <div style={{ padding: '12px 14px' }}>
        {rows.length === 0 ? (
          <div style={{ color: 'var(--t3)', fontSize: 11, fontFamily: 'var(--mono)' }}>
            — No operators assigned
          </div>
        ) : (
          rows.map((row) => (
            <OperatorCard key={row.id} row={row} accent={accent} />
          ))
        )}
      </div>
    </div>
  );
}

function UnassignedSection({ rows }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4 }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 14px', borderBottom: '1px solid var(--border)',
        fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700,
        letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)',
      }}>
        <span>Unassigned</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>({rows.length})</span>
      </div>
      <div style={{ padding: '12px 14px', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {rows.map((row) => (
          <div key={row.id} style={{ minWidth: 220, flex: '0 1 240px' }}>
            <OperatorCard row={row} accent="var(--t3)" />
          </div>
        ))}
      </div>
    </div>
  );
}

function OthersSection({ rows, accent }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 14px', borderBottom: '1px solid var(--border)',
        fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700,
        letterSpacing: '0.06em', textTransform: 'uppercase', color: accent,
      }}>
        <span>Others</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>({rows.length})</span>
      </div>
      <div style={{ padding: '12px 14px', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {rows.map((row) => (
          <div key={row.id} style={{ minWidth: 220, flex: '0 1 240px' }}>
            <OperatorCard row={row} accent={accent} />
          </div>
        ))}
      </div>
    </div>
  );
}

function OperatorCard({ row, accent }) {
  const isOvertime = (row.shift_type || '').toLowerCase() === 'overtime';
  return (
    <div style={{
      background: 'var(--surface2)',
      border: '1px solid var(--border)',
      borderLeft: `3px solid ${accent}`,
      borderRadius: 3,
      padding: '8px 10px',
      marginBottom: 6,
      display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <div style={{ fontSize: 12, color: 'var(--t1)', fontWeight: 600 }}>
        {row.operator_name || '(unknown)'}
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <Badge color="var(--t3)">{capitalize(row.operator_department || '—')}</Badge>
        <Badge color={isOvertime ? 'var(--yellow)' : 'var(--t2)'}>
          {isOvertime ? 'OVERTIME' : 'STANDARD'}
        </Badge>
      </div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>
        Clock In · {fmtIstTime(row.clock_in) || '—'}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// AttendanceTab — daily clock-in/out view with close-shift action.
// Worker: getOperatorAttendance + closeAttendanceShift (canManageFloor gate).
// ═══════════════════════════════════════════════════════════════════════════
function AttendanceTab({ session, canManageFloor, operators }) {
  const { showToast } = useToast();
  const [date, setDate] = useState(istToday());
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [closeTarget, setCloseTarget] = useState(null);
  const [closing, setClosing] = useState(false);

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
      const res = await workerFetch(
        'getOperatorAttendance',
        { data: { date_from: date, date_to: date } },
        session
      );
      const list = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
      setRows(list);
    } catch (e) {
      showToast(e.message || 'Failed to load attendance', 'error');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [session, canManageFloor, date, showToast]);

  useEffect(() => { load(); }, [load]);

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
      <div style={{ ...panelStyle, padding: '40px 24px', textAlign: 'center' }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)' }}>
          Attendance is restricted to floor supervisors.
        </div>
      </div>
    );
  }

  const columns = [
    { key: 'employee_id', label: 'Employee ID' },
    { key: 'name',        label: 'Name' },
    { key: 'department',  label: 'Department' },
    { key: 'shift',       label: 'Shift' },
    { key: 'clock_in',    label: 'Clock In' },
    { key: 'clock_out',   label: 'Clock Out' },
    { key: 'duration',    label: 'Duration' },
    { key: 'device',      label: 'Device' },
    { key: '_actions',    label: '' },
  ];

  function renderCell(row, c) {
    const op = opMap[row.operator_id];
    switch (c.key) {
      case 'employee_id':
        return <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t2)' }}>{op?.employee_id || '—'}</span>;
      case 'name':
        return row.operator_name || op?.name || '—';
      case 'department':
        return capitalize(row.operator_department || op?.department || '');
      case 'shift':
        return capitalize(row.shift_type || '');
      case 'clock_in':
        return <span style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{fmtIstTime(row.clock_in) || '—'}</span>;
      case 'clock_out':
        return row.clock_out
          ? <span style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{fmtIstTime(row.clock_out)}</span>
          : <Badge color="var(--yellow)">OPEN</Badge>;
      case 'duration':
        return <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t2)' }}>{fmtDuration(row.clock_in, row.clock_out)}</span>;
      case 'device':
        return <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>{row.clock_in_device || '—'}</span>;
      case '_actions':
        if (row.clock_out) return null;
        return (
          <button
            onClick={(e) => { e.stopPropagation(); setCloseTarget(row); }}
            style={{ ...btnSecondary, padding: '4px 8px' }}
            title="Close shift"
          >
            Close Shift
          </button>
        );
      default:
        return row[c.key];
    }
  }

  return (
    <div>
      <div style={{ ...panelStyle, marginBottom: 12 }}>
        <div style={{ padding: '10px 14px', display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <span style={labelStyle}>Date</span>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              style={{ ...inputStyle, fontFamily: 'var(--mono)' }}
            />
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              {rows.length} record{rows.length === 1 ? '' : 's'}
            </span>
            <button style={btnSecondary} onClick={load} disabled={loading}>↻</button>
          </div>
        </div>
      </div>

      <div style={panelStyle}>
        <div style={panelBodyStyle}>
          {loading ? (
            <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : rows.length === 0 ? (
            <EmptyState message={`No attendance records for ${date}`} />
          ) : (
            <DataTable
              columns={columns}
              rows={rows}
              loading={false}
              emptyMessage=""
              renderCell={renderCell}
            />
          )}
        </div>
      </div>

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

  const [targets, setTargets] = useState({
    L1: { Assembly: '', QC: '', Packaging: '' },
    L2: { Assembly: '', QC: '', Packaging: '' },
    L3: { Assembly: '', QC: '', Packaging: '' },
    D1: '',
    D2: '',
    Others: '',
  });
  // null = no active run for that line; { product, run_no } = run that seeded its targets
  const [targetHints, setTargetHints] = useState({ L1: null, L2: null, L3: null });
  const [selectedOpIds, setSelectedOpIds] = useState(() => new Set());

  const activeOperators = useMemo(
    () => (operators || []).filter((o) => o.status !== 'inactive'),
    [operators]
  );

  const assignedOpIds = useMemo(() => {
    const s = new Set();
    for (const line of ['L1', 'L2', 'L3']) {
      const sections = grouped[line] || {};
      for (const section of Object.keys(sections)) {
        for (const row of sections[section] || []) s.add(row.operator_id);
      }
    }
    for (const row of grouped.D1 || []) s.add(row.operator_id);
    for (const row of grouped.D2 || []) s.add(row.operator_id);
    for (const row of grouped.Others || []) s.add(row.operator_id);
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

  const totalAssigned = useMemo(() => {
    let n = 0;
    for (const line of ['L1', 'L2', 'L3']) {
      const sections = grouped[line] || {};
      for (const section of Object.keys(sections)) n += (sections[section] || []).length;
    }
    n += (grouped.D1 || []).length;
    n += (grouped.D2 || []).length;
    n += (grouped.Others || []).length;
    return n;
  }, [grouped]);

  const load = useCallback(async () => {
    if (!session || !canManageFloor || !date) return;
    setLoading(true);
    try {
      // getLineSetup is parallel-fetched purely to seed the TARGETS row from the
      // active production run's line design; .catch swallow keeps a failure here
      // from breaking the roster itself.
      const [rosterRes, attRes, lineSetupRes] = await Promise.all([
        workerFetch('getManpowerLog', { data: { shift_date: date } }, session),
        workerFetch('getOperatorAttendance', { data: { date_from: date, date_to: date } }, session),
        garageFetch('getLineSetup', { date }, session).catch(() => null),
      ]);
      const inner = rosterRes?.data;
      const obj = inner && typeof inner === 'object' && !Array.isArray(inner) ? inner : {};
      setGrouped(obj);
      const attList = Array.isArray(attRes?.data) ? attRes.data : Array.isArray(attRes) ? attRes : [];
      setAttendanceRows(attList);

      // Seed TARGETS from active run line designs; preserve Others (not run-driven).
      // garageFetch unwraps { data: ... } already, but tolerate both shapes.
      const lineSetupPayload = (lineSetupRes && lineSetupRes.lines) ? lineSetupRes : (lineSetupRes?.data || {});
      const lineDesigns = lineSetupPayload.lines || {};
      const lineTargets = {
        L1: { Assembly: '', QC: '', Packaging: '' },
        L2: { Assembly: '', QC: '', Packaging: '' },
        L3: { Assembly: '', QC: '', Packaging: '' },
      };
      const newHints = { L1: null, L2: null, L3: null };
      for (const line of ['L1', 'L2', 'L3']) {
        const lineData = lineDesigns[line];
        if (!lineData?.run || !Array.isArray(lineData?.design?.departments)) continue;
        newHints[line] = {
          product: lineData.run.product,
          run_no:  lineData.run.run_no,
        };
        for (const dept of lineData.design.departments) {
          if (dept.department === 'Assembly')  lineTargets[line].Assembly  = String(dept.total_headcount || '');
          if (dept.department === 'QC')        lineTargets[line].QC        = String(dept.total_headcount || '');
          if (dept.department === 'Packaging') lineTargets[line].Packaging = String(dept.total_headcount || '');
        }
      }
      setTargets((prev) => ({ ...lineTargets, D1: prev.D1, D2: prev.D2, Others: prev.Others }));
      setTargetHints(newHints);
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

  async function handleAssign(operatorId, line, station) {
    if (!canManageFloor || !operatorId || !line) return;
    if (line !== 'Others' && !station) return;
    try {
      const data = { operator_id: operatorId, line, shift_date: date };
      if (line !== 'Others') data.station = station;
      await workerFetch('assignManpower', { data }, session);
      const op = activeOperators.find((o) => o.id === operatorId);
      const label = line === 'Others' ? line : `${line} · ${station}`;
      showToast(`Assigned ${op?.name || 'operator'} to ${label}`, 'success');
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

  async function handleBulkAssign(opIds, line, station) {
    if (!canManageFloor || !opIds.length) return;
    if (line !== 'Others' && !station) return;
    try {
      if (opIds.length === 1) {
        const data = { operator_id: opIds[0], line, shift_date: date };
        if (line !== 'Others') data.station = station;
        await workerFetch('assignManpower', { data }, session);
      } else {
        const assignments = opIds.map((id) => ({
          operator_id: id,
          line,
          station: line === 'Others' ? null : station,
        }));
        await workerFetch('bulkAssignManpower', { data: { assignments, shift_date: date } }, session);
      }
      const label = line === 'Others' ? line : `${line} · ${station}`;
      const noun  = opIds.length === 1 ? 'operator' : `${opIds.length} operators`;
      showToast(`Assigned ${noun} to ${label}`, 'success');
      setSelectedOpIds(new Set());
      load();
    } catch (e) {
      showToast(e.message || 'Assign failed', 'error');
    }
  }

  function onDropToSection(e, line, station) {
    e.preventDefault();
    const opIds = readDropOpIds(e);
    if (opIds.length) handleBulkAssign(opIds, line, station);
  }

  function onDropToOthers(e) {
    e.preventDefault();
    const opIds = readDropOpIds(e);
    if (opIds.length) handleBulkAssign(opIds, 'Others', null);
  }

  async function handleAutoAssign() {
    if (!canManageFloor) return;
    if (availableOperators.length === 0) {
      showToast('No available operators (clocked-in and unassigned)', 'error');
      return;
    }

    const slots = [];
    for (const line of ['L1', 'L2', 'L3']) {
      for (const section of ROSTER_SECTIONS) {
        const n = Math.max(0, parseInt(targets[line][section], 10) || 0);
        for (let i = 0; i < n; i++) slots.push({ line, station: section });
      }
    }
    for (const line of ['D1', 'D2']) {
      const n = Math.max(0, parseInt(targets[line], 10) || 0);
      for (let i = 0; i < n; i++) slots.push({ line, station: null });
    }
    const othersN = Math.max(0, parseInt(targets.Others, 10) || 0);
    for (let i = 0; i < othersN; i++) slots.push({ line: 'Others', station: null });

    if (slots.length === 0) {
      showToast('Enter target headcounts before auto-assigning', 'error');
      return;
    }

    const pairCount = Math.min(availableOperators.length, slots.length);
    const assignments = [];
    for (let i = 0; i < pairCount; i++) {
      assignments.push({
        operator_id: availableOperators[i].id,
        line:        slots[i].line,
        station:     slots[i].station,
      });
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
      <div style={{ ...panelStyle, padding: '40px 24px', textAlign: 'center' }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)' }}>
          Daily Roster is restricted to floor supervisors.
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ ...panelStyle, marginBottom: 12 }}>
        <div style={{ padding: '10px 14px', display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <span style={labelStyle}>Date</span>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              style={{ ...inputStyle, fontFamily: 'var(--mono)' }}
            />
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              {totalAssigned} assigned
            </span>
            <button style={btnSecondary} onClick={load} disabled={loading}>↻</button>
          </div>
        </div>
      </div>

      <div style={{ ...panelStyle, marginBottom: 12 }}>
        <div style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Targets
          </span>
          {['L1', 'L2', 'L3'].map((line) => (
            <div key={line} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: ROSTER_LINE_COLORS[line], minWidth: 18, fontWeight: 700 }}>{line}</span>
              {ROSTER_SECTIONS.map((section) => (
                <label key={section} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--t3)', fontFamily: 'var(--mono)' }}>
                  <span style={{ textTransform: 'uppercase', letterSpacing: '0.06em' }}>{section.slice(0, 3)}</span>
                  <input
                    type="number"
                    min="0"
                    value={targets[line][section]}
                    onChange={(e) => setTargets((prev) => ({
                      ...prev,
                      [line]: { ...prev[line], [section]: e.target.value },
                    }))}
                    style={{ ...inputStyle, width: 48, fontFamily: 'var(--mono)', textAlign: 'center', padding: '3px 6px' }}
                  />
                </label>
              ))}
            </div>
          ))}
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--t3)', fontFamily: 'var(--mono)' }}>
            <span style={{ color: ROSTER_LINE_COLORS.Others, fontWeight: 700 }}>OTHERS</span>
            <input
              type="number"
              min="0"
              value={targets.Others}
              onChange={(e) => setTargets((prev) => ({ ...prev, Others: e.target.value }))}
              style={{ ...inputStyle, width: 48, fontFamily: 'var(--mono)', textAlign: 'center', padding: '3px 6px' }}
            />
          </label>
          <button
            onClick={handleAutoAssign}
            disabled={availableOperators.length === 0}
            style={{
              marginLeft: 'auto',
              ...btnPrimary,
              padding: '6px 14px',
              opacity: availableOperators.length === 0 ? 0.5 : 1,
              cursor: availableOperators.length === 0 ? 'not-allowed' : 'pointer',
            }}
          >
            Auto-assign ({availableOperators.length} available)
          </button>
        </div>
        {/* Hint row — shows which active run seeded each line's targets, or "no run". */}
        <div style={{ padding: '0 14px 10px', display: 'flex', gap: 18, flexWrap: 'wrap', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', letterSpacing: '0.04em' }}>
          {['L1', 'L2', 'L3'].map((line) => (
            targetHints[line] ? (
              <span key={line}>
                <span style={{ color: ROSTER_LINE_COLORS[line], fontWeight: 700, marginRight: 4 }}>{line}</span>
                seeded from {targetHints[line].product} · {targetHints[line].run_no}
              </span>
            ) : (
              <span key={line} style={{ opacity: 0.55 }}>
                <span style={{ color: ROSTER_LINE_COLORS[line], fontWeight: 700, marginRight: 4 }}>{line}</span>
                no active run
              </span>
            )
          ))}
        </div>
      </div>

      <div style={{ ...panelStyle, marginBottom: 12 }}>
        <div style={panelHeaderStyle}>
          <span>Available ({availableOperators.length})</span>
          {selectedOpIds.size > 0 && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--yellow)', letterSpacing: '0.06em' }}>
              {selectedOpIds.size} selected · drag to assign
            </span>
          )}
        </div>
        <div style={{ padding: '10px 14px', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {availableOperators.length === 0 ? (
            <div style={{ fontSize: 11, color: 'var(--t3)', fontFamily: 'var(--mono)' }}>
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
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '4px 10px 4px 6px', borderRadius: 16,
                    background: isSelected ? 'var(--yellow)' : 'var(--surface2)',
                    color: isSelected ? '#000' : 'var(--t1)',
                    border: `1px solid ${isSelected ? 'var(--yellow)' : 'var(--border)'}`,
                    cursor: 'grab', fontSize: 12, userSelect: 'none',
                  }}
                >
                  <span
                    onClick={(e) => { e.stopPropagation(); toggleSelected(op.id); }}
                    style={{
                      width: 14, height: 14, borderRadius: 3, flexShrink: 0,
                      border: `1.5px solid ${isSelected ? '#000' : 'var(--border)'}`,
                      background: isSelected ? '#000' : 'transparent',
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
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: isSelected ? '#000' : 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    {(op.department || '').slice(0, 4)}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12 }}>
          {['L1', 'L2', 'L3'].map((line) => {
            const sections = grouped[line] || {};
            const accent = ROSTER_LINE_COLORS[line];
            const lineCount = ROSTER_SECTIONS.reduce((s, sec) => s + ((sections[sec] || []).length), 0)
                            + ((sections.Unassigned || []).length);
            return (
              <div key={line} style={{ ...panelStyle, marginBottom: 0, minHeight: 220 }}>
                <div style={{ ...panelHeaderStyle, color: accent }}>
                  <span>{line} ({lineCount})</span>
                </div>
                <div style={{ padding: 6 }}>
                  {ROSTER_SECTIONS.map((station, idx) => {
                    const rows = sections[station] || [];
                    const key = `${line}-${station}`;
                    const open = !!pickerOpen[key];
                    const q = (pickerQuery[key] || '').trim().toLowerCase();
                    const pickerOps = activeOperators.filter((op) => {
                      if (assignedOpIds.has(op.id)) return false;
                      if (!q) return true;
                      return (op.name || '').toLowerCase().includes(q) ||
                             (op.employee_id || '').toLowerCase().includes(q);
                    });
                    return (
                      <div
                        key={station}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => onDropToSection(e, line, station)}
                        style={{
                          borderTop: idx === 0 ? 'none' : '1px solid var(--border)',
                          padding: '8px 8px 10px',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                          <span style={{
                            fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
                            color: 'var(--t2)', textTransform: 'uppercase', letterSpacing: '0.08em',
                          }}>
                            {station} ({rows.length})
                          </span>
                          <div
                            ref={(el) => { pickerRefs.current[key] = el; }}
                            style={{ position: 'relative' }}
                          >
                            <button
                              style={{ ...btnSecondary, padding: '1px 7px', fontSize: 11 }}
                              onClick={() => {
                                setPickerOpen((s) => ({ ...s, [key]: !s[key] }));
                                setPickerQuery((s) => ({ ...s, [key]: '' }));
                              }}
                              title={open ? 'Close' : `Assign to ${station}`}
                            >
                              {open ? '×' : '+'}
                            </button>
                            {open && (
                              <div style={{
                                position: 'absolute', top: '100%', right: 0,
                                marginTop: 4, zIndex: 20, width: 240,
                                background: 'var(--surface2)', border: '1px solid var(--border)',
                                borderRadius: 3, boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
                              }}>
                                <input
                                  type="text"
                                  autoFocus
                                  placeholder="Search name or ID…"
                                  value={pickerQuery[key] || ''}
                                  onChange={(e) => {
                                    setPickerQuery((s) => ({ ...s, [key]: e.target.value }));
                                    setPickerHighlight((s) => ({ ...s, [key]: -1 }));
                                  }}
                                  onKeyDown={(e) => {
                                    const visible = pickerOps.slice(0, 50);
                                    const hi = pickerHighlight[key] ?? -1;
                                    if (e.key === 'ArrowDown') {
                                      e.preventDefault();
                                      setPickerHighlight((s) => ({ ...s, [key]: Math.min((hi < 0 ? -1 : hi) + 1, visible.length - 1) }));
                                    } else if (e.key === 'ArrowUp') {
                                      e.preventDefault();
                                      setPickerHighlight((s) => ({ ...s, [key]: Math.max(hi - 1, 0) }));
                                    } else if (e.key === 'Enter') {
                                      if (hi >= 0 && visible[hi]) {
                                        e.preventDefault();
                                        handleAssign(visible[hi].id, line, station);
                                        setPickerOpen((s) => ({ ...s, [key]: false }));
                                        setPickerQuery((s) => ({ ...s, [key]: '' }));
                                        setPickerHighlight((s) => ({ ...s, [key]: -1 }));
                                      }
                                    } else if (e.key === 'Escape') {
                                      setPickerOpen((s) => ({ ...s, [key]: false }));
                                      setPickerHighlight((s) => ({ ...s, [key]: -1 }));
                                    }
                                  }}
                                  style={{ ...inputStyle, width: '100%', borderRadius: 0, border: 'none', borderBottom: '1px solid var(--border)' }}
                                />
                                <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                                  {pickerOps.length === 0 ? (
                                    <div style={{ padding: '8px 12px', color: 'var(--t3)', fontSize: 11, fontFamily: 'var(--mono)' }}>
                                      No available operators
                                    </div>
                                  ) : (
                                    pickerOps.slice(0, 50).map((op, opIdx) => {
                                      const isHi = (pickerHighlight[key] ?? -1) === opIdx;
                                      return (
                                        <div
                                          key={op.id}
                                          ref={isHi ? highlightedPickerRef : null}
                                          onMouseDown={(e) => {
                                            e.preventDefault();
                                            handleAssign(op.id, line, station);
                                            setPickerOpen((s) => ({ ...s, [key]: false }));
                                            setPickerQuery((s) => ({ ...s, [key]: '' }));
                                            setPickerHighlight((s) => ({ ...s, [key]: -1 }));
                                          }}
                                          onMouseEnter={() => setPickerHighlight((s) => ({ ...s, [key]: opIdx }))}
                                          style={{ padding: '6px 10px', cursor: 'pointer', fontSize: 12, color: 'var(--t1)', background: isHi ? 'var(--surface)' : 'transparent' }}
                                        >
                                          <div>{op.name}</div>
                                          <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', marginTop: 1 }}>
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
                        </div>
                        {loading && idx === 0 ? (
                          <div style={{ padding: 12, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
                        ) : rows.length === 0 ? (
                          <div style={{
                            border: '1px dashed var(--border)', borderRadius: 3,
                            padding: '12px 10px', textAlign: 'center',
                            color: 'var(--t3)', fontSize: 10, fontFamily: 'var(--mono)',
                            textTransform: 'uppercase', letterSpacing: '0.08em',
                          }}>
                            Drop operator here
                          </div>
                        ) : (
                          rows.map((row) => (
                            <div
                              key={row.id}
                              style={{
                                background: 'var(--surface2)',
                                border: '1px solid var(--border)',
                                borderLeft: `3px solid ${accent}`,
                                borderRadius: 3,
                                padding: '5px 8px',
                                marginBottom: 4,
                                display: 'flex', alignItems: 'flex-start', gap: 6,
                              }}
                            >
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: 12, color: 'var(--t1)' }}>{row.operator_name || '(unknown)'}</div>
                                <div style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: 2 }}>
                                  {row.operator_department || '—'}
                                </div>
                              </div>
                              <button
                                onClick={() => handleUnassign(row, line)}
                                title={`Remove ${row.operator_name || 'operator'} from ${line}`}
                                style={{
                                  background: 'transparent',
                                  border: '1px solid var(--border)',
                                  color: '#ff7070',
                                  cursor: 'pointer',
                                  borderRadius: 3,
                                  padding: '0 5px',
                                  fontSize: 12,
                                  lineHeight: '18px',
                                  height: 20,
                                  flexShrink: 0,
                                }}
                              >
                                ×
                              </button>
                            </div>
                          ))
                        )}
                      </div>
                    );
                  })}
                  {(sections.Unassigned || []).length > 0 && (
                    <div style={{ borderTop: '1px solid var(--border)', padding: '8px 8px 10px' }}>
                      <span style={{
                        fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
                        color: '#ff9d33', textTransform: 'uppercase', letterSpacing: '0.08em',
                      }}>
                        Unassigned ({sections.Unassigned.length})
                      </span>
                      <div style={{ marginTop: 6 }}>
                        {sections.Unassigned.map((row) => (
                          <div
                            key={row.id}
                            style={{
                              background: 'var(--surface2)',
                              border: '1px dashed #ff9d33',
                              borderRadius: 3,
                              padding: '5px 8px',
                              marginBottom: 4,
                              display: 'flex', alignItems: 'flex-start', gap: 6,
                            }}
                          >
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 12, color: 'var(--t1)' }}>{row.operator_name || '(unknown)'}</div>
                              <div style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: 2 }}>
                                Legacy row · re-drag to a section
                              </div>
                            </div>
                            <button
                              onClick={() => handleUnassign(row, line)}
                              title={`Remove ${row.operator_name || 'operator'} from ${line}`}
                              style={{
                                background: 'transparent',
                                border: '1px solid var(--border)',
                                color: '#ff7070',
                                cursor: 'pointer',
                                borderRadius: 3,
                                padding: '0 5px',
                                fontSize: 12,
                                lineHeight: '18px',
                                height: 20,
                                flexShrink: 0,
                              }}
                            >
                              ×
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {/* D1, D2, Admin, Store — all flat (no station sub-sections). D1/D2
              map to line='D1'/'D2' in store.manpower_assignments. Admin and
              Store are a visual department-based split of line='Others' rows
              (no schema change — option γ from the scope diagnostic). */}
          {([
            { key: 'D1',    label: 'D1',    accent: ROSTER_LINE_COLORS.D1,    rows: grouped.D1 || [],    assignLine: 'D1' },
            { key: 'D2',    label: 'D2',    accent: ROSTER_LINE_COLORS.D2,    rows: grouped.D2 || [],    assignLine: 'D2' },
            { key: 'Admin', label: 'Admin', accent: ROSTER_LINE_COLORS.Admin,
              rows: (grouped.Others || []).filter((r) => (r.operator_department || '').toLowerCase() === 'admin'),
              assignLine: 'Others' },
            { key: 'Store', label: 'Store', accent: ROSTER_LINE_COLORS.Store,
              rows: (grouped.Others || []).filter((r) => (r.operator_department || '').toLowerCase() !== 'admin'),
              assignLine: 'Others' },
          ]).map((panel) => {
            const accent = panel.accent;
            const rows = panel.rows;
            const key = panel.key;
            const open = !!pickerOpen[key];
            const q = (pickerQuery[key] || '').trim().toLowerCase();
            const pickerOps = activeOperators.filter((op) => {
              if (assignedOpIds.has(op.id)) return false;
              if (!q) return true;
              return (op.name || '').toLowerCase().includes(q) ||
                     (op.employee_id || '').toLowerCase().includes(q);
            });
            return (
              <div key={key} style={{ ...panelStyle, marginBottom: 0, minHeight: 220 }}>
                <div style={{ ...panelHeaderStyle, color: accent }}>
                  <span>{panel.label} ({rows.length})</span>
                </div>
                <div
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const opIds = readDropOpIds(e);
                    if (opIds.length) handleBulkAssign(opIds, panel.assignLine, null);
                  }}
                  style={{ padding: '8px 8px 10px' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span style={{
                      fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
                      color: 'var(--t2)', textTransform: 'uppercase', letterSpacing: '0.08em',
                    }}>
                      Operators ({rows.length})
                    </span>
                    <div
                      ref={(el) => { pickerRefs.current[key] = el; }}
                      style={{ position: 'relative' }}
                    >
                      <button
                        style={{ ...btnSecondary, padding: '1px 7px', fontSize: 11 }}
                        onClick={() => {
                          setPickerOpen((s) => ({ ...s, [key]: !s[key] }));
                          setPickerQuery((s) => ({ ...s, [key]: '' }));
                        }}
                        title={open ? 'Close' : `Assign to ${panel.label}`}
                      >
                        {open ? '×' : '+'}
                      </button>
                      {open && (
                        <div style={{
                          position: 'absolute', top: '100%', right: 0,
                          marginTop: 4, zIndex: 20, width: 240,
                          background: 'var(--surface2)', border: '1px solid var(--border)',
                          borderRadius: 3, boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
                        }}>
                          <input
                            type="text"
                            autoFocus
                            placeholder="Search name or ID…"
                            value={pickerQuery[key] || ''}
                            onChange={(e) => {
                              setPickerQuery((s) => ({ ...s, [key]: e.target.value }));
                              setPickerHighlight((s) => ({ ...s, [key]: -1 }));
                            }}
                            onKeyDown={(e) => {
                              const visible = pickerOps.slice(0, 50);
                              const hi = pickerHighlight[key] ?? -1;
                              if (e.key === 'ArrowDown') {
                                e.preventDefault();
                                setPickerHighlight((s) => ({ ...s, [key]: Math.min((hi < 0 ? -1 : hi) + 1, visible.length - 1) }));
                              } else if (e.key === 'ArrowUp') {
                                e.preventDefault();
                                setPickerHighlight((s) => ({ ...s, [key]: Math.max(hi - 1, 0) }));
                              } else if (e.key === 'Enter') {
                                if (hi >= 0 && visible[hi]) {
                                  e.preventDefault();
                                  handleAssign(visible[hi].id, panel.assignLine, null);
                                  setPickerOpen((s) => ({ ...s, [key]: false }));
                                  setPickerQuery((s) => ({ ...s, [key]: '' }));
                                  setPickerHighlight((s) => ({ ...s, [key]: -1 }));
                                }
                              } else if (e.key === 'Escape') {
                                setPickerOpen((s) => ({ ...s, [key]: false }));
                                setPickerHighlight((s) => ({ ...s, [key]: -1 }));
                              }
                            }}
                            style={{ ...inputStyle, width: '100%', borderRadius: 0, border: 'none', borderBottom: '1px solid var(--border)' }}
                          />
                          <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                            {pickerOps.length === 0 ? (
                              <div style={{ padding: '8px 12px', color: 'var(--t3)', fontSize: 11, fontFamily: 'var(--mono)' }}>
                                No available operators
                              </div>
                            ) : (
                              pickerOps.slice(0, 50).map((op, opIdx) => {
                                const isHi = (pickerHighlight[key] ?? -1) === opIdx;
                                return (
                                  <div
                                    key={op.id}
                                    ref={isHi ? highlightedPickerRef : null}
                                    onMouseDown={(e) => {
                                      e.preventDefault();
                                      handleAssign(op.id, panel.assignLine, null);
                                      setPickerOpen((s) => ({ ...s, [key]: false }));
                                      setPickerQuery((s) => ({ ...s, [key]: '' }));
                                      setPickerHighlight((s) => ({ ...s, [key]: -1 }));
                                    }}
                                    onMouseEnter={() => setPickerHighlight((s) => ({ ...s, [key]: opIdx }))}
                                    style={{ padding: '6px 10px', cursor: 'pointer', fontSize: 12, color: 'var(--t1)', background: isHi ? 'var(--surface)' : 'transparent' }}
                                  >
                                    <div>{op.name}</div>
                                    <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', marginTop: 1 }}>
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
                  </div>
                  {loading ? (
                    <div style={{ padding: 12, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
                  ) : rows.length === 0 ? (
                    <div style={{
                      border: '1px dashed var(--border)', borderRadius: 3,
                      padding: '12px 10px', textAlign: 'center',
                      color: 'var(--t3)', fontSize: 10, fontFamily: 'var(--mono)',
                      textTransform: 'uppercase', letterSpacing: '0.08em',
                    }}>
                      Drop operator here
                    </div>
                  ) : (
                    rows.map((row) => (
                      <div
                        key={row.id}
                        style={{
                          background: 'var(--surface2)',
                          border: '1px solid var(--border)',
                          borderLeft: `3px solid ${accent}`,
                          borderRadius: 3,
                          padding: '5px 8px',
                          marginBottom: 4,
                          display: 'flex', alignItems: 'flex-start', gap: 6,
                        }}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, color: 'var(--t1)' }}>{row.operator_name || '(unknown)'}</div>
                          <div style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: 2 }}>
                            {row.operator_department || '—'}
                          </div>
                        </div>
                        <button
                          onClick={() => handleUnassign(row, panel.assignLine)}
                          title={`Remove ${row.operator_name || 'operator'} from ${panel.label}`}
                          style={{
                            background: 'transparent',
                            border: '1px solid var(--border)',
                            color: '#ff7070',
                            cursor: 'pointer',
                            borderRadius: 3,
                            padding: '0 5px',
                            fontSize: 12,
                            lineHeight: '18px',
                            height: 20,
                            flexShrink: 0,
                          }}
                        >
                          ×
                        </button>
                      </div>
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

// ═══════════════════════════════════════════════════════════════════════════
// PerformanceTab — per-operator point-event log + supervisor add modal.
// Worker getPerformanceHistory → { total, events }; addPerformanceEvent
// records points (non-zero int), reason, category, event_date. recorded_by is
// captured server-side from JWT userId.
// ═══════════════════════════════════════════════════════════════════════════
function PerformanceTab({ session, canManageFloor, operators }) {
  const { showToast } = useToast();
  const [selectedOp, setSelectedOp] = useState(null);
  const [query, setQuery] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const [highlightedIdx, setHighlightedIdx] = useState(-1);
  const [data, setData] = useState({ total: 0, events: [] });
  const [loading, setLoading] = useState(false);
  const [showAdd, setShowAdd] = useState(false);

  const comboRef = useRef(null);
  const highlightedOpRef = useRef(null);

  const activeOperators = useMemo(
    () => (operators || []).filter((o) => o.status !== 'inactive'),
    [operators]
  );

  const filteredOps = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return activeOperators;
    return activeOperators.filter((o) =>
      (o.name || '').toLowerCase().includes(q) ||
      (o.employee_id || '').toLowerCase().includes(q)
    );
  }, [activeOperators, query]);

  useEffect(() => {
    if (!showDropdown) return;
    function onDocClick(e) {
      if (comboRef.current && !comboRef.current.contains(e.target)) {
        setShowDropdown(false);
        setHighlightedIdx(-1);
      }
    }
    function onKey(e) {
      if (e.key === 'Escape') { setShowDropdown(false); setHighlightedIdx(-1); }
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [showDropdown]);

  useEffect(() => {
    if (highlightedOpRef.current) {
      highlightedOpRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [highlightedIdx]);

  const operatorId = selectedOp?.id || '';

  const load = useCallback(async () => {
    if (!session || !canManageFloor || !operatorId) {
      setData({ total: 0, events: [] });
      return;
    }
    setLoading(true);
    try {
      const res = await workerFetch(
        'getPerformanceHistory',
        { data: { operator_id: operatorId } },
        session
      );
      const inner = res?.data || {};
      setData({
        total: Number(inner.total) || 0,
        events: Array.isArray(inner.events) ? inner.events : [],
      });
    } catch (e) {
      showToast(e.message || 'Failed to load performance', 'error');
      setData({ total: 0, events: [] });
    } finally {
      setLoading(false);
    }
  }, [session, canManageFloor, operatorId, showToast]);

  useEffect(() => { load(); }, [load]);

  function pickOperator(op) {
    setSelectedOp(op);
    setQuery(`${op.name} — ${op.employee_id}`);
    setShowDropdown(false);
  }

  if (!canManageFloor) {
    return (
      <div style={{ ...panelStyle, padding: '40px 24px', textAlign: 'center' }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)' }}>
          Performance log is restricted to floor supervisors.
        </div>
      </div>
    );
  }

  const totalColor = data.total > 0 ? 'var(--green)' : data.total < 0 ? '#ff7070' : 'var(--t2)';

  const columns = [
    { key: 'event_date',  label: 'Date' },
    { key: 'points',      label: 'Points' },
    { key: 'category',    label: 'Category' },
    { key: 'reason',      label: 'Reason' },
    { key: 'recorded_by', label: 'Recorded by' },
  ];

  function renderCell(row, c) {
    switch (c.key) {
      case 'event_date':
        return <span style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{fmtDate(row.event_date)}</span>;
      case 'points': {
        const p = Number(row.points);
        const color = p > 0 ? 'var(--green)' : p < 0 ? '#ff7070' : 'var(--t2)';
        return <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, color }}>{p > 0 ? `+${p}` : p}</span>;
      }
      case 'category': {
        const def = PERFORMANCE_CATEGORIES.find((x) => x.value === (row.category || 'other'));
        return def?.label || capitalize(row.category || 'other');
      }
      case 'reason': {
        const t = row.reason || '';
        return <span title={t.length > 80 ? t : undefined}>{t.length > 80 ? t.slice(0, 80) + '…' : t}</span>;
      }
      case 'recorded_by':
        return row.recorded_by_name || '—';
      default:
        return row[c.key];
    }
  }

  return (
    <div>
      <div style={{ ...panelStyle, marginBottom: 12 }}>
        <div style={{ padding: '10px 14px', display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div ref={comboRef} style={{ flex: '1 1 280px', minWidth: 220, position: 'relative' }}>
            <span style={labelStyle}>Operator</span>
            <input
              type="text"
              value={query}
              placeholder="Search by name or employee ID…"
              onChange={(e) => {
                setQuery(e.target.value);
                setSelectedOp(null);
                setShowDropdown(true);
                setHighlightedIdx(-1);
              }}
              onFocus={() => setShowDropdown(true)}
              onClick={() => setShowDropdown(true)}
              onKeyDown={(e) => {
                const visible = filteredOps.slice(0, 50);
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setShowDropdown(true);
                  setHighlightedIdx((i) => Math.min((i < 0 ? -1 : i) + 1, visible.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setHighlightedIdx((i) => Math.max(i - 1, 0));
                } else if (e.key === 'Enter') {
                  if (showDropdown && highlightedIdx >= 0 && visible[highlightedIdx]) {
                    e.preventDefault();
                    pickOperator(visible[highlightedIdx]);
                    setHighlightedIdx(-1);
                  }
                } else if (e.key === 'Escape') {
                  setShowDropdown(false);
                  setHighlightedIdx(-1);
                }
              }}
              style={{ ...inputStyle, width: '100%' }}
            />
            {showDropdown && (
              <div
                style={{
                  position: 'absolute', top: '100%', left: 0, right: 0,
                  marginTop: 2, zIndex: 20,
                  background: 'var(--surface2)', border: '1px solid var(--border)',
                  borderRadius: 3, maxHeight: 280, overflowY: 'auto',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
                }}
              >
                {filteredOps.length === 0 ? (
                  <div style={{ padding: '8px 12px', color: 'var(--t3)', fontSize: 12, fontFamily: 'var(--mono)' }}>
                    No operators found
                  </div>
                ) : (
                  filteredOps.slice(0, 50).map((op, idx) => {
                    const isSel = selectedOp?.id === op.id;
                    const isHi = idx === highlightedIdx;
                    let bg = 'transparent';
                    if (isSel) bg = 'rgba(255,200,0,0.05)';
                    else if (isHi) bg = 'var(--surface)';
                    return (
                      <div
                        key={op.id}
                        ref={isHi ? highlightedOpRef : null}
                        onMouseDown={(e) => { e.preventDefault(); pickOperator(op); setHighlightedIdx(-1); }}
                        onMouseEnter={() => setHighlightedIdx(idx)}
                        style={{
                          padding: '8px 12px',
                          cursor: 'pointer',
                          borderLeft: isSel ? '3px solid var(--yellow)' : '3px solid transparent',
                          background: bg,
                          fontSize: 12, color: 'var(--t1)',
                        }}
                      >
                        <div>{op.name}</div>
                        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', marginTop: 2 }}>
                          {op.employee_id} · {capitalize(op.department || '')}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
          {operatorId && (
            <div style={{
              display: 'flex', gap: 14, alignItems: 'center',
              padding: '6px 14px', background: 'var(--surface2)',
              border: '1px solid var(--border)', borderRadius: 3,
            }}>
              <div>
                <div style={{ fontSize: 9, color: 'var(--t3)', fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Total</div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 20, fontWeight: 700, color: totalColor }}>
                  {data.total > 0 ? `+${data.total}` : data.total} pts
                </div>
              </div>
              <div>
                <div style={{ fontSize: 9, color: 'var(--t3)', fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Events</div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 20, fontWeight: 700, color: 'var(--t1)' }}>{data.events.length}</div>
              </div>
            </div>
          )}
          <div style={{ marginLeft: 'auto' }}>
            <button onClick={() => setShowAdd(true)} style={btnPrimary}>+ Add Event</button>
          </div>
        </div>
      </div>

      <div style={panelStyle}>
        <div style={panelBodyStyle}>
          {!operatorId ? (
            <EmptyState message="Select an operator to view their performance history" />
          ) : loading ? (
            <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : data.events.length === 0 ? (
            <EmptyState message={`No performance events for ${selectedOp?.name || 'this operator'}`} />
          ) : (
            <DataTable
              columns={columns}
              rows={data.events}
              loading={false}
              emptyMessage=""
              renderCell={renderCell}
            />
          )}
        </div>
      </div>

      <AddPerformanceEventModal
        open={showAdd}
        onClose={() => setShowAdd(false)}
        session={session}
        operators={activeOperators}
        defaultOperatorId={operatorId}
        onSaved={(savedOpId, name) => {
          setShowAdd(false);
          showToast(`Performance event logged${name ? ' for ' + name : ''}`, 'success');
          if (operatorId && savedOpId === operatorId) load();
        }}
      />
    </div>
  );
}

function AddPerformanceEventModal({ open, onClose, session, operators, defaultOperatorId, onSaved }) {
  const { showToast } = useToast();
  const [opId, setOpId] = useState('');
  const [points, setPoints] = useState('');
  const [category, setCategory] = useState('quality');
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(istToday());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setOpId(defaultOperatorId || '');
      setPoints('');
      setCategory('quality');
      setReason('');
      setDate(istToday());
      setSaving(false);
    }
  }, [open, defaultOperatorId]);

  async function save() {
    if (!opId) { showToast('Operator required', 'error'); return; }
    const p = Math.round(Number(points));
    if (!Number.isFinite(p) || p === 0) {
      showToast('Points must be a non-zero integer', 'error');
      return;
    }
    if (!reason.trim()) { showToast('Reason required', 'error'); return; }
    if (!date)          { showToast('Date required', 'error'); return; }
    setSaving(true);
    try {
      await workerFetch(
        'addPerformanceEvent',
        { data: { operator_id: opId, points: p, reason: reason.trim(), category, event_date: date } },
        session
      );
      const name = operators.find((o) => o.id === opId)?.name;
      onSaved?.(opId, name);
    } catch (e) {
      showToast(e.message || 'Insert failed', 'error');
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Log Performance Event"
      size="md"
      confirmLabel={saving ? 'Saving…' : 'Log Event'}
      onConfirm={save}
      loading={saving}
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
        <Field label="Operator *" full>
          <select value={opId} onChange={(e) => setOpId(e.target.value)} style={{ ...selectStyle, width: '100%' }}>
            <option value="">Select operator…</option>
            {operators.map((op) => (
              <option key={op.id} value={op.id}>{op.name} — {op.employee_id}</option>
            ))}
          </select>
        </Field>
        <Field label="Points *">
          <input
            type="number"
            value={points}
            onChange={(e) => setPoints(e.target.value)}
            placeholder="+5 or -3"
            style={{ ...inputStyle, width: '100%' }}
          />
          <div style={{ fontSize: 10, color: 'var(--t3)', marginTop: 4, fontFamily: 'var(--mono)' }}>
            Positive for good, negative for poor performance.
          </div>
        </Field>
        <Field label="Category *">
          <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ ...selectStyle, width: '100%' }}>
            {PERFORMANCE_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </Field>
        <Field label="Date *">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ ...inputStyle, width: '100%' }} />
        </Field>
        <Field label="Reason *" full>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="What happened?"
            style={{ ...inputStyle, width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
          />
        </Field>
      </div>
    </Modal>
  );
}

function Field({ label, full, children }) {
  return (
    <div style={{ gridColumn: full ? '1 / -1' : 'auto' }}>
      <span style={labelStyle}>{label}</span>
      {children}
    </div>
  );
}
