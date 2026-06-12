'use client';
/* ════════════════════════════════════════════════════════════
   ALERTS — Inbox stream (Pit Wall v2). Scan-time QC violations
   with acknowledge flow. Restyled from the inbox prototype
   (redesign-reference/app/inbox.jsx · AlertsView); all data
   actions unchanged: getViolations / getViolationSummary reads,
   acknowledgeViolation mutation, Mahesh ack-restriction rule.
   ════════════════════════════════════════════════════════════ */
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast, useEscapeClose } from '@throttle/ui';
import { todayStr } from '@throttle/domain';
import { useRefreshState } from '../layout.js';
import {
  Icon, KpiTile, Panel, FilterChip, ToneBadge, InboxTabs,
  lineColor, lineRgb, fmt, btnGhost, inputStyle,
} from '../../../components/kit/index.js';

// ── Helpers ───────────────────────────────────────────────────
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
  INW:     'var(--blue-bright)',
  QC_PASS: 'var(--ok-fg)',
  QC_FAIL: 'var(--bad-fg)',
  WKS:     '#a78bfa',
  PKG:     '#8b5cf6',
};

function LineChip({ id }) {
  if (!id) return <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--t4)' }}>—</span>;
  return (
    <span className="num" style={{ fontSize: 10, fontWeight: 700, color: lineColor(id),
      background: `rgba(${lineRgb(id)},0.12)`, borderRadius: 3, padding: '1px 5px' }}>{id}</span>
  );
}

// ── shared table cell styles (Pit Wall v2) ────────────────────
const thStyle = { padding: '0 14px 9px', textAlign: 'left', whiteSpace: 'nowrap' };
const tdBase = { padding: '10px 14px', borderTop: '1px solid var(--border)', whiteSpace: 'nowrap', verticalAlign: 'middle' };

// ── Alerts Page ───────────────────────────────────────────────
export default function AlertsPage() {
  const { session, role, user } = useAuth();
  const { showToast } = useToast();
  const { setRefreshing, setLastRefreshed } = useRefreshState();

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

  useEscapeClose(!!ackModal, () => setAckModal(null));

  const isMahesh = (role || '').toLowerCase().includes('mahesh')
                || (user?.full_name || '').toLowerCase().includes('mahesh');

  // ── Load alerts ───────────────────────────────────────────
  const loadAlerts = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setRefreshing(true);
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
      setLastRefreshed(new Date());
    } catch (e) {
      setError(e.message || 'Failed to load alerts');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [dateFrom, dateTo, lineFilter, stationFilter, session, setRefreshing, setLastRefreshed]);

  useEffect(() => { loadAlerts(); }, [loadAlerts]);

  // ── Filtered rows (status filter is client-side) ──────────
  const displayRows = useMemo(() => {
    return violations.filter(v =>
      statusFilter === 'unacked' ? !v.acknowledged_at
      : statusFilter === 'acked' ? !!v.acknowledged_at
      : true
    );
  }, [violations, statusFilter]);

  const unackedInView = useMemo(() => violations.filter(v => !v.acknowledged_at).length, [violations]);

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
  const dateInput = { ...inputStyle, width: 'auto', padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 12.5, colorScheme: 'dark' };
  const selectStyle = { ...inputStyle, width: 'auto', padding: '6px 10px', fontSize: 12.5, cursor: 'pointer' };

  const totalToday = summary?.total_today || 0;
  const unacked    = summary?.unacknowledged || 0;

  return (
    <>
      {/* Ack modal */}
      {ackModal && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={(e) => { if (e.target === e.currentTarget) setAckModal(null); }}
        >
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-md)',
            boxShadow: 'var(--shadow-pop)', padding: '24px 28px', width: 460, maxWidth: '90vw' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
              <span style={{ color: 'var(--ok-fg)', display: 'flex' }}><Icon name="shield" size={16} /></span>
              <span className="label" style={{ fontSize: 13, color: 'var(--t1)' }}>Acknowledge Violation</span>
            </div>
            <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-sm)', padding: 12, marginBottom: 16 }}>
              <div className="eyebrow" style={{ marginBottom: 5 }}>Violation</div>
              <div className="num" style={{ fontSize: 13, color: 'var(--yellow)' }}>{ackModal.upc || '—'}</div>
              <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t2)', marginTop: 4 }}>
                {ackModal.line} · {ackModal.station} · <span className="num">{formatTime(ackModal.timestamp)}</span>
              </div>
              <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--bad-fg)', marginTop: 6 }}>{ackModal.error_message || '—'}</div>
            </div>
            <label className="eyebrow" style={{ display: 'block', marginBottom: 6 }}>
              Note (optional)
            </label>
            <textarea
              value={ackNote}
              onChange={e => setAckNote(e.target.value)}
              rows={3}
              placeholder="Optional note about resolution"
              style={{ ...inputStyle, fontSize: 13, resize: 'vertical' }}
            />
            {ackError && (
              <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--bad-fg)', marginTop: 8 }}>{ackError}</div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
              <button onClick={() => setAckModal(null)} disabled={ackLoading} style={{ ...btnGhost, opacity: ackLoading ? 0.6 : 1 }}>
                Cancel
              </button>
              <button
                onClick={submitAck}
                disabled={ackLoading}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: 'var(--green)', color: '#0a0a0a',
                  border: 'none', borderRadius: 'var(--r-sm)', padding: '8px 14px', fontFamily: 'var(--font-display)',
                  fontWeight: 700, fontSize: 12, letterSpacing: '0.05em', textTransform: 'uppercase', cursor: 'pointer',
                  opacity: ackLoading ? 0.5 : 1 }}
              >
                {ackLoading ? 'Acknowledging…' : 'Confirm Ack'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Page content */}
      <div style={{ maxWidth: 1180, margin: '0 auto' }}>
        <InboxTabs counts={{ alerts: unackedInView }} />

        {/* Date bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
          <span className="eyebrow">From</span>
          <input type="date" className="num" style={dateInput} value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
          <span className="eyebrow">To</span>
          <input type="date" className="num" style={dateInput} value={dateTo} onChange={e => setDateTo(e.target.value)} />
          <FilterChip onClick={() => { const t = todayStr(); setDateFrom(t); setDateTo(t); }}>Today</FilterChip>
        </div>

        {error && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bad-bg)', border: '1px solid var(--bad-bd)',
            borderRadius: 'var(--r-md)', padding: '12px 16px', fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--bad-fg)', marginBottom: 16 }}>
            <Icon name="alert" size={16} /> {error}
          </div>
        )}

        {/* KPI tiles */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 12, marginBottom: 20 }}>
          <KpiTile label="Total Today"    value={fmt(totalToday)}              tone={totalToday > 0 ? 'brand' : undefined} />
          <KpiTile label="Unacknowledged" value={fmt(unacked)}                 tone={unacked > 0 ? 'bad' : 'ok'} />
          <KpiTile label="Worst Line"     value={summary?.worst_line    || '—'} />
          <KpiTile label="Worst Station"  value={summary?.worst_station || '—'} />
        </div>

        {/* Filter row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
          <FilterChip active={statusFilter === ''}        onClick={() => setStatusFilter('')}>All</FilterChip>
          <FilterChip active={statusFilter === 'unacked'} onClick={() => setStatusFilter('unacked')} dot="var(--red)">Unacknowledged</FilterChip>
          <FilterChip active={statusFilter === 'acked'}   onClick={() => setStatusFilter('acked')}   dot="var(--green)">Acknowledged</FilterChip>
          <div style={{ width: 8 }} />
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
        <Panel pad={8}>
          {loading ? (
            <div style={{ padding: '40px 0', display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : displayRows.length === 0 ? (
            <div style={{ padding: '36px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, color: 'var(--t3)' }}>
              <Icon name="bell" size={20} />
              <span style={{ fontFamily: 'var(--font-ui)', fontSize: 13 }}>No alerts in this range</span>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {['Time', 'Line', 'Station', 'Operator', 'UPC', 'Violation', 'Status', ''].map((h, i) => (
                      <th key={i} style={thStyle}><span className="eyebrow">{h}</span></th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {displayRows.map(v => {
                    const acked = !!v.acknowledged_at;
                    const stColor = STATION_COLORS[v.station] || 'var(--t2)';
                    return (
                      <tr key={v.id} style={{ opacity: acked ? 0.5 : 1 }}>
                        <td style={tdBase}>
                          <div className="num" style={{ fontSize: 11.5, color: 'var(--t3)' }}>{formatDateTime(v.timestamp)}</div>
                          {acked && (
                            <div className="num" style={{ fontSize: 10, color: 'var(--t3)', marginTop: 2 }}>
                              ack {formatTime(v.acknowledged_at)}
                            </div>
                          )}
                        </td>
                        <td style={tdBase}><LineChip id={v.line} /></td>
                        <td style={tdBase}><span className="num" style={{ fontSize: 11.5, fontWeight: 600, color: stColor }}>{v.station || '—'}</span></td>
                        <td style={{ ...tdBase, fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t2)' }}>{v.operator_name || '—'}</td>
                        <td style={tdBase}><span className="num" style={{ fontSize: 11.5, color: 'var(--yellow)' }}>{v.upc || '—'}</span></td>
                        <td style={{ ...tdBase, whiteSpace: 'normal', minWidth: 180 }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ width: 7, height: 7, borderRadius: '50%', background: acked ? 'var(--t4)' : 'var(--red)', flexShrink: 0 }} />
                            <span style={{ fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--t1)' }}>{v.error_message || '—'}</span>
                          </span>
                        </td>
                        <td style={tdBase}>
                          {acked
                            ? <ToneBadge tone="ok">Ack</ToneBadge>
                            : <ToneBadge tone="bad">Open</ToneBadge>}
                        </td>
                        <td style={{ ...tdBase, textAlign: 'right' }}>
                          {!acked && !isMahesh && (
                            <button
                              onClick={() => openAck(v)}
                              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'var(--surface-2)',
                                border: '1px solid var(--border-2)', color: 'var(--t1)', borderRadius: 'var(--r-xs)',
                                padding: '5px 10px', fontFamily: 'var(--font-display)', fontSize: 10, fontWeight: 700,
                                letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer' }}
                            >
                              Ack
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
        </Panel>
      </div>
    </>
  );
}
