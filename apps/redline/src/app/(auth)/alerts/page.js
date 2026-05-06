'use client';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { KpiCard, Spinner, EmptyState, useToast } from '@throttle/ui';
import { todayStr } from '@throttle/domain';

// ── Helpers ───────────────────────────────────────────────────
function fmt(n) { return n != null ? Number(n).toLocaleString('en-IN') : '0'; }

function formatTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
}

function formatDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const date = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' }).replace(/ /g, '-');
  const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
  return `${date} ${time}`;
}

const STATION_COLORS = {
  INW:     '#60a5fa',
  QC_PASS: 'var(--green)',
  QC_FAIL: 'var(--red)',
  WKS:     '#a78bfa',
  PKG:     '#8b5cf6',
};

// ── Alerts Page ───────────────────────────────────────────────
export default function AlertsPage() {
  const { session, role, user } = useAuth();
  const { showToast } = useToast();

  const [dateFrom,      setDateFrom]      = useState(() => todayStr());
  const [dateTo,        setDateTo]        = useState(() => todayStr());
  const [violations,    setViolations]    = useState([]);
  const [summary,       setSummary]       = useState(null);
  const [loading,       setLoading]       = useState(false);
  const [error,         setError]         = useState(null);
  const [statusFilter,  setStatusFilter]  = useState('');
  const [lineFilter,    setLineFilter]    = useState('');
  const [stationFilter, setStationFilter] = useState('');

  // Ack modal state
  const [ackModal,   setAckModal]   = useState(null);
  const [ackNote,    setAckNote]    = useState('');
  const [ackError,   setAckError]   = useState('');
  const [ackLoading, setAckLoading] = useState(false);

  const isMahesh = (role || '').toLowerCase().includes('mahesh')
                || (user?.full_name || '').toLowerCase().includes('mahesh');

  // ── Load alerts ───────────────────────────────────────────
  const loadAlerts = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setError(null);
    try {
      const params = { from: dateFrom, to: dateTo };
      if (lineFilter)    params.line    = lineFilter;
      if (stationFilter) params.station = stationFilter;

      const [violationsRes, summaryRes] = await Promise.allSettled([
        garageFetch('getViolations',       params, session),
        garageFetch('getViolationSummary', { from: dateFrom, to: dateTo }, session),
      ]);

      if (violationsRes.status === 'fulfilled') {
        setViolations(Array.isArray(violationsRes.value) ? violationsRes.value : []);
      } else {
        setViolations([]);
        setError(violationsRes.reason?.message || 'Failed to load violations');
      }

      if (summaryRes.status === 'fulfilled') {
        setSummary(summaryRes.value || null);
      } else {
        setSummary(null);
      }
    } catch (e) {
      setError(e.message || 'Failed to load alerts');
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, lineFilter, stationFilter, session]);

  useEffect(() => { loadAlerts(); }, [loadAlerts]);

  // ── Filtered rows (status filter is client-side) ──────────
  const displayRows = useMemo(() => {
    return violations.filter(v =>
      statusFilter === 'unacked' ? !v.acknowledged_at
      : statusFilter === 'acked' ? !!v.acknowledged_at
      : true
    );
  }, [violations, statusFilter]);

  // ── Open ack modal ────────────────────────────────────────
  function openAck(v) {
    setAckModal(v);
    setAckNote('');
    setAckError('');
  }

  // ── Submit ack (graceful fallback — action missing) ───────
  async function submitAck() {
    if (!ackModal) return;
    setAckLoading(true);
    setAckError('');
    try {
      const res = await workerFetch('acknowledgeViolation', {
        violation_id: ackModal.id,
        note: ackNote.trim() || undefined,
      }, session);
      const result = res?.data || res;
      if (result?.ok === false) throw new Error(result?.error || 'Failed to acknowledge');
      setAckModal(null);
      showToast('Violation acknowledged', 'success');
      loadAlerts();
    } catch (e) {
      setAckError(e.message || 'Acknowledge not yet available');
    } finally {
      setAckLoading(false);
    }
  }

  // ── Style constants ───────────────────────────────────────
  const btnStyle = { padding: '4px 10px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--t2)', fontSize: 11, cursor: 'pointer', fontFamily: 'var(--mono)', letterSpacing: '0.04em' };
  const btnActiveStyle = { ...btnStyle, background: 'rgba(242,205,26,.12)', color: 'var(--yellow)', border: '1px solid rgba(242,205,26,.3)' };
  const dateInputStyle = { background: 'var(--surface2)', color: 'var(--t1)', border: '1px solid var(--border)', padding: '3px 6px', borderRadius: 3, fontFamily: 'var(--mono)', fontSize: 12 };
  const dateLabelStyle = { fontSize: 11, color: 'var(--t3)', letterSpacing: '0.08em', textTransform: 'uppercase' };
  const selectStyle = { background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--t1)', fontSize: 11, fontFamily: 'var(--mono)', padding: '3px 6px', borderRadius: 3 };
  const thStyle = { padding: '8px 12px', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', fontWeight: 600, textAlign: 'left' };
  const tdStyle = { padding: '8px 12px', fontSize: 12, borderBottom: '1px solid rgba(42,42,42,.6)', whiteSpace: 'nowrap' };

  // ── KPI colors ───────────────────────────────────────────
  const totalToday = summary?.total_today || 0;
  const unacked    = summary?.unacknowledged || 0;

  return (
    <>
      {/* Ack modal */}
      {ackModal && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={(e) => { if (e.target === e.currentTarget) setAckModal(null); }}
        >
          <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: '28px 32px', width: 460, maxWidth: '90vw' }}>
            <div style={{ fontFamily: 'var(--cond)', fontSize: 14, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--green)', marginBottom: 16 }}>
              Acknowledge Violation
            </div>
            <div style={{ background: 'var(--surface3)', border: '1px solid var(--border)', borderRadius: 4, padding: 12, marginBottom: 16, fontSize: 12, fontFamily: 'var(--mono)' }}>
              <div style={{ color: 'var(--t3)', fontSize: 10, marginBottom: 4 }}>VIOLATION</div>
              <div style={{ color: 'var(--yellow)' }}>{ackModal.upc || '—'}</div>
              <div style={{ color: 'var(--t2)', marginTop: 4 }}>
                {ackModal.line} · {ackModal.station} · {formatTime(ackModal.timestamp)}
              </div>
              <div style={{ color: 'var(--red)', marginTop: 6, fontSize: 11 }}>{ackModal.error_message || '—'}</div>
            </div>
            <label style={{ fontSize: 10, color: 'var(--t3)', letterSpacing: '0.08em', textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>
              Note (optional)
            </label>
            <textarea
              value={ackNote}
              onChange={e => setAckNote(e.target.value)}
              rows={3}
              placeholder="Optional note about resolution"
              style={{ width: '100%', background: 'var(--surface)', color: 'var(--t1)', border: '1px solid var(--border)', borderRadius: 3, padding: 8, fontSize: 12, fontFamily: 'var(--mono)', resize: 'vertical' }}
            />
            {ackError && (
              <div style={{ color: 'var(--red)', fontSize: 11, marginTop: 8, fontFamily: 'var(--mono)' }}>{ackError}</div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
              <button onClick={() => setAckModal(null)} style={btnStyle} disabled={ackLoading}>Cancel</button>
              <button
                onClick={submitAck}
                disabled={ackLoading}
                style={{ ...btnStyle, background: 'var(--green)', color: '#000', border: '1px solid var(--green)', opacity: ackLoading ? 0.5 : 1 }}
              >
                {ackLoading ? 'Acknowledging…' : 'Confirm ACK'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Page content */}
      <div>
        {/* Date bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
          <span style={dateLabelStyle}>From</span>
          <input type="date" style={dateInputStyle} value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
          <span style={dateLabelStyle}>To</span>
          <input type="date" style={dateInputStyle} value={dateTo}   onChange={e => setDateTo(e.target.value)} />
          <button style={btnStyle} onClick={() => { const t = todayStr(); setDateFrom(t); setDateTo(t); }}>Today</button>
        </div>

        {error && (
          <div style={{ background: 'rgba(222,42,42,.1)', border: '1px solid rgba(222,42,42,.25)', borderRadius: 4, padding: '10px 14px', fontSize: 12, color: 'var(--red)', marginBottom: 14 }}>
            {error}
          </div>
        )}

        {/* KPI cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 18 }}>
          <KpiCard label="Total Today"    value={fmt(totalToday)}                color={totalToday > 0 ? 'yellow' : undefined} />
          <KpiCard label="Unacknowledged" value={fmt(unacked)}                   color={unacked > 0 ? 'red' : 'green'} />
          <KpiCard label="Worst Line"     value={summary?.worst_line    || '—'} />
          <KpiCard label="Worst Station"  value={summary?.worst_station || '—'} />
        </div>

        {/* Filter row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
          <button style={statusFilter === ''         ? btnActiveStyle : btnStyle} onClick={() => setStatusFilter('')}>All</button>
          <button style={statusFilter === 'unacked'  ? btnActiveStyle : btnStyle} onClick={() => setStatusFilter('unacked')}>Unacknowledged</button>
          <button style={statusFilter === 'acked'    ? btnActiveStyle : btnStyle} onClick={() => setStatusFilter('acked')}>Acknowledged</button>
          <div style={{ width: 12 }} />
          <select style={selectStyle} value={lineFilter} onChange={e => setLineFilter(e.target.value)}>
            <option value="">All Lines</option>
            <option value="L1">L1</option>
            <option value="L2">L2</option>
            <option value="L3">L3</option>
          </select>
          <select style={selectStyle} value={stationFilter} onChange={e => setStationFilter(e.target.value)}>
            <option value="">All Stations</option>
            <option value="INW">INW</option>
            <option value="QC_PASS">QC Pass</option>
            <option value="QC_FAIL">QC Fail</option>
            <option value="WKS">WKS</option>
            <option value="PKG">PKG</option>
          </select>
        </div>

        {/* Table */}
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden' }}>
          {loading ? (
            <div style={{ padding: '40px 0', display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : displayRows.length === 0 ? (
            <EmptyState icon="🚨" message="No alerts in this range" />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {['Time','Line','Station','Operator','UPC','Violation','Status',''].map(h => (
                      <th key={h} style={thStyle}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {displayRows.map(v => {
                    const acked = !!v.acknowledged_at;
                    const stColor = STATION_COLORS[v.station] || 'var(--t2)';
                    return (
                      <tr key={v.id} style={{ opacity: acked ? 0.45 : 1 }}>
                        <td style={{ ...tdStyle, fontFamily: 'var(--mono)', color: 'var(--t2)' }}>
                          <div>{formatDateTime(v.timestamp)}</div>
                          {acked && (
                            <div style={{ fontSize: 9, color: 'var(--t3)', marginTop: 2 }}>
                              ack {formatTime(v.acknowledged_at)}
                            </div>
                          )}
                        </td>
                        <td style={{ ...tdStyle, color: 'var(--t1)' }}>{v.line || '—'}</td>
                        <td style={{ ...tdStyle, color: stColor, fontWeight: 600 }}>{v.station || '—'}</td>
                        <td style={{ ...tdStyle, color: 'var(--t2)' }}>{v.operator_name || '—'}</td>
                        <td style={{ ...tdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{v.upc || '—'}</td>
                        <td style={{ ...tdStyle, color: 'var(--red)', whiteSpace: 'normal' }}>{v.error_message || '—'}</td>
                        <td style={{ ...tdStyle, fontFamily: 'var(--mono)' }}>
                          {acked
                            ? <span style={{ color: 'var(--green)', fontSize: 10, fontWeight: 700 }}>✓ ACK</span>
                            : <span style={{ color: 'var(--red)', fontSize: 10, fontWeight: 700 }}>● OPEN</span>}
                        </td>
                        <td style={tdStyle}>
                          {!acked && !isMahesh && (
                            <button
                              onClick={() => openAck(v)}
                              style={{ padding: '3px 9px', background: 'transparent', border: '1px solid var(--green)', borderRadius: 2, color: 'var(--green)', fontSize: 10, fontWeight: 700, fontFamily: 'var(--mono)', letterSpacing: '0.05em', cursor: 'pointer' }}
                            >
                              ACK
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
    </>
  );
}
