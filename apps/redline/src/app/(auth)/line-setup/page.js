'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Badge, EmptyState, Spinner, useToast } from '@throttle/ui';

const LINES = ['L1', 'L2', 'L3'];
const DEPT_ORDER = ['Prep', 'Assembly', 'QC', 'Packaging'];
const LINE_COLORS = { L1: 'var(--yellow)', L2: 'var(--blue)', L3: 'var(--green)' };
const STATUS_COLORS = {
  Submitted:     'var(--blue)',
  Issued:        'var(--yellow)',
  'In Progress': 'var(--green)',
};

const istToday = () =>
  new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

function fmtIstDate(d) {
  if (!d) return '—';
  try {
    return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
    });
  } catch { return d; }
}

export default function LineSetupPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const canManageFloor = !!(perms?.users_manage || perms?.production_view || perms?.procurement_approve);

  const [date, setDate]               = useState(istToday());
  const [data, setData]               = useState(null);
  const [loading, setLoading]         = useState(true);
  const [refreshing, setRefreshing]   = useState(false);

  const loadData = useCallback(async () => {
    if (!session || !canManageFloor) return;
    setRefreshing(true);
    try {
      const res = await garageFetch('getLineSetup', { date }, session);
      const payload = res && res.lines ? res : res?.data;
      setData(payload || null);
    } catch (e) {
      showToast(e.message || 'Failed to load line setup', 'error');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [session, canManageFloor, date, showToast]);

  useEffect(() => { loadData(); }, [loadData]);

  const operators = data?.operators || [];

  const handleAssign = useCallback(async ({ operator_id, line, station, station_id }) => {
    try {
      const res = await workerFetch('assignManpower',
        { data: { operator_id, line, station, station_id, shift_date: date } }, session);
      if (!res?.ok) throw new Error(res?.error || 'Assign failed');
      await loadData();
    } catch (e) {
      showToast(e.message || 'Assign failed', 'error');
    }
  }, [session, date, loadData, showToast]);

  const handleUnassign = useCallback(async ({ operator_id, line }) => {
    try {
      const res = await workerFetch('removeManpower',
        { data: { operator_id, line, shift_date: date } }, session);
      if (!res?.ok) throw new Error(res?.error || 'Unassign failed');
      await loadData();
    } catch (e) {
      showToast(e.message || 'Unassign failed', 'error');
    }
  }, [session, date, loadData, showToast]);

  const handleSuggestAll = useCallback(async ({ line, department, stations }) => {
    const emptySlots = [];
    for (const s of stations) {
      const filledCount = s.assignedOps.length;
      const open = Math.max(0, s.capacity - filledCount);
      for (let i = 0; i < open; i++) emptySlots.push(s);
    }
    if (emptySlots.length === 0) {
      showToast(`${department} already fully staffed`, 'info');
      return;
    }
    const usedOps = new Set();
    const assignments = [];
    for (const slot of emptySlots) {
      try {
        const res = await garageFetch('suggestWorkers',
          { station_id: slot.id, line, date }, session);
        const suggestions = (res?.suggestions || res?.data?.suggestions || []);
        const pick = suggestions.find(s => !usedOps.has(s.id));
        if (pick) {
          usedOps.add(pick.id);
          assignments.push({
            operator_id: pick.id,
            line,
            station: department,
            station_id: slot.id,
          });
        }
      } catch {/* skip */}
    }
    if (assignments.length === 0) {
      showToast(`No suggestions available for ${department}`, 'error');
      return;
    }
    try {
      const res = await workerFetch('bulkAssignManpower',
        { data: { shift_date: date, assignments } }, session);
      if (!res?.ok) throw new Error(res?.error || 'Bulk assign failed');
      showToast(`${department}: assigned ${assignments.length} of ${emptySlots.length} open slot${emptySlots.length === 1 ? '' : 's'}`, 'success');
      await loadData();
    } catch (e) {
      showToast(e.message || 'Bulk assign failed', 'error');
    }
  }, [session, date, loadData, showToast]);

  if (perms && !canManageFloor) {
    return (
      <div style={{ padding: 24 }}>
        <EmptyState message="Line Setup is restricted to floor supervisors." />
      </div>
    );
  }

  return (
    <div style={{ color: 'var(--t1)' }}>
      <div style={{
        display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
        gap: 16, marginBottom: 16,
      }}>
        <div>
          <h1 style={{
            margin: 0, fontFamily: 'var(--cond)', fontSize: 28, fontWeight: 900,
            textTransform: 'uppercase', letterSpacing: '0.03em',
          }}>Line Setup</h1>
          <p style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', margin: '4px 0 0' }}>
            Assign clocked-in operators to physical stations · {fmtIstDate(date)}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t2)' }}>
            {operators.length} clocked in
            {refreshing && <span style={{ marginLeft: 8, color: 'var(--t3)' }}>· refreshing…</span>}
          </span>
          <label style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>
            Date
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              style={{
                marginLeft: 6, background: 'var(--surface)', color: 'var(--t1)',
                border: '1px solid var(--border)', borderRadius: 3,
                padding: '4px 6px', fontFamily: 'var(--mono)', fontSize: 12,
              }}
            />
          </label>
        </div>
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}><Spinner /></div>
      ) : (
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12,
        }}>
          {LINES.map(line => (
            <LineColumn
              key={line}
              line={line}
              date={date}
              session={session}
              data={data?.lines?.[line]}
              operators={operators}
              onAssign={handleAssign}
              onUnassign={handleUnassign}
              onSuggestAll={handleSuggestAll}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function LineColumn({ line, date, session, data, operators, onAssign, onUnassign, onSuggestAll }) {
  const run = data?.run || null;
  const design = data?.design || null;
  const assignments = data?.assignments || [];

  // Build a map: station_id → [assignment rows]
  const assignByStation = useMemo(() => {
    const m = {};
    for (const a of assignments) {
      if (!a.station_id) continue;
      if (!m[a.station_id]) m[a.station_id] = [];
      m[a.station_id].push(a);
    }
    return m;
  }, [assignments]);

  // Build a quick map: operator_id → operator info from the global operator pool.
  // Also fall back to any operator on this line whose data might not be in the
  // clocked-in pool (e.g. supervisor manually pre-assigned someone yet to clock in).
  const opById = useMemo(() => {
    const m = {};
    for (const op of operators) m[op.id] = op;
    return m;
  }, [operators]);

  // Department-level counts (assigned / total)
  const deptCounts = useMemo(() => {
    if (!design) return {};
    const out = {};
    for (const d of design.departments || []) {
      const total = d.total_headcount;
      let assigned = 0;
      for (const s of d.stations) {
        const filled = (assignByStation[s.id] || []).length;
        assigned += Math.min(filled, s.capacity);
      }
      out[d.department] = { assigned, total };
    }
    return out;
  }, [design, assignByStation]);

  const totalAssigned = useMemo(
    () => assignments.filter(a => a.station_id).length,
    [assignments],
  );

  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4,
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '10px 14px', borderBottom: '1px solid var(--border)',
        borderLeft: `4px solid ${LINE_COLORS[line]}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span style={{
            fontFamily: 'var(--cond)', fontSize: 16, fontWeight: 900,
            letterSpacing: '0.05em', color: LINE_COLORS[line],
          }}>{line}</span>
          {run ? (
            <Badge color={STATUS_COLORS[run.status] || 'var(--t3)'}>{run.status}</Badge>
          ) : (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>NO RUN</span>
          )}
        </div>
        {run ? (
          <div style={{ marginTop: 6 }}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>{run.product}</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', marginTop: 2 }}>
              {run.run_no}
            </div>
          </div>
        ) : (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', marginTop: 6 }}>
            No run scheduled for {line}.
          </div>
        )}
      </div>

      {/* Department chips */}
      {design && (
        <div style={{
          padding: '8px 14px', borderBottom: '1px solid var(--border)',
          display: 'flex', flexWrap: 'wrap', gap: 6,
        }}>
          {DEPT_ORDER
            .filter(d => deptCounts[d])
            .map(d => {
              const c = deptCounts[d];
              const full = c.assigned >= c.total && c.total > 0;
              return (
                <span key={d} style={{
                  fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
                  padding: '3px 8px', borderRadius: 3,
                  background: full ? 'rgba(34,197,94,0.15)' : 'var(--surface2)',
                  color: full ? '#22c55e' : 'var(--t2)',
                  border: `1px solid ${full ? '#22c55e' : 'var(--border)'}`,
                }}>
                  {d} {c.assigned}/{c.total}
                </span>
              );
            })}
        </div>
      )}

      {/* Body */}
      <div style={{ padding: 12, flex: 1, overflowY: 'auto' }}>
        {!run ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 11 }}>
            — Nothing scheduled —
          </div>
        ) : !design ? (
          <div style={{
            padding: 16, background: 'var(--surface2)', border: '1px dashed var(--border)',
            borderRadius: 3, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t2)',
          }}>
            No line design for <strong>{run.product}</strong>.{' '}
            <a href="/line-design" style={{ color: 'var(--yellow)' }}>Create one in Line Design</a>.
          </div>
        ) : (
          DEPT_ORDER
            .map(d => (design.departments || []).find(x => x.department === d))
            .filter(Boolean)
            .map(d => {
              const stationsWithAssign = d.stations.map(s => ({
                ...s,
                assignedOps: (assignByStation[s.id] || []).map(a => ({
                  ...a,
                  ...(opById[a.operator_id] || {}),
                })),
              }));
              return (
                <DepartmentBlock
                  key={d.department}
                  line={line}
                  date={date}
                  session={session}
                  department={d.department}
                  stations={stationsWithAssign}
                  operators={operators}
                  totalHeadcount={d.total_headcount}
                  onAssign={onAssign}
                  onUnassign={onUnassign}
                  onSuggestAll={onSuggestAll}
                />
              );
            })
        )}
      </div>

      {/* Print roster */}
      {run && (
        <div style={{ padding: 10, borderTop: '1px solid var(--border)', textAlign: 'right' }}>
          <button
            onClick={() => {
              const url = `/line-setup/print?line=${encodeURIComponent(line)}&date=${encodeURIComponent(date)}`;
              window.open(url, '_blank');
            }}
            disabled={totalAssigned === 0}
            style={{
              background: totalAssigned === 0 ? 'var(--surface2)' : 'var(--yellow)',
              color: totalAssigned === 0 ? 'var(--t3)' : '#000',
              border: '1px solid var(--border)', borderRadius: 3,
              padding: '6px 12px', cursor: totalAssigned === 0 ? 'not-allowed' : 'pointer',
              fontFamily: 'var(--cond)', fontSize: 11, fontWeight: 800,
              textTransform: 'uppercase', letterSpacing: '0.06em',
            }}
          >Print Roster</button>
        </div>
      )}
    </div>
  );
}

function DepartmentBlock({
  line, date, session, department, stations, operators, totalHeadcount,
  onAssign, onUnassign, onSuggestAll,
}) {
  const assignedCount = stations.reduce(
    (sum, s) => sum + Math.min(s.assignedOps.length, s.capacity), 0,
  );

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 6,
      }}>
        <div style={{
          fontFamily: 'var(--cond)', fontSize: 12, fontWeight: 800,
          textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--t1)',
        }}>
          {department}
          <span style={{
            marginLeft: 8, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)',
          }}>
            ({assignedCount}/{totalHeadcount} staffed)
          </span>
        </div>
        <button
          onClick={() => onSuggestAll({ line, department, stations })}
          style={{
            background: 'transparent', color: 'var(--yellow)',
            border: '1px solid var(--yellow)', borderRadius: 3,
            padding: '2px 8px', fontFamily: 'var(--mono)', fontSize: 10,
            cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.05em',
          }}
        >Suggest All</button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {stations.map(s => (
          <StationCard
            key={s.id}
            station={s}
            line={line}
            department={department}
            date={date}
            session={session}
            operators={operators}
            onAssign={onAssign}
            onUnassign={onUnassign}
          />
        ))}
      </div>
    </div>
  );
}

function StationCard({ station, line, department, date, session, operators, onAssign, onUnassign }) {
  const filledCount = station.assignedOps.length;
  const slots = [];
  for (let i = 0; i < station.capacity; i++) {
    slots.push(station.assignedOps[i] || null);
  }

  return (
    <div style={{
      width: 200, background: 'var(--surface2)',
      border: '1px solid var(--border)', borderRadius: 4,
      padding: 8, display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700, color: 'var(--t2)',
        }}>{station.display_code}</span>
        <span style={{ fontSize: 14 }} title={station.capacity === 2 ? 'Two-worker' : 'Single-worker'}>
          {station.capacity === 2 ? '👤👤' : '👤'}
        </span>
      </div>
      {slots.map((op, idx) => (
        op ? (
          <FilledSlot
            key={idx}
            op={op}
            onUnassign={() => onUnassign({ operator_id: op.operator_id, line })}
          />
        ) : (
          <EmptySlot
            key={idx}
            session={session}
            stationId={station.id}
            line={line}
            department={department}
            date={date}
            operators={operators}
            onAssign={onAssign}
          />
        )
      ))}
    </div>
  );
}

function FilledSlot({ op, onUnassign }) {
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3,
      padding: '4px 8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4,
    }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {op.name || '(unknown)'}
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)' }}>
          {op.employee_id || op.operator_id?.slice(0, 8)}
        </div>
      </div>
      <button
        onClick={onUnassign}
        title="Unassign"
        style={{
          background: 'none', border: 'none', color: 'var(--t3)',
          cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 4px',
        }}
      >×</button>
    </div>
  );
}

function EmptySlot({ session, stationId, line, department, date, operators, onAssign }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [search, setSearch] = useState('');
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const openPicker = async () => {
    setOpen(true);
    setLoading(true);
    setSearch('');
    try {
      const res = await garageFetch('suggestWorkers',
        { station_id: stationId, line, date }, session);
      const list = res?.suggestions || res?.data?.suggestions || [];
      setSuggestions(list);
    } catch {
      setSuggestions([]);
    } finally {
      setLoading(false);
    }
  };

  const manualMatches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return operators
      .filter(o => !o.already_assigned)
      .filter(o =>
        (o.name || '').toLowerCase().includes(q) ||
        (o.employee_id || '').toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [search, operators]);

  const handlePick = async (op) => {
    setOpen(false);
    await onAssign({
      operator_id: op.id,
      line,
      station: department,
      station_id: stationId,
    });
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={openPicker}
        style={{
          width: '100%', background: 'transparent',
          border: '1px dashed var(--border)', borderRadius: 3,
          padding: '4px 6px', color: 'var(--t3)', cursor: 'pointer',
          fontFamily: 'var(--mono)', fontSize: 11,
        }}
      >+ Assign</button>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4,
          background: '#111', border: '1px solid #333', borderRadius: 4,
          padding: 8, zIndex: 20, maxHeight: 280, overflowY: 'auto',
          boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        }}>
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search clocked-in operators"
            style={{
              width: '100%', background: 'var(--surface)', color: 'var(--t1)',
              border: '1px solid var(--border)', borderRadius: 3,
              padding: '4px 6px', fontFamily: 'var(--mono)', fontSize: 11,
              marginBottom: 8,
            }}
          />
          {loading ? (
            <div style={{ padding: 8, textAlign: 'center' }}><Spinner /></div>
          ) : search.trim() ? (
            manualMatches.length === 0 ? (
              <div style={{ fontSize: 10, color: 'var(--t3)', fontFamily: 'var(--mono)' }}>No matches</div>
            ) : (
              manualMatches.map(op => (
                <SuggestionRow key={op.id} op={op} onPick={() => handlePick(op)} />
              ))
            )
          ) : suggestions.length === 0 ? (
            <div style={{ fontSize: 10, color: 'var(--t3)', fontFamily: 'var(--mono)' }}>
              No clocked-in operators available.
            </div>
          ) : (
            suggestions.map(op => (
              <SuggestionRow key={op.id} op={op} onPick={() => handlePick(op)} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function SuggestionRow({ op, onPick }) {
  const dots = !op.has_history
    ? null
    : op.frequency >= 6 ? '●●●'
    : op.frequency >= 3 ? '●●'
    : '●';
  return (
    <button
      onClick={onPick}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        width: '100%', background: 'transparent', border: 'none', textAlign: 'left',
        padding: '4px 6px', cursor: 'pointer', color: 'var(--t1)',
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 11, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {op.name || '(unknown)'}
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)' }}>
          {op.employee_id || ''}
        </div>
      </div>
      {dots && (
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--yellow)', marginLeft: 6 }}>
          {dots}
        </span>
      )}
    </button>
  );
}
