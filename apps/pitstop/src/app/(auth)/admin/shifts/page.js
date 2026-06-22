'use client';
/* ════════════════════════════════════════════════════════════
   Shifts & Presence (Phase 1) — oversight surface.
   - "On duty now": live roster from getPresence (effective status,
     in-shift, routing eligibility). Visible to leads + admins.
   - "Shift windows": per-department start/end + working days.
     Editable by cs_ticket_admin; read-only for leads.
   ════════════════════════════════════════════════════════════ */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { EmptyState, Spinner } from '@throttle/ui';
import { Circle, Clock, Save, Users } from 'lucide-react';
import { csopsGet, csopsPost } from '../../../../lib/csopsFetch.js';

const DOT = { online: '#27c93f', away: '#f5a623', offline: '#6b6b6b' };
const DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [7, 'Sun']];
const ROLE_LABEL = { cs_agent: 'Agent', cs_lead: 'Team Lead', admin: 'CS Admin', super_admin: 'Super Admin' };

const minToHHMM = (m) => `${String(Math.floor((m || 0) / 60)).padStart(2, '0')}:${String((m || 0) % 60).padStart(2, '0')}`;
const hhmmToMin = (s) => { const [h, m] = String(s || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };

function agoLabel(ts) {
  if (!ts) return '—';
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(ts)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function ShiftsPage() {
  const { perms, session } = useAuth();
  const canEdit = !!perms?.cs_ticket_admin;
  const canView = !!(perms?.cs_ticket_reassign || perms?.cs_ticket_admin);

  const [roster, setRoster] = useState([]);
  const [istNowMin, setIstNowMin] = useState(null);
  const [shifts, setShifts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [savingId, setSavingId] = useState(null);

  const loadRoster = useCallback(async () => {
    try {
      const r = await csopsGet('getPresence', {}, session);
      setRoster(r?.roster || []);
      setIstNowMin(typeof r?.ist_now_min === 'number' ? r.ist_now_min : null);
    } catch (e) { setError(e.message); }
  }, [session]);

  const loadShifts = useCallback(async () => {
    try {
      const r = await csopsGet('getShifts', {}, session);
      setShifts(r?.shifts || []);
    } catch (e) { setError(e.message); }
  }, [session]);

  useEffect(() => {
    if (!session) return undefined;
    let alive = true;
    (async () => { await Promise.all([loadRoster(), loadShifts()]); if (alive) setLoading(false); })();
    const iv = setInterval(() => { if (document.visibilityState === 'visible') loadRoster(); }, 30000);
    return () => { alive = false; clearInterval(iv); };
  }, [session, loadRoster, loadShifts]);

  const onDuty = useMemo(() => roster.filter(a => a.eligible).length, [roster]);
  const sortedRoster = useMemo(
    () => [...roster].sort((a, b) =>
      (b.eligible - a.eligible) || (b.in_shift - a.in_shift) || a.full_name.localeCompare(b.full_name)),
    [roster],
  );

  async function saveShift(s) {
    setSavingId(s.cs_department_id);
    try {
      await csopsPost('setShift', {
        cs_department_id: s.cs_department_id,
        start_min: s.start_min,
        end_min: s.end_min,
        working_days: s.working_days,
        is_active: s.is_active,
      }, session);
      await loadShifts();
      await loadRoster();
    } catch (e) { setError(e.message); }
    finally { setSavingId(null); }
  }

  function patchShift(id, patch) {
    setShifts(prev => prev.map(s => s.cs_department_id === id ? { ...s, ...patch } : s));
  }
  function toggleDay(id, day) {
    setShifts(prev => prev.map(s => {
      if (s.cs_department_id !== id) return s;
      const set = new Set(s.working_days || []);
      set.has(day) ? set.delete(day) : set.add(day);
      return { ...s, working_days: [...set].sort((a, b) => a - b) };
    }));
  }

  if (!canView) return <EmptyState icon="🔒" message="Team-lead or admin permission required." />;
  if (loading) return <Spinner />;

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Shifts &amp; Presence</h1>
        <p style={{ margin: '4px 0 0', color: 'var(--t3)', fontSize: 13 }}>
          An agent is eligible for thread auto-assignment when they’re <b>online</b> (a live tab)
          <b> and</b> inside their department’s shift window — or have manually set “Available”.
          {istNowMin != null && <> Now: <b>{minToHHMM(istNowMin)} IST</b>.</>}
        </p>
      </header>

      {error && (
        <div style={{ padding: '8px 12px', background: 'rgba(220,50,50,0.1)', border: '1px solid rgba(220,50,50,0.3)',
          borderRadius: 6, color: '#b91c1c', fontSize: 13, marginBottom: 16 }}>{error}</div>
      )}

      {/* On duty now */}
      <section style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 8, marginBottom: 22, overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-1)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Users size={15} style={{ color: 'var(--t3)' }} />
          <span style={{ fontWeight: 600, fontSize: 14 }}>On duty now</span>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--t3)' }}>
            <b style={{ color: 'var(--accent)' }}>{onDuty}</b> eligible · {roster.length} CS agents
          </span>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead style={{ background: 'var(--surface-2)' }}>
            <tr>
              <Th>Agent</Th><Th>Role</Th><Th>Status</Th><Th>In shift</Th><Th>Eligible</Th><Th>Last seen</Th>
            </tr>
          </thead>
          <tbody>
            {sortedRoster.length === 0 ? (
              <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', color: 'var(--t3)' }}>No CS agents found.</td></tr>
            ) : sortedRoster.map(a => (
              <tr key={a.user_id} style={{ borderTop: '1px solid var(--border-1)' }}>
                <Td><b>{a.full_name}</b></Td>
                <Td style={{ color: 'var(--t3)' }}>{ROLE_LABEL[a.role] || a.role}</Td>
                <Td>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <Circle size={8} fill={DOT[a.status] || DOT.offline} stroke="none" />
                    <span style={{ textTransform: 'capitalize' }}>{a.status}</span>
                    {a.auto === false && <span style={{ fontSize: 10, color: 'var(--t4)' }}>(manual)</span>}
                  </span>
                </Td>
                <Td>{a.in_shift ? 'Yes' : <span style={{ color: 'var(--t4)' }}>No</span>}</Td>
                <Td>
                  <span style={{ fontWeight: 600, color: a.eligible ? '#16a34a' : 'var(--t4)' }}>
                    {a.eligible ? 'Eligible' : '—'}
                  </span>
                </Td>
                <Td style={{ color: 'var(--t3)' }}>{agoLabel(a.last_seen_at)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Shift windows */}
      <section style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 8, overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-1)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Clock size={15} style={{ color: 'var(--t3)' }} />
          <span style={{ fontWeight: 600, fontSize: 14 }}>Shift windows (IST)</span>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--t3)' }}>
            {canEdit ? 'Per department — edit and save' : 'Read-only (admin to edit)'}
          </span>
        </div>
        <div style={{ padding: 12, display: 'grid', gap: 10 }}>
          {shifts.map(s => (
            <div key={s.cs_department_id} style={{
              display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12,
              padding: '12px 14px', background: 'var(--surface-2)', border: '1px solid var(--border-1)', borderRadius: 6,
            }}>
              <div style={{ minWidth: 160, fontWeight: 600 }}>{s.name || s.slug}</div>
              <label style={{ fontSize: 12, color: 'var(--t3)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                From
                <input type="time" value={minToHHMM(s.start_min)} disabled={!canEdit}
                  onChange={e => patchShift(s.cs_department_id, { start_min: hhmmToMin(e.target.value) })}
                  style={timeInput} />
              </label>
              <label style={{ fontSize: 12, color: 'var(--t3)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                To
                <input type="time" value={minToHHMM(s.end_min)} disabled={!canEdit}
                  onChange={e => patchShift(s.cs_department_id, { end_min: hhmmToMin(e.target.value) })}
                  style={timeInput} />
              </label>
              <div style={{ display: 'inline-flex', gap: 4 }}>
                {DAYS.map(([d, lbl]) => {
                  const on = (s.working_days || []).includes(d);
                  return (
                    <button key={d} type="button" disabled={!canEdit}
                      onClick={() => canEdit && toggleDay(s.cs_department_id, d)}
                      title={lbl}
                      style={{
                        width: 30, height: 26, borderRadius: 5, fontSize: 11, fontWeight: 600,
                        cursor: canEdit ? 'pointer' : 'default',
                        background: on ? 'var(--accent)' : 'transparent',
                        color: on ? '#1b1b1e' : 'var(--t3)',
                        border: `1px solid ${on ? 'var(--accent)' : 'var(--border-1)'}`,
                      }}>{lbl[0]}</button>
                  );
                })}
              </div>
              <label style={{ fontSize: 12, color: 'var(--t3)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={!!s.is_active} disabled={!canEdit}
                  onChange={e => patchShift(s.cs_department_id, { is_active: e.target.checked })} />
                Active
              </label>
              {canEdit && (
                <button onClick={() => saveShift(s)} disabled={savingId === s.cs_department_id}
                  style={{
                    marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border-1)',
                    background: 'var(--accent)', color: '#1b1b1e', fontWeight: 600, fontSize: 12, cursor: 'pointer',
                    opacity: savingId === s.cs_department_id ? 0.6 : 1,
                  }}>
                  <Save size={13} /> {savingId === s.cs_department_id ? 'Saving…' : 'Save'}
                </button>
              )}
            </div>
          ))}
          {shifts.length === 0 && <div style={{ padding: 16, color: 'var(--t3)' }}>No shift windows configured.</div>}
        </div>
      </section>
    </div>
  );
}

const timeInput = {
  background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 5,
  color: 'var(--t1)', fontSize: 12, padding: '4px 6px',
};
function Th({ children }) {
  return <th style={{ textAlign: 'left', padding: '9px 14px', fontSize: 11, fontWeight: 600,
    color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{children}</th>;
}
function Td({ children, style }) {
  return <td style={{ padding: '9px 14px', ...style }}>{children}</td>;
}
