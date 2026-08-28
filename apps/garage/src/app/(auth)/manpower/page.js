'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { workerFetch } from '@throttle/db';
import { Badge, ConfirmModal, EmptyState, Modal, Spinner, useToast } from '@throttle/ui';
import { countPresent } from '@throttle/domain';

// ── Constants ───────────────────────────────────────────────────────────────
const STORE_ACTIVITIES = [
  'Inwarding / GRN / Receiving',
  'Stock Issuance / Picking',
  'Admin',
  'Counting',
  'Clean Up / Maintenance',
  'Other / Ad Hoc',
];

// ── Shared styles ───────────────────────────────────────────────────────────
const panelStyle       = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const panelBodyStyle   = { padding: '12px 14px' };
const inputStyle       = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px', fontSize: 12, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit' };
const selectStyle      = { ...inputStyle, cursor: 'pointer' };
const labelStyle       = { fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block' };
const btnSecondary     = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 12px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)' };

// Store team = the operators.team='store' workforce. Attendance + shift admin
// for the store live here (Production → Redline Production, Dispatch → Redline Dispatch).
const STORE_TEAM = 'store';
const STORE_DEPT = 'store';

// Manual day classification (sick / half-day / leave …) — feeds the future salary/OT engine.
const DAY_STATUS_OPTS = [
  { value: '',         label: 'Normal' },
  { value: 'full_day', label: 'Full day' },
  { value: 'half_day', label: 'Half day' },
  { value: 'absent',   label: 'Absent' },
  { value: 'leave',    label: 'Leave' },
  { value: 'holiday',  label: 'Holiday' },
];
const DAY_STATUS_COLOR = {
  half_day: 'var(--warn, #d97706)', absent: 'var(--bad, #ef4444)',
  leave: 'var(--yellow)', holiday: 'var(--t3)', full_day: 'var(--ok, #22c55e)',
};

// ── Display helpers ─────────────────────────────────────────────────────────
function capitalize(s) { return (s || '').charAt(0).toUpperCase() + (s || '').slice(1); }
function fmtHM(t) { return t ? String(t).slice(0, 5) : null; }
function fmtDuration(ci, co) {
  if (!ci) return '—';
  const end = co ? new Date(co) : new Date();
  const mins = Math.max(0, Math.round((end - new Date(ci)) / 60000));
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${h}h ${String(m).padStart(2, '0')}m${co ? '' : ' …'}`;
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
function fmtIstDateTime(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
  } catch { return '—'; }
}

// ═══════════════════════════════════════════════════════════════════════════
// Garage /manpower — the Store team's Manpower home (Phase 2). Three tabs:
//   • Store Activities — daily activity log (existing).
//   • Attendance       — store team clock-in/out, day-status, close-shift.
//   • Shifts           — store shift timings admin (effective-dated, audited).
// Production + Dispatch attendance/shifts live on Redline.
// ═══════════════════════════════════════════════════════════════════════════
export default function ManpowerPage() {
  const { session, perms } = useAuth();
  const [activeTab, setActiveTab] = useState('store');

  const canManageFloor = !!(perms?.users_manage || perms?.production_view || perms?.procurement_approve);

  if (perms && !perms.dashboard) {
    return <div style={{ padding: 24, color: 'var(--t3)' }}>Access restricted</div>;
  }

  return (
    <div style={{ color: 'var(--t1)' }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontFamily: 'var(--cond)', fontSize: 28, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.03em', margin: 0 }}>
          Manpower
        </h1>
        <p style={{ color: 'var(--t3)', fontSize: 11, marginTop: 4, fontFamily: 'var(--mono)' }}>
          Store team — activity log, attendance, and shift timings. Production &amp; Dispatch live on Redline.
        </p>
      </div>

      <TabBar
        tabs={[
          { key: 'store',      label: 'Store Activities' },
          { key: 'attendance', label: 'Attendance' },
          { key: 'shifts',     label: 'Shifts' },
        ]}
        active={activeTab}
        onChange={setActiveTab}
      />

      {activeTab === 'store'      && <StoreActivitiesTab session={session} canManageFloor={canManageFloor} />}
      {activeTab === 'attendance' && <AttendanceTab session={session} canManageFloor={canManageFloor} />}
      {activeTab === 'shifts'     && <ShiftsTab session={session} canManageFloor={canManageFloor} />}
    </div>
  );
}

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
// StoreActivitiesTab — daily activity log for store-assigned operators.
// Roster source: store.manpower_assignments where line='Others' for the date.
// Activity log: store.store_activity_log (append-only, latest row = current).
// ═══════════════════════════════════════════════════════════════════════════
function StoreActivitiesTab({ session, canManageFloor }) {
  const { showToast } = useToast();
  const [date, setDate] = useState(istToday());
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  // operator_id -> pending activity change (so the select doesn't disable the whole row)
  const [savingOp, setSavingOp] = useState({});
  // operator_id -> notes draft (kept separate from the saved row so the input is editable)
  const [notesDraft, setNotesDraft] = useState({});
  // operator selected for the history modal
  const [historyTarget, setHistoryTarget] = useState(null);

  const load = useCallback(async () => {
    if (!session || !canManageFloor || !date) return;
    setLoading(true);
    try {
      const res = await workerFetch('getStoreRoster', { data: { date } }, session);
      const list = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
      setRows(list);
      // Initialise notes drafts from saved values for any operator we don't already have local edits for
      setNotesDraft((prev) => {
        const next = { ...prev };
        for (const op of list) {
          if (next[op.id] === undefined) next[op.id] = op.current_notes || '';
        }
        return next;
      });
    } catch (e) {
      showToast(e.message || 'Failed to load store roster', 'error');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [session, canManageFloor, date, showToast]);

  useEffect(() => { load(); }, [load]);

  async function changeActivity(op, nextActivity) {
    if (!canManageFloor || !nextActivity || nextActivity === op.current_activity) return;
    setSavingOp((s) => ({ ...s, [op.id]: true }));
    try {
      await workerFetch('assignStoreActivity', {
        data: {
          operator_id: op.id,
          shift_date:  date,
          activity:    nextActivity,
          notes:       notesDraft[op.id] || null,
        },
      }, session);
      showToast(`${op.name}: ${nextActivity}`, 'success');
      await load();
    } catch (e) {
      showToast(e.message || 'Failed to log activity', 'error');
    } finally {
      setSavingOp((s) => { const next = { ...s }; delete next[op.id]; return next; });
    }
  }

  async function saveNotes(op) {
    if (!canManageFloor || !op.current_activity) {
      showToast('Set an activity before saving notes', 'error');
      return;
    }
    const next = (notesDraft[op.id] || '').trim();
    if (next === (op.current_notes || '')) return;
    setSavingOp((s) => ({ ...s, [op.id]: true }));
    try {
      await workerFetch('assignStoreActivity', {
        data: {
          operator_id: op.id,
          shift_date:  date,
          activity:    op.current_activity,
          notes:       next || null,
        },
      }, session);
      showToast(`Notes updated for ${op.name}`, 'success');
      await load();
    } catch (e) {
      showToast(e.message || 'Failed to save notes', 'error');
    } finally {
      setSavingOp((s) => { const next = { ...s }; delete next[op.id]; return next; });
    }
  }

  const totalActive = useMemo(
    () => rows.filter((r) => !!r.current_activity).length,
    [rows]
  );

  if (!canManageFloor) {
    return (
      <div style={{ ...panelStyle, padding: '40px 24px', textAlign: 'center' }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)' }}>
          Store Activities are restricted to floor supervisors.
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Toolbar */}
      <div style={{ ...panelStyle, marginBottom: 12 }}>
        <div style={{ padding: '10px 14px', display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <span style={labelStyle}>Date</span>
            <input
              type="date"
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                setNotesDraft({}); // reset drafts so they pick up the new day's notes
              }}
              style={{ ...inputStyle, fontFamily: 'var(--mono)' }}
            />
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              {rows.length} store operator{rows.length === 1 ? '' : 's'}
              {rows.length > 0 && ` · ${totalActive} active`}
            </span>
            <button style={btnSecondary} onClick={load} disabled={loading}>↻</button>
          </div>
        </div>
      </div>

      {/* Roster */}
      <div style={panelStyle}>
        <div style={panelBodyStyle}>
          {loading ? (
            <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              message={`No operators assigned to Store for ${date}. Assign operators to "Others" in Redline → Manpower → Daily Roster first.`}
            />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    <th style={th}>Operator</th>
                    <th style={th}>Dept</th>
                    <th style={th}>Current Activity</th>
                    <th style={{ ...th, width: 110 }}>Since</th>
                    <th style={th}>Assigned By</th>
                    <th style={{ ...th, width: 220 }}>Notes</th>
                    <th style={{ ...th, width: 60 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((op) => {
                    const saving = !!savingOp[op.id];
                    return (
                      <tr key={op.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                        <td style={{ ...td, color: 'var(--t1)', fontWeight: 600 }}>
                          <button
                            onClick={() => setHistoryTarget(op)}
                            style={{ background: 'transparent', border: 'none', padding: 0, color: 'var(--t1)', fontWeight: 600, fontSize: 12, cursor: 'pointer', textAlign: 'left' }}
                            title="View activity history"
                          >
                            {op.name}
                          </button>
                          <div style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--t3)', marginTop: 2 }}>
                            {op.employee_id || '—'}
                          </div>
                        </td>
                        <td style={td}>
                          <Badge color="var(--t3)">{capitalize(op.department || '—')}</Badge>
                        </td>
                        <td style={td}>
                          <select
                            value={op.current_activity || ''}
                            disabled={saving}
                            onChange={(e) => changeActivity(op, e.target.value)}
                            style={{ ...selectStyle, width: '100%', maxWidth: 240 }}
                          >
                            <option value="">— No activity assigned</option>
                            {STORE_ACTIVITIES.map((a) => (
                              <option key={a} value={a}>{a}</option>
                            ))}
                          </select>
                        </td>
                        <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t2)' }}>
                          {fmtIstTime(op.activity_at) || '—'}
                        </td>
                        <td style={{ ...td, color: 'var(--t2)' }}>
                          {op.assigned_by_name || '—'}
                        </td>
                        <td style={td}>
                          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                            <input
                              type="text"
                              value={notesDraft[op.id] ?? ''}
                              placeholder="Add context…"
                              disabled={saving}
                              onChange={(e) => setNotesDraft((s) => ({ ...s, [op.id]: e.target.value }))}
                              onKeyDown={(e) => { if (e.key === 'Enter') saveNotes(op); }}
                              style={{ ...inputStyle, flex: 1, minWidth: 0 }}
                            />
                            {(notesDraft[op.id] ?? '') !== (op.current_notes || '') && (
                              <button
                                onClick={() => saveNotes(op)}
                                disabled={saving || !op.current_activity}
                                title={op.current_activity ? 'Save notes (logs a new entry with the current activity)' : 'Set an activity before saving notes'}
                                style={{ ...btnSecondary, padding: '3px 8px', fontSize: 10 }}
                              >
                                Save
                              </button>
                            )}
                          </div>
                        </td>
                        <td style={{ ...td, textAlign: 'right' }}>
                          {saving ? (
                            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>…</span>
                          ) : (
                            <button
                              onClick={() => setHistoryTarget(op)}
                              style={{ ...btnSecondary, padding: '3px 8px', fontSize: 10 }}
                              title="View activity history"
                            >
                              History
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <ActivityHistoryModal
        target={historyTarget}
        date={date}
        session={session}
        onClose={() => setHistoryTarget(null)}
      />
    </div>
  );
}

const th = {
  padding: '10px 12px',
  textAlign: 'left',
  fontFamily: 'var(--mono)',
  fontSize: 10,
  fontWeight: 700,
  color: 'var(--t3)',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
};
const td = { padding: '10px 12px', verticalAlign: 'middle' };

function ActivityHistoryModal({ target, date, session, onClose }) {
  const { showToast } = useToast();
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!target) {
      setHistory([]);
      return;
    }
    setLoading(true);
    (async () => {
      try {
        const res = await workerFetch(
          'getStoreActivityHistory',
          { data: { operator_id: target.id, date } },
          session
        );
        const list = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
        if (!cancelled) setHistory(list);
      } catch (e) {
        if (!cancelled) {
          showToast(e.message || 'Failed to load history', 'error');
          setHistory([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [target, date, session, showToast]);

  if (!target) return null;
  return (
    <Modal
      open={!!target}
      onClose={onClose}
      title={`${target.name} — ${date}`}
      size="md"
    >
      <div style={{ marginTop: 8 }}>
        {loading ? (
          <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        ) : history.length === 0 ? (
          <div style={{ padding: 24, color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 12, textAlign: 'center' }}>
            No activity logged yet on {date}.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {history.map((row) => (
              <div
                key={row.id}
                style={{
                  background: 'var(--surface2)',
                  border: '1px solid var(--border)',
                  borderLeft: '3px solid var(--yellow)',
                  borderRadius: 3,
                  padding: '8px 12px',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                  <span style={{ fontSize: 13, color: 'var(--t1)', fontWeight: 600 }}>{row.activity}</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>
                    {fmtIstDateTime(row.assigned_at)}
                  </span>
                </div>
                {row.notes && (
                  <div style={{ marginTop: 4, fontSize: 12, color: 'var(--t2)' }}>
                    {row.notes}
                  </div>
                )}
                <div style={{ marginTop: 4, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>
                  by {row.assigned_by_name || '—'}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// AttendanceTab — store team clock-in/out for a day, with streak/absent stats,
// day-status (half-day etc.) classification, and a Close-shift action.
// Worker: getOperatorAttendance (team:'store') + getAttendanceStats + setDayStatus
// + closeAttendanceShift. All canManageFloor-gated. Mirrors Redline's attendance.
// ═══════════════════════════════════════════════════════════════════════════
function AttendanceTab({ session, canManageFloor }) {
  const { showToast } = useToast();
  const [date, setDate] = useState(istToday());
  const [rows, setRows] = useState([]);
  const [stats, setStats] = useState({});      // operator_id → { streak, absent_month }
  const [loading, setLoading] = useState(true);
  const [closeTarget, setCloseTarget] = useState(null);
  const [closing, setClosing] = useState(false);
  const [savingStatus, setSavingStatus] = useState({}); // attendance_id → bool
  const [selected, setSelected] = useState(() => new Set()); // attendance_ids picked for bulk close
  const [bulkOpen, setBulkOpen] = useState(false);

  const load = useCallback(async () => {
    if (!session || !canManageFloor || !date) return;
    setLoading(true);
    try {
      const [attRes, statRes] = await Promise.all([
        workerFetch('getOperatorAttendance', { data: { date_from: date, date_to: date, team: STORE_TEAM } }, session),
        workerFetch('getAttendanceStats',    { data: { date } }, session).catch(() => null),
      ]);
      const list = Array.isArray(attRes?.data) ? attRes.data : Array.isArray(attRes) ? attRes : [];
      setRows(list);
      const statList = Array.isArray(statRes?.data) ? statRes.data : [];
      const map = {};
      for (const s of statList) map[s.operator_id] = { streak: s.streak, absent_month: s.absent_month };
      setStats(map);
    } catch (e) {
      showToast(e.message || 'Failed to load attendance', 'error');
      setRows([]); setStats({});
    } finally {
      setLoading(false);
    }
  }, [session, canManageFloor, date, showToast]);

  useEffect(() => { load(); }, [load]);

  async function setDayStatus(row, day_status) {
    setSavingStatus((s) => ({ ...s, [row.id]: true }));
    setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, day_status: day_status || null } : r)));
    try {
      await workerFetch('setDayStatus', { data: { attendance_id: row.id, day_status: day_status || null } }, session);
    } catch (e) {
      showToast(e.message || 'Failed to set day status', 'error');
      load();
    } finally {
      setSavingStatus((s) => { const n = { ...s }; delete n[row.id]; return n; });
    }
  }

  // Only OPEN shifts are selectable — a closed one has nothing to do.
  const openRows = rows.filter((r) => !r.clock_out);
  const allOpenSelected = openRows.length > 0 && openRows.every((r) => selected.has(r.id));
  function toggleRow(id) {
    setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function toggleAll() {
    setSelected(allOpenSelected ? new Set() : new Set(openRows.map((r) => r.id)));
  }

  async function confirmBulkClose() {
    const ids = openRows.filter((r) => selected.has(r.id)).map((r) => r.id);
    if (!ids.length) return;
    setClosing(true);
    try {
      // One batched call — the worker closes them with a single `in.()` update and reports
      // per-row outcomes. Deliberately partial: a row someone else closed in the meantime is
      // reported, never fatal (see the handler's note on why this differs from RULE-STOCK-002).
      const res = await workerFetch('closeAttendanceShift', { data: { attendance_ids: ids } }, session);
      const d = res?.data || {};
      const bits = [`${d.closed ?? 0} shift${(d.closed ?? 0) === 1 ? '' : 's'} closed`];
      if (d.already_closed) bits.push(`${d.already_closed} already closed`);
      if (d.not_found)      bits.push(`${d.not_found} not found`);
      showToast(bits.join(' · '), (d.closed ?? 0) > 0 ? 'success' : 'error');
      setBulkOpen(false);
      setSelected(new Set());
      load();
    } catch (e) {
      showToast(e.message || 'Bulk close failed', 'error');
    } finally {
      setClosing(false);
    }
  }

  async function confirmClose() {
    if (!closeTarget) return;
    setClosing(true);
    try {
      const res = await workerFetch('closeAttendanceShift', { data: { attendance_id: closeTarget.id } }, session);
      const inner = res?.data;
      if (inner && inner.ok === false) showToast(inner.error || 'Could not close shift', 'error');
      else showToast(`Shift closed for ${closeTarget.operator_name || 'operator'}`, 'success');
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

  // Excludes day_status absent/leave — see countPresent() in @throttle/domain.
  const presentCount = countPresent(rows);

  return (
    <div>
      <div style={{ ...panelStyle, marginBottom: 12 }}>
        <div style={{ padding: '10px 14px', display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <span style={labelStyle}>Date</span>
            <input type="date" value={date} onChange={(e) => { setSelected(new Set()); setDate(e.target.value); }} style={{ ...inputStyle, fontFamily: 'var(--mono)' }} />
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              {presentCount} present · {rows.length} record{rows.length === 1 ? '' : 's'}
            </span>
            {selected.size > 0 && (
              <button style={{ ...btnSecondary, fontSize: 11 }} onClick={() => setBulkOpen(true)} disabled={closing}>
                Close {selected.size} shift{selected.size === 1 ? '' : 's'}
              </button>
            )}
            <button style={btnSecondary} onClick={load} disabled={loading}>↻</button>
          </div>
        </div>
      </div>

      <div style={panelStyle}>
        <div style={panelBodyStyle}>
          {loading ? (
            <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : rows.length === 0 ? (
            <EmptyState message={`No store attendance recorded for ${date}.`} />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 920 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    <th style={{ ...th, width: 30 }}>
                      <input type="checkbox" checked={allOpenSelected} onChange={toggleAll}
                        disabled={!openRows.length}
                        title={openRows.length ? 'Select all open shifts' : 'No open shifts'} />
                    </th>
                    <th style={th}>Operator</th>
                    <th style={th}>Clock in</th>
                    <th style={th}>Clock out</th>
                    <th style={th}>Duration</th>
                    <th style={{ ...th, textAlign: 'right' }}>Streak</th>
                    <th style={{ ...th, textAlign: 'right' }}>Absent (mo)</th>
                    <th style={{ ...th, width: 150 }}>Day status</th>
                    <th style={{ ...th, width: 96 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const st = stats[row.operator_id];
                    const isOt = (row.shift_type || '').toLowerCase() === 'overtime';
                    return (
                      <tr key={row.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                        <td style={td}>
                          {!row.clock_out && (
                            <input type="checkbox" checked={selected.has(row.id)} onChange={() => toggleRow(row.id)} />
                          )}
                        </td>
                        <td style={{ ...td, color: 'var(--t1)', fontWeight: 600 }}>
                          {row.operator_name || '—'}
                          {isOt && <Badge color="var(--yellow)" style={{ marginLeft: 6 }}>OT</Badge>}
                        </td>
                        <td style={{ ...td, fontFamily: 'var(--mono)', color: 'var(--t1)' }}>
                          {fmtIstTime(row.clock_in) || '—'}
                          {row.late_minutes > 0 && (
                            <div style={{ fontSize: 9.5, color: 'var(--bad, #ef4444)' }} title={`${row.late_minutes} min late vs scheduled start`}>
                              +{row.late_minutes}m late
                            </div>
                          )}
                        </td>
                        <td style={{ ...td, fontFamily: 'var(--mono)', color: 'var(--t1)' }}>
                          {row.clock_out ? (
                            <>
                              {fmtIstTime(row.clock_out)}
                              {row.auto_closed && <span style={{ marginLeft: 6, fontSize: 9, color: 'var(--t3)' }} title="Auto-closed at 1:00 AM IST">Auto</span>}
                              {row.overtime_minutes > 0 && (
                                <div style={{ fontSize: 9.5, color: 'var(--yellow)' }} title={`${row.overtime_minutes} min past scheduled end`}>+{row.overtime_minutes}m OT</div>
                              )}
                            </>
                          ) : <Badge color="var(--warn, #d97706)">Open</Badge>}
                        </td>
                        <td style={{ ...td, fontFamily: 'var(--mono)', color: 'var(--t2)' }}>{fmtDuration(row.clock_in, row.clock_out)}</td>
                        <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--mono)', fontWeight: 600, color: st && st.streak > 0 ? 'var(--ok, #22c55e)' : 'var(--t3)' }}
                          title={st ? `${st.streak} consecutive working days (Mon–Sat)` : ''}>
                          {st ? `${st.streak}d` : '—'}
                        </td>
                        <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--mono)', fontWeight: 600, color: st && st.absent_month > 0 ? 'var(--bad, #ef4444)' : 'var(--t3)' }}
                          title={st ? `${st.absent_month} working days absent this month` : ''}>
                          {st ? st.absent_month : '—'}
                        </td>
                        <td style={td}>
                          <select
                            value={row.day_status || ''}
                            disabled={!!savingStatus[row.id]}
                            onChange={(e) => setDayStatus(row, e.target.value)}
                            title={row.day_status_note || 'Manual day classification (feeds payroll)'}
                            style={{ ...selectStyle, width: '100%', maxWidth: 150,
                              color: row.day_status ? (DAY_STATUS_COLOR[row.day_status] || 'var(--t1)') : 'var(--t3)' }}
                          >
                            {DAY_STATUS_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        </td>
                        <td style={{ ...td, textAlign: 'right' }}>
                          {!row.clock_out && (
                            <button onClick={() => setCloseTarget(row)} style={{ ...btnSecondary, padding: '3px 8px', fontSize: 10 }} title="Close shift (sets clock-out to now)">
                              Close
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <ConfirmModal
        open={bulkOpen}
        onClose={() => !closing && setBulkOpen(false)}
        title="Close Shifts"
        confirmLabel={closing ? 'Closing…' : `Close ${selected.size} shift${selected.size === 1 ? '' : 's'}`}
        onConfirm={confirmBulkClose}
        loading={closing}
        message={`Close ${selected.size} open shift${selected.size === 1 ? '' : 's'}? Each clock-out is set to the current time. This cannot be undone here.`}
      />

      <ConfirmModal
        open={!!closeTarget}
        onClose={() => !closing && setCloseTarget(null)}
        title="Close Shift"
        confirmLabel={closing ? 'Closing…' : 'Close Shift'}
        onConfirm={confirmClose}
        loading={closing}
        message={closeTarget ? `Close shift for ${closeTarget.operator_name || 'this operator'}? This sets their clock-out to the current time.` : ''}
      />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ShiftsTab — store shift timings admin (Phase 2). Editing a time writes a NEW
// effective-dated version (never overwrites) for a full audit trail. Scoped to
// department 'store'. Worker: getShifts / createShift / setShiftActive /
// addShiftVersion / getShiftHistory. Read by the recordAttendance resolver.
// ═══════════════════════════════════════════════════════════════════════════
function ShiftsTab({ session, canManageFloor }) {
  const { showToast } = useToast();
  const [shifts, setShifts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editTarget, setEditTarget] = useState(null);
  const [histTarget, setHistTarget] = useState(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    if (!session || !canManageFloor) return;
    setLoading(true);
    try {
      const res = await workerFetch('getShifts', { data: {} }, session);
      const list = Array.isArray(res?.data) ? res.data : [];
      setShifts(list.filter((s) => s.department === STORE_DEPT));
    } catch (e) {
      showToast(e.message || 'Failed to load shifts', 'error');
    } finally {
      setLoading(false);
    }
  }, [session, canManageFloor, showToast]);
  useEffect(() => { load(); }, [load]);

  async function toggleActive(s) {
    try {
      await workerFetch('setShiftActive', { data: { shift_id: s.id, is_active: !s.is_active } }, session);
      load();
    } catch (e) { showToast(e.message || 'Failed', 'error'); }
  }

  if (!canManageFloor) {
    return (
      <div style={{ ...panelStyle, padding: '40px 24px', textAlign: 'center' }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)' }}>
          Shift admin is restricted to floor supervisors.
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--t3)', maxWidth: 680, marginBottom: 12, lineHeight: 1.5 }}>
        Store shift timings drive attendance — the clock-in window, the end time, and overtime.
        Changing a time takes effect from the date you pick and is saved as a new version;
        older versions stay for the record. Confirm the store&apos;s real shift time here.
      </div>

      <div style={panelStyle}>
        <div style={{ padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border)' }}>
          <span style={{ fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Store shifts</span>
          <button style={btnSecondary} onClick={() => setAdding(true)}>+ Add shift</button>
        </div>
        <div style={{ padding: '4px 14px 12px' }}>
          {loading ? (
            <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    <th style={th}>Shift</th>
                    <th style={th}>Timing</th>
                    <th style={th}>Effective</th>
                    <th style={th}>Status</th>
                    <th style={{ ...th, textAlign: 'right' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {shifts.map((s) => (
                    <tr key={s.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', opacity: s.is_active ? 1 : 0.55 }}>
                      <td style={{ ...td, color: 'var(--t1)', fontWeight: 600 }}>{s.name}</td>
                      <td style={{ ...td, fontFamily: 'var(--mono)' }}>
                        {s.current
                          ? `${fmtHM(s.current.start_time)}–${fmtHM(s.current.end_time)}${s.current.ends_next_day ? ' (+1d)' : ''}`
                          : <span style={{ color: 'var(--t3)' }}>— not set —</span>}
                      </td>
                      <td style={{ ...td, fontFamily: 'var(--mono)', color: 'var(--t2)' }}>{s.current?.effective_from || '—'}</td>
                      <td style={td}><Badge color={s.is_active ? 'var(--ok, #22c55e)' : 'var(--t3)'}>{s.is_active ? 'Active' : 'Off'}</Badge></td>
                      <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button style={{ ...btnSecondary, padding: '3px 8px', fontSize: 10 }} onClick={() => setEditTarget(s)}>Edit timing</button>{' '}
                        <button style={{ ...btnSecondary, padding: '3px 8px', fontSize: 10 }} onClick={() => setHistTarget(s)}>History</button>{' '}
                        <button style={{ ...btnSecondary, padding: '3px 8px', fontSize: 10 }} onClick={() => toggleActive(s)}>{s.is_active ? 'Disable' : 'Enable'}</button>
                      </td>
                    </tr>
                  ))}
                  {!shifts.length && (
                    <tr><td colSpan={5} style={{ ...td, color: 'var(--t3)' }}>No store shifts yet — add one.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {editTarget && <EditTimingModal shift={editTarget} session={session} onClose={() => setEditTarget(null)} onSaved={() => { setEditTarget(null); load(); }} />}
      {histTarget && <ShiftHistoryModal shift={histTarget} session={session} onClose={() => setHistTarget(null)} />}
      {adding && <AddShiftModal session={session} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load(); }} />}
    </div>
  );
}

function ShiftField({ label, children }) {
  return (
    <div>
      <span style={labelStyle}>{label}</span>
      {children}
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

  const mInput = { ...inputStyle, width: '100%' };
  return (
    <Modal open onClose={onClose} title={`Store · ${shift.name} — edit timing`} confirmLabel="Save new version" onConfirm={save} loading={saving}>
      <div style={{ display: 'grid', gap: 12 }}>
        <ShiftField label="Effective from"><input type="date" value={f.effective_from} onChange={set('effective_from')} style={mInput} /></ShiftField>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <ShiftField label="Start"><input type="time" value={f.start_time} onChange={set('start_time')} style={mInput} /></ShiftField>
          <ShiftField label="End"><input type="time" value={f.end_time} onChange={set('end_time')} style={mInput} /></ShiftField>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--t2)' }}>
          <input type="checkbox" checked={f.ends_next_day} onChange={set('ends_next_day')} /> Ends next day (overnight shift)
        </label>
        <details>
          <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--t3)' }}>Advanced — windows · grace · min-dwell</summary>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
            <ShiftField label="Clock-in opens (min before start)"><input type="number" value={f.in_open_lead_min} onChange={set('in_open_lead_min')} style={mInput} /></ShiftField>
            <ShiftField label="Clock-out opens (min before end)"><input type="number" value={f.out_open_lead_min} onChange={set('out_open_lead_min')} style={mInput} /></ShiftField>
            <ShiftField label="OT grace (min past end)"><input type="number" value={f.grace_min} onChange={set('grace_min')} style={mInput} /></ShiftField>
            <ShiftField label="Min dwell before clock-out (min)"><input type="number" value={f.min_dwell_min} onChange={set('min_dwell_min')} style={mInput} /></ShiftField>
          </div>
        </details>
        <ShiftField label="Note (optional — why the change)"><input value={f.note} onChange={set('note')} style={mInput} placeholder="e.g. confirmed store time" /></ShiftField>
      </div>
    </Modal>
  );
}

function AddShiftModal({ session, onClose, onSaved }) {
  const { showToast } = useToast();
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  async function save() {
    if (!name.trim()) { showToast('Name required', 'error'); return; }
    setSaving(true);
    try {
      await workerFetch('createShift', { data: { department: STORE_DEPT, name: name.trim() } }, session);
      showToast('Shift added — set its timing next', 'success');
      onSaved();
    } catch (e) { showToast(e.message || 'Failed', 'error'); setSaving(false); }
  }
  return (
    <Modal open onClose={onClose} title="Add store shift" confirmLabel="Add shift" onConfirm={save} loading={saving}>
      <ShiftField label="Shift name">
        <input value={name} onChange={(e) => setName(e.target.value)} style={{ ...inputStyle, width: '100%' }} placeholder="e.g. General, Morning…" autoFocus />
      </ShiftField>
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
        : !rows.length ? <div style={{ color: 'var(--t3)', fontSize: 12 }}>No versions.</div> : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead><tr><th style={th}>Effective</th><th style={th}>Timing</th><th style={th}>Added · note</th></tr></thead>
          <tbody>
            {rows.map((v) => (
              <tr key={v.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <td style={{ ...td, fontFamily: 'var(--mono)' }}>{v.effective_from}</td>
                <td style={{ ...td, fontFamily: 'var(--mono)' }}>{fmtHM(v.start_time)}–{fmtHM(v.end_time)}{v.ends_next_day ? ' (+1d)' : ''}</td>
                <td style={td}>{v.created_at ? new Date(v.created_at).toLocaleDateString('en-IN') : '—'}{v.note ? ` · ${v.note}` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
