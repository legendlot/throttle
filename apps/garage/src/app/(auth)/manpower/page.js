'use client';
import { useEffect, useMemo, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { todayStr } from '@throttle/domain';

const MP_ACTIVITIES = [
  { key: 'inwarding',   label: 'Inwarding / Receiving / GRN', color: 'var(--green)'  },
  { key: 'issuance',    label: 'Issuance / Picking',          color: 'var(--yellow)' },
  { key: 'counting',    label: 'Counting / Audit',            color: 'var(--blue)'   },
  { key: 'bagging',     label: 'Bagging & Tagging',           color: 'var(--blue)'   },
  { key: 'rearranging', label: 'Rearranging / Organising',    color: 'var(--t2)'     },
  { key: 'cleanup',     label: 'Clean-up',                    color: 'var(--t3)'     },
  { key: 'qa',          label: 'QA / Inspection',             color: '#a78bfa'       },
  { key: 'dispatch',    label: 'Dispatch / Packing',          color: 'var(--t2)'     },
  { key: 'other',       label: 'Other',                       color: 'var(--t3)'     },
];

const SHIFT_COLORS = { Morning: 'var(--yellow)', Afternoon: 'var(--blue)', Night: 'var(--t3)' };

const panelStyle       = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const panelHeaderStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)', gap: 8, flexWrap: 'wrap' };
const panelBodyStyle   = { padding: '12px 14px' };
const inputStyle       = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px', fontSize: 12, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit' };
const selectStyle      = { ...inputStyle, cursor: 'pointer' };
const labelStyle       = { fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block' };
const btnPrimary       = { background: 'var(--yellow)', border: '1px solid var(--yellow)', borderRadius: 3, padding: '10px 16px', fontSize: 12, fontWeight: 700, color: '#000', cursor: 'pointer', fontFamily: 'var(--cond)', letterSpacing: '0.04em' };
const btnSecondary     = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 12px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)' };

function freshActivityRows() {
  return MP_ACTIVITIES.map((a, i) => ({ id: i + 1, preset: a.key, custom: '', count: '' }));
}

export default function ManpowerPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [date, setDate] = useState(todayStr());
  const [shift, setShift] = useState('Morning');
  const [notes, setNotes] = useState('');
  const [activityRows, setActivityRows] = useState(freshActivityRows());
  const [submitting, setSubmitting] = useState(false);
  const [days, setDays] = useState(7);
  const [logs, setLogs] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  const loadHistory = useCallback(async () => {
    if (!session) return;
    setHistoryLoading(true);
    try {
      const data = await garageFetch('getManpower', { days }, session);
      setLogs(Array.isArray(data) ? data : []);
    } catch (e) {
      showToast(e.message || 'Failed to load manpower history', 'error');
      setLogs([]);
    } finally {
      setHistoryLoading(false);
    }
  }, [session, days, showToast]);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  const totalHeadcount = useMemo(
    () => activityRows.reduce((s, r) => s + (parseInt(r.count) || 0), 0),
    [activityRows]
  );

  if (perms && !perms.dashboard) {
    return <div style={{ padding: 24, color: 'var(--t3)' }}>Access restricted</div>;
  }

  function updateRow(id, field, value) {
    setActivityRows((rows) => rows.map((r) => r.id === id ? { ...r, [field]: value } : r));
  }
  function addRow() {
    setActivityRows((rows) => [...rows, { id: Date.now(), preset: '', custom: '', count: '' }]);
  }
  function removeRow(id) {
    setActivityRows((rows) => rows.filter((r) => r.id !== id));
  }

  async function handleSubmit() {
    const finalActivities = [];
    activityRows.forEach((row) => {
      const count = parseInt(row.count) || 0;
      if (count === 0) return;
      const actKey = row.preset || '';
      const actLabel = actKey
        ? (MP_ACTIVITIES.find((a) => a.key === actKey)?.label || actKey)
        : (row.custom?.trim() || 'Other');
      finalActivities.push({
        person_name: String(count) + 'x',
        activity:    actLabel,
        station:     actKey || null,
      });
    });
    if (totalHeadcount === 0) {
      showToast('Enter at least one activity with headcount > 0', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const res = await workerFetch('postManpower', {
        data: {
          log_date:   date,
          shift,
          headcount:  totalHeadcount,
          notes:      notes || null,
          activities: finalActivities,
        },
      }, session);
      const result = res.data || res;
      showToast(`Manpower logged — ${result.headcount || totalHeadcount} staff on ${shift} shift`, 'success');
      setNotes('');
      setActivityRows(freshActivityRows());
      loadHistory();
    } catch (e) {
      showToast(e.message || 'Failed to log manpower', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  const maxCount = Math.max(...logs.map((l) => l.headcount || 0), 1);

  return (
    <div style={{ color: 'var(--t1)' }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontFamily: 'var(--cond)', fontSize: 28, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.03em', margin: 0 }}>
          Manpower
        </h1>
        <p style={{ color: 'var(--t3)', fontSize: 11, marginTop: 4, fontFamily: 'var(--mono)' }}>
          Daily headcount log — track who's on the floor and what they're doing.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
        {/* LOG FORM */}
        <div style={panelStyle}>
          <div style={panelHeaderStyle}>
            <span>Log Manpower</span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                style={{ ...inputStyle, fontFamily: 'var(--mono)' }}
                disabled={submitting}
              />
              <select
                value={shift}
                onChange={(e) => setShift(e.target.value)}
                style={selectStyle}
                disabled={submitting}
              >
                <option>Morning</option>
                <option>Afternoon</option>
                <option>Night</option>
              </select>
            </div>
          </div>
          <div style={panelBodyStyle}>
            <div style={{ marginBottom: 8, fontSize: 10, color: 'var(--t3)', fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Activity Breakdown</div>
            {activityRows.map((row) => {
              const isCustom = !row.preset;
              return (
                <div key={row.id} style={{ display: 'grid', gridTemplateColumns: '1fr 90px 28px', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: isCustom ? '1fr 1fr' : '1fr', gap: 6 }}>
                    <select
                      value={row.preset}
                      onChange={(e) => updateRow(row.id, 'preset', e.target.value)}
                      style={selectStyle}
                      disabled={submitting}
                    >
                      <option value="">Custom activity…</option>
                      {MP_ACTIVITIES.map((a) => (
                        <option key={a.key} value={a.key}>{a.label}</option>
                      ))}
                    </select>
                    {isCustom && (
                      <input
                        type="text"
                        placeholder="Activity name"
                        value={row.custom}
                        onChange={(e) => updateRow(row.id, 'custom', e.target.value)}
                        style={inputStyle}
                        disabled={submitting}
                      />
                    )}
                  </div>
                  <input
                    type="number"
                    min="0"
                    placeholder="0"
                    value={row.count}
                    onChange={(e) => updateRow(row.id, 'count', e.target.value)}
                    style={{ ...inputStyle, fontSize: 13, fontWeight: 700, textAlign: 'center', fontFamily: 'var(--mono)' }}
                    disabled={submitting}
                  />
                  <button
                    onClick={() => removeRow(row.id)}
                    disabled={submitting}
                    style={{ background: 'transparent', border: '1px solid var(--border)', color: '#ff7070', cursor: 'pointer', fontSize: 11, borderRadius: 3, padding: 0, height: 28 }}
                    title="Remove row"
                  >
                    ✕
                  </button>
                </div>
              );
            })}
            <button
              onClick={addRow}
              disabled={submitting}
              style={{ ...btnSecondary, marginTop: 4 }}
            >
              + Add Activity
            </button>

            <div style={{ marginTop: 14, padding: '10px 12px', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Total Headcount</span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 26, fontWeight: 700, color: 'var(--yellow)' }}>{totalHeadcount}</span>
            </div>

            <div style={{ marginTop: 12 }}>
              <span style={labelStyle}>Notes (optional)</span>
              <input
                type="text"
                placeholder="Optional notes…"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                style={{ ...inputStyle, width: '100%' }}
                disabled={submitting}
              />
            </div>

            <button
              onClick={handleSubmit}
              disabled={submitting}
              style={{ ...btnPrimary, width: '100%', marginTop: 14, opacity: submitting ? 0.6 : 1, cursor: submitting ? 'wait' : 'pointer' }}
            >
              {submitting ? 'SAVING…' : 'SAVE LOG'}
            </button>
          </div>
        </div>

        {/* HISTORY */}
        <div style={panelStyle}>
          <div style={panelHeaderStyle}>
            <span>History</span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <select
                value={days}
                onChange={(e) => setDays(parseInt(e.target.value, 10))}
                style={selectStyle}
                disabled={historyLoading}
              >
                <option value={7}>Last 7 days</option>
                <option value={14}>Last 14 days</option>
                <option value={30}>Last 30 days</option>
              </select>
              <button style={btnSecondary} onClick={loadHistory} disabled={historyLoading}>↻</button>
            </div>
          </div>
          <div style={panelBodyStyle}>
            {historyLoading ? (
              <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
            ) : logs.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>No manpower logs yet</div>
            ) : (
              logs.map((l) => {
                const pct = ((l.headcount || 0) / maxCount) * 100;
                const sc = SHIFT_COLORS[l.shift] || 'var(--t2)';
                const acts = Array.isArray(l.activities) ? l.activities : [];
                return (
                  <div key={l.id} style={{ borderBottom: '1px solid var(--border)', padding: '12px 0' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
                      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 13 }}>{l.log_date}</span>
                        <span style={{ fontSize: 11, color: sc, fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{l.shift}</span>
                        {l.notes && <span style={{ fontSize: 11, color: 'var(--t3)', fontStyle: 'italic' }}>{l.notes}</span>}
                      </div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <div style={{ width: 80, height: 6, background: 'var(--surface2)', borderRadius: 3, overflow: 'hidden' }}>
                          <div style={{ width: `${pct}%`, height: '100%', background: 'var(--yellow)' }} />
                        </div>
                        <span style={{ fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 700, color: 'var(--yellow)' }}>{l.headcount || 0}</span>
                        <span style={{ fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase' }}>staff</span>
                      </div>
                    </div>
                    {acts.length > 0 && (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 8 }}>
                        {acts.map((a) => {
                          const def = MP_ACTIVITIES.find((x) => x.key === a.station);
                          const color = def?.color || 'var(--t2)';
                          const count = parseInt(a.person_name) || 0;
                          return (
                            <div key={a.id || `${a.activity}-${a.station}-${a.person_name}`} style={{ background: 'var(--surface2)', borderLeft: `3px solid ${color}`, padding: '6px 10px', borderRadius: 2 }}>
                              <div style={{ fontSize: 11, color: 'var(--t2)' }}>{a.activity}</div>
                              <div style={{ fontFamily: 'var(--mono)', fontSize: 16, fontWeight: 700, color }}>{count}</div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
