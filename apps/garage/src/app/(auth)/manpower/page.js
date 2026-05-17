'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { workerFetch } from '@throttle/db';
import { Badge, EmptyState, Modal, Spinner, useToast } from '@throttle/ui';

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
// Garage /manpower — currently a single Store Activities tab. Operators,
// Attendance, Daily Roster, Performance all live on Redline now.
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
          Store-side activity log. Operators, attendance, roster, and performance moved to Redline.
        </p>
      </div>

      <TabBar
        tabs={[{ key: 'store', label: 'Store Activities' }]}
        active={activeTab}
        onChange={setActiveTab}
      />

      {activeTab === 'store' && <StoreActivitiesTab session={session} canManageFloor={canManageFloor} />}
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
