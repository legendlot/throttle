'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { workerFetch } from '@throttle/db';
import { Badge, EmptyState, Modal, Spinner, useToast } from '@throttle/ui';

// ── Constants ───────────────────────────────────────────────────────────────
const DISPATCH_ACTIVITIES = [
  'Order Packing / Dispatch',
  'Returns Processing',
  'Admin / Other',
];

const LINE_COLORS = { D1: '#ec4899', D2: '#06b6d4' };

// ── Shared styles ───────────────────────────────────────────────────────────
const panelStyle       = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const panelBodyStyle   = { padding: '12px 14px' };
const inputStyle       = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px', fontSize: 12, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit' };
const selectStyle      = { ...inputStyle, cursor: 'pointer' };
const labelStyle       = { fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block' };
const btnSecondary     = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 12px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)' };

// ── Display helpers ─────────────────────────────────────────────────────────
function capitalize(s) { return (s || '').charAt(0).toUpperCase() + (s || '').slice(1); }
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
// Garage /dispatch — dispatch team activity log. Mirrors Store Activities at
// /manpower, but reads operators assigned to line='D1' or 'D2' for the date
// and writes to store.dispatch_activity_log.
// ═══════════════════════════════════════════════════════════════════════════
export default function DispatchPage() {
  const { session, perms } = useAuth();
  const canManageFloor = !!(perms?.users_manage || perms?.production_view || perms?.procurement_approve);

  if (perms && !perms.dashboard) {
    return <div style={{ padding: 24, color: 'var(--t3)' }}>Access restricted</div>;
  }

  return (
    <div style={{ color: 'var(--t1)' }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontFamily: 'var(--cond)', fontSize: 28, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.03em', margin: 0 }}>
          Dispatch
        </h1>
        <p style={{ color: 'var(--t3)', fontSize: 11, marginTop: 4, fontFamily: 'var(--mono)' }}>
          Daily activity log for dispatch team (lines D1, D2). Assign operators on Redline → Manpower → Daily Roster.
        </p>
      </div>

      <DispatchActivitiesTab session={session} canManageFloor={canManageFloor} />
    </div>
  );
}

function DispatchActivitiesTab({ session, canManageFloor }) {
  const { showToast } = useToast();
  const [date, setDate] = useState(istToday());
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [savingOp, setSavingOp] = useState({});
  const [notesDraft, setNotesDraft] = useState({});
  const [hoursDraft, setHoursDraft] = useState({});
  const [historyTarget, setHistoryTarget] = useState(null);

  const load = useCallback(async () => {
    if (!session || !canManageFloor || !date) return;
    setLoading(true);
    try {
      const res = await workerFetch('getDispatchRoster', { data: { date } }, session);
      const list = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
      setRows(list);
      setNotesDraft((prev) => {
        const next = { ...prev };
        for (const op of list) {
          if (next[op.id] === undefined) next[op.id] = op.current_notes || '';
        }
        return next;
      });
      setHoursDraft((prev) => {
        const next = { ...prev };
        for (const op of list) {
          if (next[op.id] === undefined) next[op.id] = op.current_hours != null ? String(op.current_hours) : '';
        }
        return next;
      });
    } catch (e) {
      showToast(e.message || 'Failed to load dispatch roster', 'error');
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
      await workerFetch('assignDispatchActivity', {
        data: {
          operator_id: op.id,
          shift_date:  date,
          activity:    nextActivity,
          hours_spent: hoursDraft[op.id] || null,
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

  async function saveRowEdits(op) {
    if (!canManageFloor || !op.current_activity) {
      showToast('Set an activity before saving notes/hours', 'error');
      return;
    }
    const nextNotes = (notesDraft[op.id] || '').trim();
    const nextHours = (hoursDraft[op.id] || '').trim();
    const notesChanged = nextNotes !== (op.current_notes || '');
    const hoursChanged = nextHours !== (op.current_hours != null ? String(op.current_hours) : '');
    if (!notesChanged && !hoursChanged) return;
    setSavingOp((s) => ({ ...s, [op.id]: true }));
    try {
      await workerFetch('assignDispatchActivity', {
        data: {
          operator_id: op.id,
          shift_date:  date,
          activity:    op.current_activity,
          hours_spent: nextHours || null,
          notes:       nextNotes || null,
        },
      }, session);
      showToast(`Updated ${op.name}`, 'success');
      await load();
    } catch (e) {
      showToast(e.message || 'Failed to save', 'error');
    } finally {
      setSavingOp((s) => { const next = { ...s }; delete next[op.id]; return next; });
    }
  }

  const totalActive = useMemo(
    () => rows.filter((r) => !!r.current_activity).length,
    [rows]
  );
  const byLine = useMemo(() => {
    const map = { D1: 0, D2: 0 };
    for (const r of rows) if (r.line === 'D1' || r.line === 'D2') map[r.line] += 1;
    return map;
  }, [rows]);

  if (!canManageFloor) {
    return (
      <div style={{ ...panelStyle, padding: '40px 24px', textAlign: 'center' }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)' }}>
          Dispatch Activities are restricted to floor supervisors.
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
                setNotesDraft({});
                setHoursDraft({});
              }}
              style={{ ...inputStyle, fontFamily: 'var(--mono)' }}
            />
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 12, alignItems: 'center' }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: LINE_COLORS.D1, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              D1 · {byLine.D1}
            </span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: LINE_COLORS.D2, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              D2 · {byLine.D2}
            </span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              {rows.length} operator{rows.length === 1 ? '' : 's'}
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
              message={`No operators on D1 or D2 for ${date}. Assign operators in Redline → Manpower → Daily Roster (D1 or D2 bucket).`}
            />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    <th style={th}>Operator</th>
                    <th style={th}>Line</th>
                    <th style={th}>Type</th>
                    <th style={th}>Current Activity</th>
                    <th style={{ ...th, width: 80 }}>Hours</th>
                    <th style={{ ...th, width: 110 }}>Since</th>
                    <th style={th}>Assigned By</th>
                    <th style={{ ...th, width: 220 }}>Notes</th>
                    <th style={{ ...th, width: 60 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((op) => {
                    const saving = !!savingOp[op.id];
                    const dirty =
                      (notesDraft[op.id] ?? '') !== (op.current_notes || '') ||
                      (hoursDraft[op.id] ?? '') !== (op.current_hours != null ? String(op.current_hours) : '');
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
                          {op.line ? (
                            <span style={{
                              fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
                              color: LINE_COLORS[op.line] || 'var(--t2)',
                              textTransform: 'uppercase', letterSpacing: '0.06em',
                            }}>{op.line}</span>
                          ) : '—'}
                        </td>
                        <td style={td}>
                          <Badge color="var(--t3)">{capitalize(op.employment_type || '—')}</Badge>
                        </td>
                        <td style={td}>
                          <select
                            value={op.current_activity || ''}
                            disabled={saving}
                            onChange={(e) => changeActivity(op, e.target.value)}
                            style={{ ...selectStyle, width: '100%', maxWidth: 240 }}
                          >
                            <option value="">— No activity assigned</option>
                            {DISPATCH_ACTIVITIES.map((a) => (
                              <option key={a} value={a}>{a}</option>
                            ))}
                          </select>
                        </td>
                        <td style={td}>
                          <input
                            type="number"
                            min="0"
                            max="24"
                            step="0.25"
                            placeholder="—"
                            value={hoursDraft[op.id] ?? ''}
                            disabled={saving}
                            onChange={(e) => setHoursDraft((s) => ({ ...s, [op.id]: e.target.value }))}
                            onKeyDown={(e) => { if (e.key === 'Enter') saveRowEdits(op); }}
                            style={{ ...inputStyle, width: 60, fontFamily: 'var(--mono)', textAlign: 'right' }}
                          />
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
                              onKeyDown={(e) => { if (e.key === 'Enter') saveRowEdits(op); }}
                              style={{ ...inputStyle, flex: 1, minWidth: 0 }}
                            />
                            {dirty && (
                              <button
                                onClick={() => saveRowEdits(op)}
                                disabled={saving || !op.current_activity}
                                title={op.current_activity ? 'Save changes (logs a new entry with the current activity)' : 'Set an activity before saving'}
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
          'getDispatchActivityHistory',
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
                {row.hours_spent != null && (
                  <div style={{ marginTop: 2, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t2)' }}>
                    {row.hours_spent} h
                  </div>
                )}
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
