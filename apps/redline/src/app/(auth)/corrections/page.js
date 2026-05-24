'use client';
import { useState, useMemo } from 'react';
import { useAuth } from '@throttle/auth';
import { workerFetch } from '@throttle/db';
import { Spinner, EmptyState, Panel, Chip, StatusBadge, useToast } from '@throttle/ui';
import { todayStr } from '@throttle/domain';
import { useScans } from '../../../hooks/useScans.js';

// ── Helpers ───────────────────────────────────────────────────
function fmt(n) { return n != null ? Number(n).toLocaleString('en-IN') : '0'; }

function formatTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
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

function ActivityBadge({ activity }) {
  const color = ACT_COLORS[activity] || 'var(--t2)';
  let bg, border;
  if (color.startsWith('var(--')) {
    bg = color.replace('var(--green)', 'rgba(34, 197, 94, 0.12)')
              .replace('var(--red)',   'rgba(222, 42, 42, 0.15)')
              .replace('var(--orange)','rgba(249, 115, 22, 0.12)')
              .replace('var(--t2)',    'rgba(80, 80, 80, 0.2)');
    border = color.replace('var(--green)', 'rgba(34, 197, 94, 0.25)')
                  .replace('var(--red)',   'rgba(222, 42, 42, 0.3)')
                  .replace('var(--orange)','rgba(249, 115, 22, 0.25)')
                  .replace('var(--t2)',    'rgba(80, 80, 80, 0.3)');
  } else {
    bg     = color + '20';
    border = color + '4d';
  }
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 7px',
      fontFamily: 'var(--mono)',
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
      color,
      background: bg,
      border: `1px solid ${border}`,
      borderRadius: 3,
      whiteSpace: 'nowrap',
      lineHeight: 1.3,
    }}>
      {activity || '—'}
    </span>
  );
}

// ── Corrections Page ──────────────────────────────────────────
export default function CorrectionsPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();

  const canVoid  = !!perms?.scan_void_supervisor;
  const canAmend = !!perms?.scan_amend_manager;

  const [selectedDate,   setSelectedDate]   = useState(() => todayStr());
  const [activityFilter, setActivityFilter] = useState('');
  const [showVoided,     setShowVoided]     = useState(false);
  const [upcSearch,      setUpcSearch]      = useState('');

  // Void modal
  const [voidModal,    setVoidModal]    = useState(null);
  const [voidReason,   setVoidReason]   = useState('');
  const [voidError,    setVoidError]    = useState('');
  const [voidLoading,  setVoidLoading]  = useState(false);

  // Amend modal
  const [amendModal,   setAmendModal]   = useState(null);
  const [amendLine,    setAmendLine]    = useState('');
  const [amendNotes,   setAmendNotes]   = useState('');
  const [amendReason,  setAmendReason]  = useState('');
  const [amendError,   setAmendError]   = useState('');
  const [amendLoading, setAmendLoading] = useState(false);

  const { scans, loading, reload } = useScans(
    { dateFrom: selectedDate, dateTo: selectedDate, showVoided },
    session
  );

  // ── Filtered rows ─────────────────────────────────────────
  const upcUpper = upcSearch.trim().toUpperCase();
  const displayRows = useMemo(() => {
    let rows = scans || [];
    if (activityFilter) rows = rows.filter(r => r.activity === activityFilter);
    if (upcUpper)       rows = rows.filter(r => (r.upc || '').toUpperCase().includes(upcUpper));
    return rows;
  }, [scans, activityFilter, upcUpper]);

  // ── Open modals ───────────────────────────────────────────
  function openVoid(s) {
    setVoidModal({
      id: s.id,
      upc: s.upc,
      activity: s.activity,
      time: formatTime(s.timestamp),
      operator: s.operator_name || (s.operator_id ? String(s.operator_id).slice(0, 8) : '—'),
    });
    setVoidReason('');
    setVoidError('');
  }

  function openAmend(s) {
    setAmendModal({
      id: s.id,
      upc: s.upc,
      activity: s.activity,
      time: formatTime(s.timestamp),
      line: s.line || '',
      notes: s.notes || '',
    });
    setAmendLine(s.line || '');
    setAmendNotes(s.notes || '');
    setAmendReason('');
    setAmendError('');
  }

  // ── Submit handlers ───────────────────────────────────────
  async function submitVoid() {
    if (!voidReason.trim()) { setVoidError('Reason is required'); return; }
    setVoidLoading(true); setVoidError('');
    try {
      const res = await workerFetch('voidScan', { scan_id: voidModal.id, void_reason: voidReason.trim() }, session);
      const result = res?.data || res;
      if (!result?.voided && result?.ok === false) throw new Error(result?.error || 'Void failed');
      setVoidModal(null);
      showToast('Scan voided', 'success');
      reload();
    } catch (e) {
      setVoidError(e.message || 'Void failed');
    } finally {
      setVoidLoading(false);
    }
  }

  async function submitAmend() {
    if (!amendReason.trim()) { setAmendError('Reason is required'); return; }
    const updates = {};
    if (amendLine.trim())  updates.line  = amendLine.trim();
    if (amendNotes.trim()) updates.notes = amendNotes.trim();
    if (!Object.keys(updates).length) { setAmendError('No changes to save'); return; }
    setAmendLoading(true); setAmendError('');
    try {
      const res = await workerFetch('amendScan', { scan_id: amendModal.id, reason: amendReason.trim(), updates }, session);
      const result = res?.data || res;
      if (!result?.amended && result?.ok === false) throw new Error(result?.error || 'Amendment failed');
      setAmendModal(null);
      showToast('Scan amended', 'success');
      reload();
    } catch (e) {
      setAmendError(e.message || 'Amendment failed');
    } finally {
      setAmendLoading(false);
    }
  }

  // ── Style constants ───────────────────────────────────────
  // Modal button (Cancel) — used in both Void and Amend modals
  const modalBtnCancel = {
    padding: '8px 14px', background: 'transparent', border: '1px solid var(--border)',
    borderRadius: 3, color: 'var(--t2)', fontFamily: 'var(--mono)', fontSize: 13, cursor: 'pointer',
  };
  const dateInputStyle = { background: 'var(--surface2)', color: 'var(--t1)', border: '1px solid var(--border)', padding: '6px 10px', borderRadius: 3, fontFamily: 'var(--mono)', fontSize: 13, outline: 'none' };
  const dateLabelStyle = { fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', letterSpacing: '0.08em', textTransform: 'uppercase' };
  const inputStyle = { background: 'var(--surface2)', color: 'var(--t1)', border: '1px solid var(--border)', padding: '6px 10px', borderRadius: 3, fontFamily: 'var(--mono)', fontSize: 13, width: 220, outline: 'none' };
  const thStyle = { padding: '10px 14px', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', fontWeight: 600, textAlign: 'left' };
  const tdStyle = { padding: '10px 14px', fontFamily: 'var(--mono)', fontSize: 13, borderBottom: '1px solid rgba(64,64,64,.5)', whiteSpace: 'nowrap', color: 'var(--t1)' };

  const actionBtn = (color) => ({
    padding: '5px 11px',
    background: 'transparent',
    border: `1px solid ${color}`,
    borderRadius: 3,
    color,
    fontFamily: 'var(--mono)',
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    cursor: 'pointer',
    marginRight: 6,
  });

  return (
    <>
      {/* Void modal */}
      {voidModal && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={(e) => { if (e.target === e.currentTarget) setVoidModal(null); }}
        >
          <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: '28px 32px', width: 460, maxWidth: '90vw' }}>
            <div style={{ fontFamily: 'var(--cond)', fontSize: 14, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--red)', marginBottom: 16 }}>
              Void Scan — Tier 2
            </div>
            <div style={{ background: 'var(--surface3)', border: '1px solid var(--border)', borderRadius: 4, padding: 12, marginBottom: 16, fontSize: 12, fontFamily: 'var(--mono)' }}>
              <div style={{ color: 'var(--t3)', fontSize: 10, marginBottom: 4 }}>SCAN</div>
              <div style={{ color: 'var(--yellow)' }}>{voidModal.upc}</div>
              <div style={{ color: 'var(--t2)', marginTop: 4 }}>
                {voidModal.activity} · {voidModal.time} · {voidModal.operator}
              </div>
            </div>
            <label style={{ fontSize: 10, color: 'var(--t3)', letterSpacing: '0.08em', textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>
              Reason (required)
            </label>
            <textarea
              value={voidReason}
              onChange={e => setVoidReason(e.target.value)}
              rows={3}
              placeholder="Why is this scan being voided?"
              style={{ width: '100%', background: 'var(--surface)', color: 'var(--t1)', border: '1px solid var(--border)', borderRadius: 3, padding: 8, fontSize: 12, fontFamily: 'var(--mono)', resize: 'vertical' }}
            />
            {voidError && (
              <div style={{ color: 'var(--red)', fontSize: 11, marginTop: 8, fontFamily: 'var(--mono)' }}>{voidError}</div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
              <button onClick={() => setVoidModal(null)} style={modalBtnCancel} disabled={voidLoading}>Cancel</button>
              <button
                onClick={submitVoid}
                disabled={voidLoading || !voidReason.trim()}
                style={{
                  padding: '8px 14px', background: 'var(--red)', color: '#fff',
                  border: '1px solid var(--red)', borderRadius: 3,
                  fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700,
                  letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer',
                  opacity: (voidLoading || !voidReason.trim()) ? 0.5 : 1,
                }}
              >
                {voidLoading ? 'Voiding…' : 'Confirm Void'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Amend modal */}
      {amendModal && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={(e) => { if (e.target === e.currentTarget) setAmendModal(null); }}
        >
          <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: '28px 32px', width: 480, maxWidth: '90vw' }}>
            <div style={{ fontFamily: 'var(--cond)', fontSize: 14, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--yellow)', marginBottom: 16 }}>
              Amend Scan — Tier 3
            </div>
            <div style={{ background: 'var(--surface3)', border: '1px solid var(--border)', borderRadius: 4, padding: 12, marginBottom: 16, fontSize: 12, fontFamily: 'var(--mono)' }}>
              <div style={{ color: 'var(--t3)', fontSize: 10, marginBottom: 4 }}>SCAN</div>
              <div style={{ color: 'var(--yellow)' }}>{amendModal.upc}</div>
              <div style={{ color: 'var(--t2)', marginTop: 4 }}>{amendModal.activity} · {amendModal.time}</div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
              <div>
                <label style={{ fontSize: 10, color: 'var(--t3)', letterSpacing: '0.08em', textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Line</label>
                <input
                  value={amendLine}
                  onChange={e => setAmendLine(e.target.value)}
                  placeholder="L1 / L2 / L3"
                  style={{ width: '100%', background: 'var(--surface)', color: 'var(--t1)', border: '1px solid var(--border)', borderRadius: 3, padding: 8, fontSize: 12, fontFamily: 'var(--mono)' }}
                />
              </div>
              <div>
                <label style={{ fontSize: 10, color: 'var(--t3)', letterSpacing: '0.08em', textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Notes</label>
                <input
                  value={amendNotes}
                  onChange={e => setAmendNotes(e.target.value)}
                  placeholder="Optional notes"
                  style={{ width: '100%', background: 'var(--surface)', color: 'var(--t1)', border: '1px solid var(--border)', borderRadius: 3, padding: 8, fontSize: 12, fontFamily: 'var(--mono)' }}
                />
              </div>
            </div>

            <label style={{ fontSize: 10, color: 'var(--t3)', letterSpacing: '0.08em', textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>
              Reason (required)
            </label>
            <textarea
              value={amendReason}
              onChange={e => setAmendReason(e.target.value)}
              rows={3}
              placeholder="Why is this scan being amended?"
              style={{ width: '100%', background: 'var(--surface)', color: 'var(--t1)', border: '1px solid var(--border)', borderRadius: 3, padding: 8, fontSize: 12, fontFamily: 'var(--mono)', resize: 'vertical' }}
            />
            {amendError && (
              <div style={{ color: 'var(--red)', fontSize: 11, marginTop: 8, fontFamily: 'var(--mono)' }}>{amendError}</div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
              <button onClick={() => setAmendModal(null)} style={modalBtnCancel} disabled={amendLoading}>Cancel</button>
              <button
                onClick={submitAmend}
                disabled={amendLoading || !amendReason.trim()}
                style={{
                  padding: '8px 14px', background: 'var(--yellow)', color: '#0a0a0a',
                  border: '1px solid var(--yellow)', borderRadius: 3,
                  fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700,
                  letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer',
                  opacity: (amendLoading || !amendReason.trim()) ? 0.5 : 1,
                }}
              >
                {amendLoading ? 'Saving…' : 'Confirm Amend'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Page content */}
      <div>
        {/* Date bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
          <span style={dateLabelStyle}>Date</span>
          <input
            type="date"
            style={dateInputStyle}
            value={selectedDate}
            onChange={e => setSelectedDate(e.target.value)}
          />
          <Chip onClick={() => setSelectedDate(todayStr())}>Today</Chip>
          <div style={{ flex: 1 }} />
          <input
            type="text"
            placeholder="Search UPC…"
            style={inputStyle}
            value={upcSearch}
            onChange={e => setUpcSearch(e.target.value)}
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t2)', cursor: 'pointer' }}>
            <input type="checkbox" checked={showVoided} onChange={e => setShowVoided(e.target.checked)} />
            Show Voided
          </label>
        </div>

        {/* Activity filter row */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 18 }}>
          {ACTIVITY_FILTERS.map(f => (
            <Chip
              key={f.value || 'all'}
              active={activityFilter === f.value}
              onClick={() => setActivityFilter(f.value)}
            >
              {f.label}
            </Chip>
          ))}
        </div>

        {/* Info panel */}
        <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 4, padding: '12px 14px', marginBottom: 18, fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t2)', lineHeight: 1.6 }}>
          <div><StatusBadge variant="error">Tier 2 Void</StatusBadge>{' '}— Supervisor can void scans from the current shift only. Reason required.</div>
          <div style={{ marginTop: 6 }}><StatusBadge variant="brand">Tier 3 Amend</StatusBadge>{' '}— Manager can correct line, operator, or notes on any scan. Immutable audit trail created.</div>
        </div>

        {/* Table */}
        <Panel padding={0}>
          {loading ? (
            <div style={{ padding: '40px 0', display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : displayRows.length === 0 ? (
            <EmptyState icon="📡" message="No scans found" />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {['Time','UPC','Activity','Line','Product','Operator','Loop','Status','Actions'].map(h => (
                      <th key={h} style={thStyle}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {displayRows.map(s => {
                    const voided = !!s.voided;
                    return (
                      <tr key={s.id} style={{ opacity: voided ? 0.45 : 1 }}>
                        <td style={{ ...tdStyle, fontFamily: 'var(--mono)', color: 'var(--t2)' }}>{formatTime(s.timestamp)}</td>
                        <td style={{ ...tdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{s.upc || '—'}</td>
                        <td style={tdStyle}><ActivityBadge activity={s.activity} /></td>
                        <td style={{ ...tdStyle, color: 'var(--t1)' }}>{s.line || '—'}</td>
                        <td style={{ ...tdStyle, color: 'var(--t1)' }}>{s.unit_product || '—'}</td>
                        <td style={{ ...tdStyle, color: 'var(--t2)' }}>{s.operator_name || (s.operator_id ? String(s.operator_id).slice(0, 8) : '—')}</td>
                        <td style={{ ...tdStyle, fontFamily: 'var(--mono)', color: 'var(--t2)' }}>{s.loop_count != null ? s.loop_count : '—'}</td>
                        <td style={tdStyle}>
                          {voided
                            ? <StatusBadge variant="error"   icon="✗">Voided</StatusBadge>
                            : <StatusBadge variant="success" icon="✓">OK</StatusBadge>}
                        </td>
                        <td style={tdStyle}>
                          {voided ? (
                            <span style={{ color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.04em' }}>—</span>
                          ) : (canVoid || canAmend) ? (
                            <>
                              {canVoid  && <button onClick={() => openVoid(s)}  style={actionBtn('var(--red)')}>Void</button>}
                              {canAmend && <button onClick={() => openAmend(s)} style={actionBtn('var(--yellow)')}>Amend</button>}
                            </>
                          ) : null}
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
