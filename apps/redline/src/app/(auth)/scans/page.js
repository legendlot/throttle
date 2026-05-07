'use client';
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, EmptyState } from '@throttle/ui';
import { todayStr } from '@throttle/domain';
import { useScans } from '../../../hooks/useScans.js';
import { useRefreshState } from '../layout.js';

// ── Helpers ───────────────────────────────────────────────────
function fmt(n) { return n != null ? Number(n).toLocaleString('en-IN') : '0'; }

function getMondayISO() {
  const d = new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(new Date().setDate(diff)).toISOString().split('T')[0];
}

function getFirstOfMonthISO() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().split('T')[0];
}

function formatTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
}

function formatDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const date = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'Asia/Kolkata' }).replace(/ /g, '-');
  const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
  return `${date} ${time}`;
}

const ACT_COLORS = {
  INW:        '#60a5fa',
  QC_PASS:    'var(--green)',
  QC_FAIL:    'var(--red)',
  WKS_IN:     '#a78bfa',
  WKS_OUT:    '#a78bfa',
  PKG:        '#8b5cf6',
  RTO_IN:     'var(--orange)',
  RTD_RETURN: '#14b8a6',
  RTE:        '#60a5fa',
  RTR:        '#60a5fa',
};

const ACTIVITY_FILTERS = [
  { value: '',           label: 'All' },
  { value: 'INW',        label: 'INW' },
  { value: 'QC_PASS',    label: 'QC Pass' },
  { value: 'QC_FAIL',    label: 'QC Fail' },
  { value: 'WKS_IN',     label: 'WKS In' },
  { value: 'WKS_OUT',    label: 'WKS Out' },
  { value: 'PKG',        label: 'PKG' },
  { value: 'RTE',        label: 'RTE' },
  { value: 'RTR',        label: 'RTR' },
  { value: 'RTO_IN',     label: 'RTO In' },
  { value: 'RTD_RETURN', label: 'RTD Return' },
];

const SUMMARY_ACTIVITIES = ['INW','QC_PASS','QC_FAIL','WKS_IN','WKS_OUT','PKG','RTO_IN','RTD_RETURN'];

const SUMMARY_LABELS = {
  INW:        'Inwarded',
  QC_PASS:    'QC Pass',
  QC_FAIL:    'QC Fail',
  WKS_IN:     'WKS In',
  WKS_OUT:    'WKS Out',
  PKG:        'PKG',
  RTO_IN:     'RTO In',
  RTD_RETURN: 'RTD Return',
};

// ── Activity badge ────────────────────────────────────────────
function ActivityBadge({ activity }) {
  const color = ACT_COLORS[activity] || 'var(--t2)';
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 7px',
      fontSize: 9,
      fontWeight: 700,
      letterSpacing: '0.06em',
      textTransform: 'uppercase',
      fontFamily: 'var(--mono)',
      color,
      border: `1px solid ${color}`,
      borderRadius: 2,
      whiteSpace: 'nowrap',
    }}>
      {activity || '—'}
    </span>
  );
}

// ── Scans Page ────────────────────────────────────────────────
export default function ScansPage() {
  const { session } = useAuth();
  const { setRefreshing, setLastRefreshed } = useRefreshState();

  const [dateFrom,        setDateFrom]        = useState(() => todayStr());
  const [dateTo,          setDateTo]          = useState(() => todayStr());
  const [activityFilter,  setActivityFilter]  = useState('');
  const [showVoided,      setShowVoided]      = useState(false);
  const [upcSearch,       setUpcSearch]       = useState('');
  const [upcMode,         setUpcMode]         = useState(false);
  const [upcScans,        setUpcScans]        = useState([]);
  const [upcLoading,      setUpcLoading]      = useState(false);
  const [summary,         setSummary]         = useState(null);
  const [summaryLoading,  setSummaryLoading]  = useState(false);

  const { scans, loading, error: scanError, hasMore, loadMore, reload } =
    useScans({ dateFrom, dateTo, showVoided, activityFilter }, session);

  // ── Scan summary fetch (single date) ──────────────────────
  useEffect(() => {
    if (!session || !dateFrom) return;
    let cancelled = false;
    (async () => {
      setSummaryLoading(true);
      try {
        const data = await garageFetch('getScanSummary', { date: dateFrom }, session);
        if (!cancelled) setSummary(data || null);
      } catch (_) {
        if (!cancelled) setSummary(null);
      } finally {
        if (!cancelled) setSummaryLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [dateFrom, session]);

  // ── UPC search debounce ───────────────────────────────────
  const debounceRef = useRef(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = upcSearch.trim();
    if (trimmed.length === 0) {
      // Exit UPC mode
      setUpcMode(false);
      setUpcScans([]);
      return;
    }
    if (trimmed.length >= 4) {
      // Long search → fetch via getScansByUpc
      debounceRef.current = setTimeout(async () => {
        if (!session) return;
        setUpcLoading(true);
        try {
          const data = await garageFetch('getScansByUpc', { upc: trimmed }, session);
          setUpcScans(Array.isArray(data) ? data : []);
          setUpcMode(true);
        } catch (_) {
          setUpcScans([]);
        } finally {
          setUpcLoading(false);
        }
      }, 500);
    } else {
      // 1–3 chars → client-side filter (200ms debounce just to settle UI)
      debounceRef.current = setTimeout(() => {
        setUpcMode(false);
      }, 200);
    }
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [upcSearch, session]);

  // Refresh-bar wiring (manual reload only — no auto-refresh on this tab)
  useEffect(() => {
    setRefreshing(loading || upcLoading || summaryLoading);
  }, [loading, upcLoading, summaryLoading, setRefreshing]);

  useEffect(() => {
    if (!loading && !upcLoading && !summaryLoading) {
      setLastRefreshed(
        new Date().toLocaleTimeString('en-IN', {
          hour: '2-digit', minute: '2-digit', second: '2-digit',
          hour12: true, timeZone: 'Asia/Kolkata',
        })
      );
    }
  }, [loading, upcLoading, summaryLoading, setLastRefreshed]);

  // ── Preset buttons ────────────────────────────────────────
  function handlePreset(preset) {
    const today = todayStr();
    if (preset === 'today') { setDateFrom(today); setDateTo(today); }
    else if (preset === 'week')  { setDateFrom(getMondayISO()); setDateTo(today); }
    else if (preset === 'month') { setDateFrom(getFirstOfMonthISO()); setDateTo(today); }
  }
  const activePreset =
    dateFrom === todayStr() && dateTo === todayStr() ? 'today'
      : dateFrom === getMondayISO() && dateTo === todayStr() ? 'week'
      : dateFrom === getFirstOfMonthISO() && dateTo === todayStr() ? 'month'
      : null;

  // ── Display rows ──────────────────────────────────────────
  const baseRows = upcMode ? upcScans : scans;
  const trimmed  = upcSearch.trim().toUpperCase();

  const displayRows = useMemo(() => {
    let rows = baseRows || [];
    // In UPC mode, allow toggle to filter voided client-side; in normal mode the hook already excludes
    if (upcMode && !showVoided) rows = rows.filter(r => !r.voided);
    if (upcMode && activityFilter) rows = rows.filter(r => r.activity === activityFilter);
    if (!upcMode && trimmed.length >= 1 && trimmed.length <= 3) {
      rows = rows.filter(r => (r.upc || '').toUpperCase().includes(trimmed));
    }
    return rows;
  }, [baseRows, upcMode, showVoided, activityFilter, trimmed]);

  // ── Style constants ───────────────────────────────────────
  const btnStyle = { padding: '4px 10px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--t2)', fontSize: 11, cursor: 'pointer', fontFamily: 'var(--mono)', letterSpacing: '0.04em' };
  const btnActiveStyle = { ...btnStyle, background: 'rgba(242,205,26,.12)', color: 'var(--yellow)', border: '1px solid rgba(242,205,26,.3)' };
  const dateInputStyle = { background: 'var(--surface2)', color: 'var(--t1)', border: '1px solid var(--border)', padding: '3px 6px', borderRadius: 3, fontFamily: 'var(--mono)', fontSize: 12 };
  const dateLabelStyle = { fontSize: 11, color: 'var(--t3)', letterSpacing: '0.08em', textTransform: 'uppercase' };
  const inputStyle = { background: 'var(--surface2)', color: 'var(--t1)', border: '1px solid var(--border)', padding: '4px 8px', borderRadius: 3, fontFamily: 'var(--mono)', fontSize: 12, width: 200 };

  const thStyle = { padding: '8px 12px', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', fontWeight: 600, textAlign: 'left' };
  const tdStyle = { padding: '8px 12px', fontSize: 12, borderBottom: '1px solid rgba(42,42,42,.6)', whiteSpace: 'nowrap' };

  const isRange = dateFrom !== dateTo;

  // ── Render ────────────────────────────────────────────────
  return (
    <div>
      {/* Date bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        {isRange && (
          <>
            <span style={dateLabelStyle}>From</span>
            <input type="date" style={dateInputStyle} value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
            <span style={dateLabelStyle}>to</span>
          </>
        )}
        <input
          type="date"
          style={dateInputStyle}
          value={dateTo}
          onChange={e => { setDateTo(e.target.value); if (!isRange) setDateFrom(e.target.value); }}
        />
        <button style={activePreset === 'today' ? btnActiveStyle : btnStyle} onClick={() => handlePreset('today')}>Today</button>
        <button style={activePreset === 'week'  ? btnActiveStyle : btnStyle} onClick={() => handlePreset('week')}>This Week</button>
        <button style={activePreset === 'month' ? btnActiveStyle : btnStyle} onClick={() => handlePreset('month')}>This Month</button>

        <div style={{ flex: 1 }} />

        <input
          type="text"
          placeholder="Search UPC…"
          style={inputStyle}
          value={upcSearch}
          onChange={e => setUpcSearch(e.target.value)}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--t2)', fontFamily: 'var(--mono)', cursor: 'pointer' }}>
          <input type="checkbox" checked={showVoided} onChange={e => setShowVoided(e.target.checked)} />
          Show Voided
        </label>
      </div>

      {/* Activity filter row */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
        {ACTIVITY_FILTERS.map(f => (
          <button
            key={f.value || 'all'}
            style={activityFilter === f.value ? btnActiveStyle : btnStyle}
            onClick={() => setActivityFilter(f.value)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Summary cards (hidden in UPC mode) */}
      {!upcMode && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8, marginBottom: 18 }}>
          <SummaryCard
            label="Total"
            value={summary?.total}
            color="yellow"
            active={activityFilter === ''}
            onClick={() => setActivityFilter('')}
          />
          {SUMMARY_ACTIVITIES.map(a => {
            const count = summary?.[a];
            const sub = a === 'INW' && summary?.INW_car != null
              ? `${fmt(summary.INW_car)}C · ${fmt(summary.INW_remote || 0)}R`
              : a === 'QC_PASS' && summary?.QC_PASS_car != null
              ? `${fmt(summary.QC_PASS_car)}C · ${fmt(summary.QC_PASS_remote || 0)}R`
              : null;
            return (
              <SummaryCard
                key={a}
                label={SUMMARY_LABELS[a]}
                value={count}
                stripe={ACT_COLORS[a]}
                sub={sub}
                active={activityFilter === a}
                onClick={() => setActivityFilter(a)}
              />
            );
          })}
          <SummaryCard
            label="Voided"
            value={summary?.voided}
            color="gray"
            active={false}
            onClick={() => setShowVoided(v => !v)}
          />
        </div>
      )}

      {/* Table */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden' }}>
        {(loading || upcLoading) ? (
          <div style={{ padding: '40px 0', display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        ) : displayRows.length === 0 ? (
          <EmptyState icon="📡" message="No scans found" />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['Time','UPC','Activity','Line','Product','Operator','Loop','Status'].map(h => (
                    <th key={h} style={thStyle}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {displayRows.map(s => {
                  const voided = !!s.voided;
                  const rowOpacity = voided ? 0.45 : 1;
                  return (
                    <tr key={s.id} style={{ opacity: rowOpacity }}>
                      <td style={{ ...tdStyle, fontFamily: 'var(--mono)', color: 'var(--t2)' }}>
                        {upcMode ? formatDateTime(s.timestamp) : formatTime(s.timestamp)}
                      </td>
                      <td style={{ ...tdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{s.upc || '—'}</td>
                      <td style={tdStyle}><ActivityBadge activity={s.activity} /></td>
                      <td style={{ ...tdStyle, color: 'var(--t1)' }}>{s.line || '—'}</td>
                      <td style={{ ...tdStyle, color: 'var(--t1)' }}>{s.unit_product || '—'}</td>
                      <td style={{ ...tdStyle, color: 'var(--t2)' }}>{s.operator_name || (s.operator_id ? String(s.operator_id).slice(0, 8) : '—')}</td>
                      <td style={{ ...tdStyle, fontFamily: 'var(--mono)', color: 'var(--t2)' }}>{s.loop_count != null ? s.loop_count : '—'}</td>
                      <td style={{ ...tdStyle, fontFamily: 'var(--mono)' }}>
                        {voided
                          ? <span style={{ color: 'var(--red)', fontSize: 10, fontWeight: 700 }}>VOIDED</span>
                          : <span style={{ color: 'var(--green)', fontSize: 10, fontWeight: 700 }}>OK</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {hasMore && !upcMode && (
          <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 11, color: 'var(--t3)', fontFamily: 'var(--mono)' }}>
              Showing {scans.length} scans — more available
            </span>
            <button
              style={{ padding: '5px 14px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--t2)', fontSize: 11, cursor: loading ? 'not-allowed' : 'pointer', fontFamily: 'var(--mono)' }}
              onClick={loadMore}
              disabled={loading}
            >
              {loading ? 'Loading…' : 'Load More'}
            </button>
          </div>
        )}
        {!hasMore && scans.length > 0 && !upcMode && (
          <div style={{ padding: '8px 16px', borderTop: '1px solid var(--border)', textAlign: 'right' }}>
            <span style={{ fontSize: 10, color: 'var(--t3)', fontFamily: 'var(--mono)' }}>
              {scans.length} scans loaded
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Summary card ──────────────────────────────────────────────
function SummaryCard({ label, value, color, stripe, sub, active, onClick }) {
  const STRIPE_MAP = { yellow: '#F2CD1A', gray: '#555' };
  const stripeColor = stripe || STRIPE_MAP[color] || 'transparent';
  return (
    <div
      onClick={onClick}
      style={{
        background: active ? 'var(--surface2)' : 'var(--surface)',
        border: active ? '1px solid var(--yellow)' : '1px solid var(--border)',
        borderRadius: 4,
        padding: 12,
        cursor: 'pointer',
        position: 'relative',
        overflow: 'hidden',
        fontFamily: 'var(--mono)',
        transition: 'all 0.15s',
      }}
    >
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: stripeColor }} />
      <div style={{ fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--t3)', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, color: 'var(--t1)', lineHeight: 1, fontWeight: 600 }}>{value != null ? fmt(value) : '—'}</div>
      {sub && <div style={{ fontSize: 10, color: 'var(--t3)', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}
