'use client';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { KpiCard, Spinner, EmptyState, useToast } from '@throttle/ui';

// ── Helpers ───────────────────────────────────────────────────
function fmt(n) { return n != null ? Number(n).toLocaleString('en-IN') : '0'; }

function formatDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const date = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' }).replace(/ /g, '-');
  const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
  return `${date} ${time}`;
}

const BADGE_STYLES = {
  yellow: { background: 'rgba(242,205,26,.12)', color: '#f2cd1a', border: '1px solid rgba(242,205,26,.2)' },
  green:  { background: 'rgba(34,197,94,.12)',  color: '#4ade80', border: '1px solid rgba(34,197,94,.2)'  },
  red:    { background: 'rgba(222,42,42,.15)',  color: '#ff7070', border: '1px solid rgba(222,42,42,.25)' },
  blue:   { background: 'rgba(33,60,226,.2)',   color: '#7b93ff', border: '1px solid rgba(33,60,226,.3)'  },
  gray:   { background: 'rgba(80,80,80,.2)',    color: '#888',    border: '1px solid rgba(80,80,80,.3)'   },
};

const CATEGORY_TONE = {
  UDR: 'green',
  CXR: 'yellow',
  BRV: 'blue',
};

function StatusBadge({ value, tone }) {
  const style = BADGE_STYLES[tone] || BADGE_STYLES.gray;
  return (
    <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 2, textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap', fontFamily: 'var(--mono)', fontWeight: 700, ...style }}>
      {value}
    </span>
  );
}

// ── Returns Page ──────────────────────────────────────────────
export default function ReturnsPage() {
  const { session } = useAuth();
  const { showToast } = useToast();

  const [rows,         setRows]         = useState([]);
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState(null);
  const [actionFilter, setActionFilter] = useState('');

  const [actionModal,   setActionModal]   = useState(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError,   setActionError]   = useState('');

  const loadReturns = useCallback(async () => {
    if (!session) return;
    setLoading(true); setError(null);
    try {
      const data = await garageFetch('getReturnQueue', {}, session);
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e.message || 'Failed to load return queue');
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => { loadReturns(); }, [loadReturns]);

  // ── KPI counts ────────────────────────────────────────────
  const rtdCount = rows.filter(r => r.action === 'rtd_direct').length;
  const wksCount = rows.filter(r => r.action === 'wks_repair').length;
  const udrCount = rows.filter(r => r.return_category === 'UDR').length;
  const cxrCount = rows.filter(r => r.return_category === 'CXR').length;
  const brvCount = rows.filter(r => r.return_category === 'BRV').length;

  // ── Filtered rows ─────────────────────────────────────────
  const displayRows = useMemo(() => {
    if (!actionFilter) return rows;
    return rows.filter(r => r.action === actionFilter);
  }, [rows, actionFilter]);

  // ── Submit action (graceful fallback — action missing) ────
  async function submitAction(outcome) {
    if (!actionModal) return;
    setActionLoading(true); setActionError('');
    try {
      const res = await workerFetch('linkProductionScan', {
        return_unit_id: actionModal.return_unit_id,
        scan_id: null,
        outcome,
      }, session);
      const result = res?.data || res;
      if (result?.ok === false) throw new Error(result?.error || 'Action failed');
      setActionModal(null);
      showToast('Return actioned', 'success');
      loadReturns();
    } catch (e) {
      setActionError(e.message || 'Returns action not yet available');
    } finally {
      setActionLoading(false);
    }
  }

  // ── Style constants ───────────────────────────────────────
  const btnStyle = { padding: '4px 10px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--t2)', fontSize: 11, cursor: 'pointer', fontFamily: 'var(--mono)', letterSpacing: '0.04em' };
  const btnActiveStyle = { ...btnStyle, background: 'rgba(242,205,26,.12)', color: 'var(--yellow)', border: '1px solid rgba(242,205,26,.3)' };
  const thStyle = { padding: '8px 12px', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', fontWeight: 600, textAlign: 'left' };
  const tdStyle = { padding: '8px 12px', fontSize: 12, borderBottom: '1px solid rgba(42,42,42,.6)', whiteSpace: 'nowrap' };

  const emptyMessage = actionFilter
    ? `No ${actionFilter.replace('_', ' ')} items pending`
    : '✅ No returns pending action';

  return (
    <>
      {/* Action modal */}
      {actionModal && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={(e) => { if (e.target === e.currentTarget) setActionModal(null); }}
        >
          <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: '28px 32px', width: 460, maxWidth: '90vw' }}>
            <div style={{ fontFamily: 'var(--cond)', fontSize: 14, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--orange)', marginBottom: 16 }}>
              Action Return Unit
            </div>
            <div style={{ background: 'var(--surface3)', border: '1px solid var(--border)', borderRadius: 4, padding: 12, marginBottom: 16, fontSize: 12, fontFamily: 'var(--mono)' }}>
              <div style={{ color: 'var(--t3)', fontSize: 10, marginBottom: 4 }}>RETURN UNIT</div>
              <div style={{ color: 'var(--yellow)' }}>{actionModal.return_unit_id}</div>
              <div style={{ color: 'var(--t1)', marginTop: 4 }}>{actionModal.product || '—'}</div>
              <div style={{ color: 'var(--t2)', marginTop: 4, display: 'flex', gap: 10, alignItems: 'center' }}>
                <StatusBadge value={actionModal.return_category} tone={CATEGORY_TONE[actionModal.return_category] || 'gray'} />
                <span style={{ color: actionModal.action === 'rtd_direct' ? 'var(--green)' : 'var(--orange)', fontWeight: 700 }}>
                  {actionModal.action === 'rtd_direct' ? '📦 RTD DIRECT' : '🔧 WORKSHOP'}
                </span>
              </div>
            </div>

            {actionError && (
              <div style={{ color: 'var(--red)', fontSize: 11, marginTop: 8, marginBottom: 8, fontFamily: 'var(--mono)' }}>{actionError}</div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
              <button onClick={() => setActionModal(null)} style={btnStyle} disabled={actionLoading}>Cancel</button>
              <button
                onClick={() => submitAction('scrapped')}
                disabled={actionLoading}
                style={{ ...btnStyle, background: 'var(--red)', color: '#fff', border: '1px solid var(--red)', opacity: actionLoading ? 0.5 : 1 }}
              >
                ⚠ SCRAPPED
              </button>
              <button
                onClick={() => submitAction('actioned')}
                disabled={actionLoading}
                style={{ ...btnStyle, background: 'var(--green)', color: '#000', border: '1px solid var(--green)', opacity: actionLoading ? 0.5 : 1 }}
              >
                {actionLoading ? 'Saving…' : '✓ ACTIONED'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Page content */}
      <div>
        {error && (
          <div style={{ background: 'rgba(222,42,42,.1)', border: '1px solid rgba(222,42,42,.25)', borderRadius: 4, padding: '10px 14px', fontSize: 12, color: 'var(--red)', marginBottom: 14 }}>
            {error}
          </div>
        )}

        {/* KPI cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 18 }}>
          <KpiCard label="Pending Action" value={fmt(rows.length)} sub="Total in queue" color={rows.length > 0 ? 'yellow' : undefined} />
          <KpiCard label="RTD Direct"     value={fmt(rtdCount)}     sub="Scan at RTO_IN"  color={rtdCount > 0 ? 'green' : undefined} />
          <KpiCard label="Workshop"       value={fmt(wksCount)}     sub="Send to WKS"     color={wksCount > 0 ? 'orange' : undefined} />
          <KpiCard label="By Category"    value={`${udrCount} UDR`} sub={`${cxrCount} CXR · ${brvCount} BRV`} />
        </div>

        {/* Filter row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <button style={actionFilter === ''           ? btnActiveStyle : btnStyle} onClick={() => setActionFilter('')}>All Pending</button>
          <button style={actionFilter === 'rtd_direct' ? btnActiveStyle : btnStyle} onClick={() => setActionFilter('rtd_direct')}>RTD Direct</button>
          <button style={actionFilter === 'wks_repair' ? btnActiveStyle : btnStyle} onClick={() => setActionFilter('wks_repair')}>Workshop</button>
          <div style={{ marginLeft: 'auto' }}>
            <button onClick={loadReturns} style={btnStyle} disabled={loading}>↻ Refresh</button>
          </div>
        </div>

        {/* Table */}
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden' }}>
          {loading ? (
            <div style={{ padding: '40px 0', display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : displayRows.length === 0 ? (
            <EmptyState icon="📭" message={emptyMessage} />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {['Return Unit','Category','Product','Action Required','Car UPC','Remote UPC','Handed Off',''].map(h => (
                      <th key={h} style={thStyle}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {displayRows.map(r => (
                    <tr key={r.return_unit_id}>
                      <td style={{ ...tdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{r.return_unit_id}</td>
                      <td style={tdStyle}>
                        <StatusBadge value={r.return_category || '—'} tone={CATEGORY_TONE[r.return_category] || 'gray'} />
                      </td>
                      <td style={{ ...tdStyle, color: 'var(--t1)' }}>{r.product || '—'}</td>
                      <td style={{ ...tdStyle, fontWeight: 700, color: r.action === 'rtd_direct' ? 'var(--green)' : 'var(--orange)' }}>
                        {r.action === 'rtd_direct' ? '📦 RTD DIRECT' : r.action === 'wks_repair' ? '🔧 WORKSHOP' : (r.action || '—')}
                      </td>
                      <td style={{ ...tdStyle, fontFamily: 'var(--mono)', color: 'var(--t2)' }}>{r.car_upc || '—'}</td>
                      <td style={{ ...tdStyle, fontFamily: 'var(--mono)', color: 'var(--t2)' }}>{r.remote_upc || '—'}</td>
                      <td style={{ ...tdStyle, fontFamily: 'var(--mono)', color: 'var(--t3)' }}>{r.handed_off_at ? formatDateTime(r.handed_off_at) : '—'}</td>
                      <td style={tdStyle}>
                        <button
                          onClick={() => { setActionModal(r); setActionError(''); }}
                          style={{ padding: '4px 12px', background: 'var(--orange)', color: '#000', border: '1px solid var(--orange)', borderRadius: 2, fontSize: 10, fontWeight: 700, fontFamily: 'var(--mono)', letterSpacing: '0.05em', cursor: 'pointer' }}
                        >
                          ACTION
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
