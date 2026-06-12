'use client';
/* ════════════════════════════════════════════════════════════
   MANPOWER — Pit Wall v2 reskin (redesign-reference/app/
   manpower.jsx). Four tabs: Live View (floor map, line → station
   presence, 60s auto-refresh) · Attendance · Daily Roster
   (drag-and-drop assignment — every handler preserved exactly:
   assignManpower upsert, removeManpower, bulkAssignManpower,
   pickers, multi-select, auto-assign, target seeding from
   getLineSetup) · Performance. All garageFetch/workerFetch calls,
   params and business rules unchanged; chrome only.
   ════════════════════════════════════════════════════════════ */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { ConfirmModal, Modal, Spinner, useToast } from '@throttle/ui';
import { useAutoRefresh } from '../../../hooks/useAutoRefresh.js';
import { useRefreshState } from '../layout.js';
import {
  Icon, Panel, ToneBadge, lineColor, lineRgb, btnPrimary, btnGhost,
  inputStyle as kitInput,
} from '../../../components/kit/index.js';

// ── Constants ───────────────────────────────────────────────────────────────
const LINE_ORDER          = ['L1', 'L2', 'L3'];
const DISPATCH_LINE_ORDER = ['D1', 'D2'];
const ROSTER_SECTIONS     = ['Assembly', 'QC', 'Packaging'];
const PERFORMANCE_CATEGORIES = [
  { value: 'attendance', label: 'Attendance' },
  { value: 'quality',    label: 'Quality' },
  { value: 'behaviour',  label: 'Behaviour' },
  { value: 'output',     label: 'Output' },
  { value: 'other',      label: 'Other' },
];

// Non-production buckets keep their own accents (lineColor only maps L1–L5).
const BUCKET_COLOR = {
  D1: '#ec4899', D2: '#06b6d4', Others: '#f97316', Admin: '#fbbf24', Store: '#c084fc',
  Dispatch: '#ec4899', Unassigned: 'var(--t3)',
};
const accentFor = (key) => (LINE_ORDER.includes(key) ? lineColor(key) : BUCKET_COLOR[key] || 'var(--t3)');

// ── Shared styles ───────────────────────────────────────────────────────────
const inputStyle  = { ...kitInput, width: 'auto', fontSize: 13, padding: '8px 11px' };
const selectStyle = { ...inputStyle, cursor: 'pointer' };
const smallGhost  = { ...btnGhost, padding: '6px 10px', fontSize: 12 };

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

// ── Operator card helpers ────────────────────────────────────────────────────
function getInitials(name) {
  const parts = (name || '').trim().split(/\s+/);
  return parts.length >= 2
    ? (parts[0][0] + parts[1][0]).toUpperCase()
    : (parts[0] || '?').slice(0, 2).toUpperCase();
}
const DEPT_TINT = {
  assembly:  { bg: 'var(--info-bg)',            color: 'var(--info-fg)' },
  qc:        { bg: 'var(--brand-bg)',           color: 'var(--brand-fg)' },
  packaging: { bg: 'rgba(192,132,252,0.14)',    color: '#d8b4fe' },
  dispatch:  { bg: 'var(--bad-bg)',             color: 'var(--bad-fg)' },
  store:     { bg: 'var(--ok-bg)',              color: 'var(--ok-fg)' },
  admin:     { bg: 'var(--ok-bg)',              color: 'var(--ok-fg)' },
};
function deptTint(dept) {
  return DEPT_TINT[(dept || '').toLowerCase()] || { bg: 'var(--surface-2)', color: 'var(--t2)' };
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

// getManpowerLog returns { L1: { Assembly:[], QC:[], Packaging:[], Unassigned:[] }, ...,
// Others: [...], D1: [...], D2: [...] }. L1/L2/L3 nested by station; D1/D2 and
// Others arrive flat. flattenRoster collapses everything to flat arrays per line.
function flattenRoster(nested) {
  const out = { L1: [], L2: [], L3: [], D1: [], D2: [], Others: [] };
  for (const line of LINE_ORDER) {
    const sections = nested?.[line];
    if (!sections) continue;
    if (Array.isArray(sections)) { out[line] = sections; continue; } // legacy shape
    // Include EVERY station section (Assembly/QC/Packaging/Unassigned + any custom
    // station such as "Prep") so operators on non-standard stations aren't dropped.
    out[line] = Object.values(sections).flat();
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
      <Panel>
        <EmptyNote icon="users" title="Restricted" sub="Manpower view is restricted to floor supervisors." />
      </Panel>
    );
  }

  const TABS = [
    { key: 'live',        label: 'Live view',   icon: 'grid' },
    { key: 'attendance',  label: 'Attendance',  icon: 'clock' },
    { key: 'roster',      label: 'Daily roster',icon: 'layers' },
    { key: 'performance', label: 'Performance', icon: 'activity' },
    { key: 'analytics',   label: 'Manpower analytics', icon: 'gauge' },
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

      {activeTab === 'live'        && <LiveViewTab session={session} canManageFloor={canManageFloor} />}
      {activeTab === 'attendance'  && <AttendanceTab session={session} canManageFloor={canManageFloor} operators={allOperators} />}
      {activeTab === 'roster'      && <DailyRosterTab session={session} canManageFloor={canManageFloor} operators={allOperators} />}
      {activeTab === 'performance' && <PerformanceTab session={session} canManageFloor={canManageFloor} operators={allOperators} />}
      {activeTab === 'analytics'   && <ManpowerAnalyticsTab session={session} canManageFloor={canManageFloor} operators={allOperators} />}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// LiveViewTab — existing read-only floor view. Auto-refresh every 60s.
// Restyled as the prototype floor map: line cards with station groups
// (station derived from the same getManpowerLog response — no new APIs).
// ═══════════════════════════════════════════════════════════════════════════
function LiveViewTab({ session, canManageFloor }) {
  const { showToast } = useToast();
  const { setRefreshing, setLastRefreshed } = useRefreshState();
  const [today] = useState(() => istToday());
  const [openShifts, setOpenShifts] = useState([]);
  const [rosterByLine, setRosterByLine] = useState({});
  const [rosterNested, setRosterNested] = useState({});
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
      setRosterNested(grouped);
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
      setLastRefreshed(new Date());
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

  // operator → station, from the nested L1–L3 roster sections (presentation only).
  const stationByOpId = useMemo(() => {
    const m = {};
    for (const line of LINE_ORDER) {
      const sections = rosterNested?.[line];
      if (!sections || Array.isArray(sections)) continue;
      for (const [station, rows] of Object.entries(sections)) {
        for (const r of rows || []) m[r.operator_id] = station;
      }
    }
    return m;
  }, [rosterNested]);

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
      <Panel>
        <EmptyNote icon="users" title="Restricted" sub="Manpower view is restricted to floor supervisors." />
      </Panel>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface)',
          border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '6px 11px', color: 'var(--t2)' }}>
          <Icon name="clock" size={14} />
          <span className="num" style={{ fontSize: 12.5, color: 'var(--t1)', whiteSpace: 'nowrap' }}>{fmtIstDate(today)}</span>
        </div>
        <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--t3)' }}>
          Open shifts only · refreshes every 60s
        </span>
      </div>

      {loading && openShifts.length === 0 && Object.keys(rosterByLine).length === 0 ? (
        <div style={{ padding: 48, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
      ) : (
        <>
          {/* Headcount strip — ties visually to the Overview manpower strip */}
          {(() => {
            const othersAssigned = (rosterByLine.Others || []).filter(
              (r) => (r.operator_department || '').toLowerCase() !== 'store',
            );
            const storeAssigned = (rosterByLine.Others || []).filter(
              (r) => (r.operator_department || '').toLowerCase() === 'store',
            );
            const cards = [
              ...LINE_ORDER.map((line) => ({
                key: line, label: line, accent: accentFor(line),
                count: byLine[line].length, sub: `${(rosterByLine[line] || []).length} assigned`,
              })),
              { key: 'Dispatch', label: 'Dispatch', accent: BUCKET_COLOR.Dispatch, count: dispatch.length,
                sub: `${((rosterByLine.D1 || []).length) + ((rosterByLine.D2 || []).length)} assigned` },
              { key: 'Store', label: 'Store', accent: BUCKET_COLOR.Store, count: store.length,
                sub: `${storeAssigned.length} assigned` },
              { key: 'Others', label: 'Others', accent: BUCKET_COLOR.Others, count: others.length,
                sub: `${othersAssigned.length} assigned` },
              { key: 'Unassigned', label: 'Unassigned', accent: 'var(--t3)', count: unassigned.length,
                sub: 'open shift, no line' },
            ];
            return (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 12, marginBottom: 18 }}>
                {cards.map((c) => (
                  <div key={c.key} style={{ background: 'var(--surface)', border: '1px solid var(--border)',
                    borderRadius: 'var(--r-md)', boxShadow: 'var(--shadow-card)', padding: '12px 14px',
                    position: 'relative', overflow: 'hidden' }}>
                    <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: c.accent }} />
                    <span className="eyebrow">{c.label}</span>
                    <div className="num" style={{ fontSize: 22, fontWeight: 700, color: 'var(--t1)', lineHeight: 1, marginTop: 8 }}>
                      {c.count}
                    </div>
                    <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--t3)', marginTop: 5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflowEllipsis: 'ellipsis' }}>
                      on floor · {c.sub}
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}

          {/* Line floor map — line → station presence */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 16, marginBottom: 16, alignItems: 'start' }}>
            {LINE_ORDER.map((line) => (
              <LineColumn key={line} line={line} rows={byLine[line]} accent={accentFor(line)}
                assigned={(rosterByLine[line] || []).length} stationByOpId={stationByOpId} />
            ))}
          </div>

          {others.length > 0 && (
            <FlatSection label="Others" accent={BUCKET_COLOR.Others} rows={others} />
          )}

          {unassigned.length > 0 && (
            <FlatSection label="Unassigned" accent="var(--t3)" rows={unassigned} sub="open shift, no line assignment" />
          )}
        </>
      )}
    </div>
  );
}

function LineColumn({ line, rows, accent, assigned, stationByOpId }) {
  // group operators on this line by their roster station (presentation only)
  const groups = useMemo(() => {
    const g = {};
    for (const row of rows) {
      const st = stationByOpId[row.operator_id] || 'Unassigned';
      (g[st] = g[st] || []).push(row);
    }
    const order = [...ROSTER_SECTIONS, ...Object.keys(g).filter((k) => !ROSTER_SECTIONS.includes(k))];
    return order.filter((st) => (g[st] || []).length > 0).map((st) => [st, g[st]]);
  }, [rows, stationByOpId]);

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)',
      borderTop: `3px solid ${accent}`, borderRadius: 'var(--r-md)', boxShadow: 'var(--shadow-card)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '13px 15px', borderBottom: '1px solid var(--border)' }}>
        <span className="font-display" style={{ fontSize: 16, fontWeight: 700, letterSpacing: '0.04em', color: accent }}>{line}</span>
        <span style={{ marginLeft: 'auto' }}>
          <span className="num" style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)' }}>
            {rows.length}<span style={{ color: 'var(--t4)', fontWeight: 400 }}>/{assigned} assigned</span>
          </span>
        </span>
      </div>
      <div style={{ padding: 13, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {rows.length === 0 ? (
          <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--t3)', padding: '6px 0' }}>
            No operators on the floor
          </div>
        ) : (
          groups.map(([station, sops]) => (
            <div key={station}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span className="eyebrow">{station}</span>
                <span className="num" style={{ fontSize: 10.5, color: 'var(--t4)' }}>{sops.length}</span>
                <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {sops.map((row) => <OperatorRow key={row.id} row={row} accent={accent} />)}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function OperatorRow({ row, accent }) {
  const isOvertime = (row.shift_type || '').toLowerCase() === 'overtime';
  const tint = deptTint(row.operator_department);
  const clockIn = fmtIstTime(row.clock_in);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '5px 7px',
      borderRadius: 'var(--r-sm)', background: 'var(--surface-2)' }}>
      <Avatar name={row.operator_name} size={24} color={accent} />
      <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t1)', flex: 1, minWidth: 0,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {row.operator_name || '(unknown)'}
      </span>
      {row.operator_department && (
        <span style={{ fontFamily: 'var(--font-ui)', fontSize: 10, fontWeight: 600, padding: '1px 6px',
          borderRadius: 3, background: tint.bg, color: tint.color, whiteSpace: 'nowrap' }}>
          {capitalize(row.operator_department)}
        </span>
      )}
      {isOvertime && <ToneBadge tone="brand" style={{ fontSize: 9 }}>OT</ToneBadge>}
      {clockIn && <span className="num" style={{ fontSize: 10, color: 'var(--t4)', whiteSpace: 'nowrap' }}>{clockIn}</span>}
    </div>
  );
}

function FlatSection({ label, accent, rows, sub }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)',
      boxShadow: 'var(--shadow-card)', marginBottom: 16, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '11px 15px', borderBottom: '1px solid var(--border)' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: accent, flexShrink: 0 }} />
        <span className="label" style={{ fontSize: 12, color: 'var(--t1)' }}>{label}</span>
        {sub && <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11.5, color: 'var(--t3)' }}>{sub}</span>}
        <span className="num" style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--t3)' }}>{rows.length}</span>
      </div>
      <div style={{ padding: '10px 13px', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {rows.map((row) => (
          <div key={row.id} style={{ minWidth: 230, flex: '0 1 250px' }}>
            <OperatorRow row={row} accent={accent} />
          </div>
        ))}
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
  const [stats, setStats] = useState({});   // operator_id → { streak, absent_month }
  const [dept, setDept] = useState('');      // '' = all departments
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
      const [attRes, statRes] = await Promise.all([
        workerFetch('getOperatorAttendance', { data: { date_from: date, date_to: date } }, session),
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
  }, [session, canManageFloor, date, showToast]);

  useEffect(() => { load(); }, [load]);

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
  const cols = '110px minmax(170px, 1.5fr) 116px 96px 84px 104px 84px 72px 96px 120px 88px';

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
            <div style={{ minWidth: 1180 }}>
              <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 12, padding: '0 12px 9px', borderBottom: '1px solid var(--border)' }}>
                {['Employee ID', 'Operator', 'Department', 'Shift', 'Clock in', 'Clock out', 'Duration', 'Streak', 'Absent (mo)', 'Device', ''].map((h, i) => (
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
                      <span className="num" style={{ fontSize: 12.5, color: 'var(--t1)' }}>{fmtIstTime(row.clock_in) || '—'}</span>
                      {row.clock_out
                        ? (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                            <span className="num" style={{ fontSize: 12.5, color: 'var(--t1)' }}>{fmtIstTime(row.clock_out)}</span>
                            {row.auto_closed && <ToneBadge tone="mute" style={{ fontSize: 9 }} title="Auto-closed at 1:00 AM IST">Auto</ToneBadge>}
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
  return { start: d.toISOString().slice(0, 10), end };
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

function ManpowerAnalyticsTab({ session, canManageFloor }) {
  const { showToast } = useToast();
  const [winKey, setWinKey] = useState('60');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [hideZero, setHideZero] = useState(true);

  const range = useMemo(() => analyticsRange(winKey), [winKey]);

  const load = useCallback(async () => {
    if (!session || !canManageFloor) return;
    setLoading(true);
    try {
      const res = await workerFetch('getManpowerAnalytics', { data: { start: range.start, end: range.end } }, session);
      const list = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
      setRows(list);
    } catch (e) {
      showToast(e.message || 'Failed to load analytics', 'error');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [session, canManageFloor, range, showToast]);

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
      <Panel>
        <EmptyNote icon="layers" title="Restricted" sub="Daily Roster is restricted to floor supervisors." />
      </Panel>
    );
  }

  // shared picker dropdown (assign fallback) — logic identical, restyled
  function Picker({ pkey, line, station, ops }) {
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
          title={open ? 'Close' : `Assign to ${station || line}`}
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
                    handleAssign(visible[hi].id, line, station);
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
                        handleAssign(op.id, line, station);
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

      {/* targets */}
      <Panel pad={0} style={{ marginBottom: 14 }}>
        <div style={{ padding: '12px 15px', display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
          <span className="eyebrow">Targets</span>
          {['L1', 'L2', 'L3'].map((line) => (
            <div key={line} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="num" style={{ fontSize: 11.5, color: lineColor(line), minWidth: 18, fontWeight: 700 }}>{line}</span>
              {ROSTER_SECTIONS.map((section) => (
                <label key={section} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span className="eyebrow" style={{ fontSize: 9 }}>{section.slice(0, 3)}</span>
                  <input
                    type="number"
                    min="0"
                    className="num"
                    value={targets[line][section]}
                    onChange={(e) => setTargets((prev) => ({
                      ...prev,
                      [line]: { ...prev[line], [section]: e.target.value },
                    }))}
                    style={{ ...inputStyle, width: 48, textAlign: 'center', padding: '3px 6px', fontSize: 12 }}
                  />
                </label>
              ))}
            </div>
          ))}
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="num" style={{ fontSize: 11.5, color: BUCKET_COLOR.Others, fontWeight: 700 }}>OTHERS</span>
            <input
              type="number"
              min="0"
              className="num"
              value={targets.Others}
              onChange={(e) => setTargets((prev) => ({ ...prev, Others: e.target.value }))}
              style={{ ...inputStyle, width: 48, textAlign: 'center', padding: '3px 6px', fontSize: 12 }}
            />
          </label>
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
        {/* Hint row — shows which active run seeded each line's targets, or "no run". */}
        <div style={{ padding: '0 15px 11px', display: 'flex', gap: 18, flexWrap: 'wrap',
          fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--t3)' }}>
          {['L1', 'L2', 'L3'].map((line) => (
            targetHints[line] ? (
              <span key={line}>
                <span className="num" style={{ color: lineColor(line), fontWeight: 700, marginRight: 4 }}>{line}</span>
                seeded from {targetHints[line].product} · <span className="num">{targetHints[line].run_no}</span>
              </span>
            ) : (
              <span key={line} style={{ opacity: 0.55 }}>
                <span className="num" style={{ color: lineColor(line), fontWeight: 700, marginRight: 4 }}>{line}</span>
                no active run
              </span>
            )
          ))}
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

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12 }}>
          {['L1', 'L2', 'L3'].map((line) => {
            const sections = grouped[line] || {};
            const accent = lineColor(line);
            const lineCount = Object.values(sections).reduce((s, arr) => s + (Array.isArray(arr) ? arr.length : 0), 0);
            return (
              <div key={line} style={{ background: 'var(--surface)', border: '1px solid var(--border)',
                borderTop: `3px solid ${accent}`, borderRadius: 'var(--r-md)', boxShadow: 'var(--shadow-card)', minHeight: 220 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '11px 13px', borderBottom: '1px solid var(--border)' }}>
                  <span className="font-display" style={{ fontSize: 14, fontWeight: 700, letterSpacing: '0.04em', color: accent }}>
                    {line}
                  </span>
                  <span className="num" style={{ fontSize: 11.5, fontWeight: 600, padding: '1px 8px',
                    borderRadius: 'var(--r-full)', background: 'var(--surface-2)', color: 'var(--t2)' }}>
                    {lineCount}
                  </span>
                </div>
                <div style={{ padding: 6 }}>
                  {[...ROSTER_SECTIONS, ...Object.keys(sections).filter((k) => !ROSTER_SECTIONS.includes(k) && k !== 'Unassigned')].map((station, idx) => {
                    const sectionRows = sections[station] || [];
                    const key = `${line}-${station}`;
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
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 7 }}>
                          <span className="eyebrow">
                            {station} <span className="num" style={{ color: 'var(--t4)' }}>({sectionRows.length})</span>
                          </span>
                          <Picker pkey={key} line={line} station={station} ops={pickerOps} />
                        </div>
                        {loading && idx === 0 ? (
                          <div style={{ padding: 12, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
                        ) : sectionRows.length === 0 ? (
                          <div style={dropZone}>
                            <span className="eyebrow" style={{ fontSize: 9 }}>Drop operator here</span>
                          </div>
                        ) : (
                          sectionRows.map((row) => (
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
                    );
                  })}
                  {(sections.Unassigned || []).length > 0 && (
                    <div style={{ borderTop: '1px solid var(--border)', padding: '8px 8px 10px' }}>
                      <span className="eyebrow" style={{ color: 'var(--orange)' }}>
                        Unassigned <span className="num">({sections.Unassigned.length})</span>
                      </span>
                      <div style={{ marginTop: 6 }}>
                        {sections.Unassigned.map((row) => (
                          <AssignedCard
                            key={row.id}
                            row={row}
                            accent={accent}
                            dashed
                            onRemove={() => handleUnassign(row, line)}
                            removeTitle={`Remove ${row.operator_name || 'operator'} from ${line}`}
                          />
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
            { key: 'D1',    label: 'D1',    accent: BUCKET_COLOR.D1,    rows: grouped.D1 || [],    assignLine: 'D1' },
            { key: 'D2',    label: 'D2',    accent: BUCKET_COLOR.D2,    rows: grouped.D2 || [],    assignLine: 'D2' },
            { key: 'Admin', label: 'Admin', accent: BUCKET_COLOR.Admin,
              rows: (grouped.Others || []).filter((r) => (r.operator_department || '').toLowerCase() === 'admin'),
              assignLine: 'Others' },
            { key: 'Store', label: 'Store', accent: BUCKET_COLOR.Store,
              rows: (grouped.Others || []).filter((r) => (r.operator_department || '').toLowerCase() !== 'admin'),
              assignLine: 'Others' },
          ]).map((bucket) => {
            const accent = bucket.accent;
            const bucketRows = bucket.rows;
            const key = bucket.key;
            const q = (pickerQuery[key] || '').trim().toLowerCase();
            const pickerOps = activeOperators.filter((op) => {
              if (assignedOpIds.has(op.id)) return false;
              if (!q) return true;
              return (op.name || '').toLowerCase().includes(q) ||
                     (op.employee_id || '').toLowerCase().includes(q);
            });
            return (
              <div key={key} style={{ background: 'var(--surface)', border: '1px solid var(--border)',
                borderTop: `3px solid ${accent}`, borderRadius: 'var(--r-md)', boxShadow: 'var(--shadow-card)', minHeight: 220 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '11px 13px', borderBottom: '1px solid var(--border)' }}>
                  <span className="font-display" style={{ fontSize: 14, fontWeight: 700, letterSpacing: '0.04em', color: accent, textTransform: 'uppercase' }}>
                    {bucket.label}
                  </span>
                  <span className="num" style={{ fontSize: 11.5, fontWeight: 600, padding: '1px 8px',
                    borderRadius: 'var(--r-full)', background: 'var(--surface-2)', color: 'var(--t2)' }}>
                    {bucketRows.length}
                  </span>
                </div>
                <div
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const opIds = readDropOpIds(e);
                    if (opIds.length) handleBulkAssign(opIds, bucket.assignLine, null);
                  }}
                  style={{ padding: '8px 8px 10px' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 7 }}>
                    <span className="eyebrow">
                      Operators <span className="num" style={{ color: 'var(--t4)' }}>({bucketRows.length})</span>
                    </span>
                    <Picker pkey={key} line={bucket.assignLine} station={null} ops={pickerOps} />
                  </div>
                  {loading ? (
                    <div style={{ padding: 12, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
                  ) : bucketRows.length === 0 ? (
                    <div style={dropZone}>
                      <span className="eyebrow" style={{ fontSize: 9 }}>Drop operator here</span>
                    </div>
                  ) : (
                    bucketRows.map((row) => (
                      <AssignedCard
                        key={row.id}
                        row={row}
                        accent={accent}
                        onRemove={() => handleUnassign(row, bucket.assignLine)}
                        removeTitle={`Remove ${row.operator_name || 'operator'} from ${bucket.label}`}
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

// ═══════════════════════════════════════════════════════════════════════════
// PerformanceTab — per-operator point-event log + supervisor add modal.
// Worker getPerformanceHistory → { total, events }; addPerformanceEvent
// records points (non-zero int), reason, category, event_date. recorded_by is
// captured server-side from JWT userId.
// ═══════════════════════════════════════════════════════════════════════════
const CAT_TONE = {
  quality:    'warn',
  output:     'info',
  behaviour:  'ok',
  attendance: 'brand',
  other:      'mute',
};

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
      <Panel>
        <EmptyNote icon="activity" title="Restricted" sub="Performance log is restricted to floor supervisors." />
      </Panel>
    );
  }

  const totalColor = data.total > 0 ? 'var(--ok-fg)' : data.total < 0 ? 'var(--bad-fg)' : 'var(--t2)';
  const cols = '110px 80px 130px 1.8fr 150px';

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 14 }}>
        <div ref={comboRef} style={{ flex: '1 1 280px', minWidth: 220, position: 'relative' }}>
          <span className="eyebrow" style={{ display: 'block', marginBottom: 6 }}>Operator</span>
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
            style={{ ...kitInput, fontSize: 13 }}
          />
          {showDropdown && (
            <div
              style={{
                position: 'absolute', top: '100%', left: 0, right: 0,
                marginTop: 4, zIndex: 20,
                background: 'var(--surface-2)', border: '1px solid var(--border-2)',
                borderRadius: 'var(--r-sm)', maxHeight: 280, overflowY: 'auto',
                boxShadow: 'var(--shadow-pop)', animation: 'rl-pop-in 140ms var(--ease)',
              }}
            >
              {filteredOps.length === 0 ? (
                <div style={{ padding: '9px 12px', color: 'var(--t3)', fontFamily: 'var(--font-ui)', fontSize: 12.5 }}>
                  No operators found
                </div>
              ) : (
                filteredOps.slice(0, 50).map((op, idx) => {
                  const isSel = selectedOp?.id === op.id;
                  const isHi = idx === highlightedIdx;
                  let bg = 'transparent';
                  if (isSel) bg = 'var(--yellow-dim)';
                  else if (isHi) bg = 'var(--surface-3)';
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
                        fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t1)',
                      }}
                    >
                      <div>{op.name}</div>
                      <div className="num" style={{ fontSize: 10, color: 'var(--t3)', marginTop: 2 }}>
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
            display: 'flex', gap: 18, alignItems: 'center',
            padding: '9px 15px', background: 'var(--surface)',
            border: '1px solid var(--border)', borderRadius: 'var(--r-md)', boxShadow: 'var(--shadow-card)',
          }}>
            <div>
              <div className="eyebrow">Total</div>
              <div className="num" style={{ fontSize: 20, fontWeight: 700, color: totalColor, marginTop: 2 }}>
                {data.total > 0 ? `+${data.total}` : data.total} pts
              </div>
            </div>
            <div>
              <div className="eyebrow">Events</div>
              <div className="num" style={{ fontSize: 20, fontWeight: 700, color: 'var(--t1)', marginTop: 2 }}>{data.events.length}</div>
            </div>
          </div>
        )}
        <div style={{ marginLeft: 'auto' }}>
          <button onClick={() => setShowAdd(true)} style={btnPrimary}>
            <Icon name="plus" size={14} /> Add Event
          </button>
        </div>
      </div>

      <Panel pad={8}>
        {!operatorId ? (
          <EmptyNote icon="users" title="Pick an operator" sub="Select an operator to view their performance history." />
        ) : loading ? (
          <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        ) : data.events.length === 0 ? (
          <EmptyNote icon="activity" title="No events" sub={`No performance events for ${selectedOp?.name || 'this operator'}.`} />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <div style={{ minWidth: 720 }}>
              <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 12, padding: '0 12px 9px', borderBottom: '1px solid var(--border)' }}>
                {['Date', 'Points', 'Category', 'Reason', 'Recorded by'].map(h => <div key={h} className="eyebrow">{h}</div>)}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {data.events.map((row, i) => {
                  const p = Number(row.points);
                  const pColor = p > 0 ? 'var(--ok-fg)' : p < 0 ? 'var(--bad-fg)' : 'var(--t2)';
                  const catKey = (row.category || 'other').toLowerCase();
                  const def = PERFORMANCE_CATEGORIES.find((x) => x.value === catKey);
                  const reasonText = row.reason || '';
                  return (
                    <div key={row.id || i} style={{ display: 'grid', gridTemplateColumns: cols, gap: 12,
                      alignItems: 'start', padding: '10px 12px', borderTop: i ? '1px solid var(--border)' : 'none' }}>
                      <span className="num" style={{ fontSize: 11.5, color: 'var(--t2)' }}>{fmtDate(row.event_date)}</span>
                      <span className="num" style={{ fontSize: 13, fontWeight: 700, color: pColor }}>{p > 0 ? `+${p}` : p}</span>
                      <ToneBadge tone={CAT_TONE[catKey] || 'mute'} style={{ justifySelf: 'start' }}>
                        {def?.label || capitalize(row.category || 'other')}
                      </ToneBadge>
                      <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t1)', lineHeight: 1.5 }}
                        title={reasonText.length > 80 ? reasonText : undefined}>
                        {reasonText.length > 80 ? reasonText.slice(0, 80) + '…' : reasonText}
                      </span>
                      <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11.5, color: 'var(--t3)' }}>{row.recorded_by_name || '—'}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </Panel>

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
            className="num"
            value={points}
            onChange={(e) => setPoints(e.target.value)}
            placeholder="+5 or -3"
            style={{ ...inputStyle, width: '100%' }}
          />
          <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--t3)', marginTop: 4 }}>
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
          <input type="date" className="num" value={date} onChange={(e) => setDate(e.target.value)} style={{ ...inputStyle, width: '100%' }} />
        </Field>
        <Field label="Reason *" full>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="What happened?"
            style={{ ...inputStyle, width: '100%', resize: 'vertical', fontFamily: 'var(--font-ui)' }}
          />
        </Field>
      </div>
    </Modal>
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
