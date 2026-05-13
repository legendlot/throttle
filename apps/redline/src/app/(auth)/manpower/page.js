'use client';
import { useCallback, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { workerFetch } from '@throttle/db';
import { Badge, EmptyState, Spinner, useToast } from '@throttle/ui';
import { useAutoRefresh } from '../../../hooks/useAutoRefresh.js';
import { useRefreshState } from '../layout.js';

const LINE_ORDER  = ['L1', 'L2', 'L3'];
const LINE_COLORS = { L1: 'var(--yellow)', L2: 'var(--blue)', L3: 'var(--green)', Others: '#f97316' };

// getManpowerLog returns { L1: { Assembly:[], QC:[], Packaging:[], Unassigned:[] }, ...,
// Others: [...] }. Flatten line buckets back to flat arrays; Others arrives flat.
function flattenRoster(nested) {
  const out = { L1: [], L2: [], L3: [], Others: [] };
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
  if (Array.isArray(nested?.Others)) out.Others = nested.Others;
  return out;
}

const istToday = () =>
  new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

function fmtIstTime(ts) {
  if (!ts) return null;
  try {
    return new Date(ts).toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return null;
  }
}

function capitalize(s) {
  return (s || '').charAt(0).toUpperCase() + (s || '').slice(1);
}

function fmtIstDate(d) {
  try {
    return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
    });
  } catch { return d; }
}

export default function ManpowerPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const { setRefreshing, setLastRefreshed } = useRefreshState();
  const [today] = useState(() => istToday());
  const [openShifts, setOpenShifts] = useState([]);
  const [rosterByLine, setRosterByLine] = useState({});
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);

  const canManageFloor = !!(perms?.users_manage || perms?.production_view || perms?.procurement_approve);

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

  // operator_id -> assigned line (only includes today's roster).
  // 'Others' is a valid line value alongside L1/L2/L3.
  const assignedLineByOpId = useMemo(() => {
    const m = {};
    for (const line of LINE_ORDER) {
      for (const a of rosterByLine[line] || []) m[a.operator_id] = line;
    }
    for (const a of rosterByLine.Others || []) m[a.operator_id] = 'Others';
    return m;
  }, [rosterByLine]);

  // Classify each open-shift row into a line bucket, Others, or unassigned.
  const { byLine, others, unassigned } = useMemo(() => {
    const lines = { L1: [], L2: [], L3: [] };
    const oth = [];
    const unas = [];
    for (const row of openShifts) {
      const line = assignedLineByOpId[row.operator_id];
      if (line === 'Others') oth.push(row);
      else if (line && lines[line]) lines[line].push(row);
      else unas.push(row);
    }
    return { byLine: lines, others: oth, unassigned: unas };
  }, [openShifts, assignedLineByOpId]);

  if (perms && !canManageFloor) {
    return (
      <div style={{ padding: 24 }}>
        <EmptyState message="Manpower view is restricted to floor supervisors." />
      </div>
    );
  }

  if (forbidden) {
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
          Manpower — {fmtIstDate(today)}
        </h1>
        <p style={{ color: 'var(--t3)', fontSize: 11, marginTop: 4, fontFamily: 'var(--mono)' }}>
          Live floor view · open shifts only · refreshes every 60s.
        </p>
      </div>

      {loading && openShifts.length === 0 && Object.keys(rosterByLine).length === 0 ? (
        <div style={{ padding: 48, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
      ) : (
        <>
          {/* Headcount bar */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 12, marginBottom: 16 }}>
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
              label="Others"
              accent={LINE_COLORS.Others}
              count={others.length}
              sub={`${(rosterByLine.Others || []).length} assigned`}
            />
            <HeadcountCard
              label="Unassigned"
              accent="var(--t3)"
              count={unassigned.length}
              sub="open shift, no line"
            />
          </div>

          {/* Line sections */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12, marginBottom: 16 }}>
            {LINE_ORDER.map((line) => (
              <LineColumn key={line} line={line} rows={byLine[line]} accent={LINE_COLORS[line]} />
            ))}
          </div>

          {/* Others section — hidden when empty */}
          {others.length > 0 && (
            <OthersSection rows={others} accent={LINE_COLORS.Others} />
          )}

          {/* Unassigned section — hidden when empty */}
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
