'use client';
/* ════════════════════════════════════════════════════════════
   CORRECTIONS — Inbox stream (Pit Wall v2). Data-fix surface:
   Tier 2 void (supervisor, current shift) and Tier 3 amend
   (manager, any scan) on the day's scans. Mutations unchanged:
   workerFetch voidScan / amendScan; permission gating via
   perms.scan_void_supervisor / perms.scan_amend_manager.
   ════════════════════════════════════════════════════════════ */
import { useState, useEffect, useMemo } from 'react';
import { useAuth } from '@throttle/auth';
import { workerFetch } from '@throttle/db';
import { Spinner, Modal, useToast } from '@throttle/ui';
import { todayStr } from '@throttle/domain';
import { useScans } from '../../../hooks/useScans.js';
import { useRefreshState } from '../layout.js';
import {
  Icon, Panel, FilterChip, ToneBadge, InboxTabs,
  lineColor, lineRgb, btnGhost, inputStyle,
} from '../../../components/kit/index.js';

// ── Helpers ───────────────────────────────────────────────────
function formatTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
}

const ACT_COLORS = {
  INW:        'var(--blue-bright)',
  QC_PASS:    'var(--ok-fg)',
  QC_FAIL:    'var(--bad-fg)',
  WKS_IN:     '#a78bfa',
  WKS_OUT:    '#a78bfa',
  PKG:        '#8b5cf6',
  RTO_IN:     'var(--orange)',
  RTD_RETURN: '#14b8a6',
  RTE:        'var(--blue-bright)',
  RTR:        'var(--blue-bright)',
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

// ── shared table cell styles (Pit Wall v2) ────────────────────
const thStyle = { padding: '0 14px 9px', textAlign: 'left', whiteSpace: 'nowrap' };
const tdBase = { padding: '9px 14px', borderTop: '1px solid var(--border)', whiteSpace: 'nowrap', verticalAlign: 'middle' };

function ActivityBadge({ activity }) {
  const color = ACT_COLORS[activity] || 'var(--t2)';
  return (
    <span className="num" style={{
      display: 'inline-block', padding: '2px 7px', fontSize: 10.5, fontWeight: 600,
      letterSpacing: '0.04em', textTransform: 'uppercase', color,
      background: 'var(--surface-2)', border: '1px solid var(--border-2)',
      borderRadius: 3, whiteSpace: 'nowrap', lineHeight: 1.3,
    }}>
      {activity || '—'}
    </span>
  );
}

function LineChip({ id }) {
  if (!id) return <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--t4)' }}>—</span>;
  return (
    <span className="num" style={{ fontSize: 10, fontWeight: 700, color: lineColor(id),
      background: `rgba(${lineRgb(id)},0.12)`, borderRadius: 3, padding: '1px 5px' }}>{id}</span>
  );
}

// ── Corrections Page ──────────────────────────────────────────
export default function CorrectionsPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const { setRefreshing, setLastRefreshed } = useRefreshState();

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

  // ESC + backdrop-click close are handled internally by <Modal/>.

  const { scans, loading, reload } = useScans(
    { dateFrom: selectedDate, dateTo: selectedDate, showVoided },
    session
  );

  // Refresh-bar wiring
  useEffect(() => { setRefreshing(loading); }, [loading, setRefreshing]);
  useEffect(() => { if (!loading) setLastRefreshed(new Date()); }, [loading, setLastRefreshed]);

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
  const dateInput = { ...inputStyle, width: 'auto', padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 12.5, colorScheme: 'dark' };
  const searchInput = { ...inputStyle, width: 220, padding: '7px 11px', fontSize: 13 };
  const fieldStyle = { ...inputStyle, fontSize: 13 };
  const fieldLabel = { display: 'block', marginBottom: 6 };

  const actionBtn = (color) => ({
    padding: '4px 10px',
    background: 'var(--surface-2)',
    border: '1px solid var(--border-2)',
    borderRadius: 'var(--r-xs)',
    color,
    fontFamily: 'var(--font-display)',
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    cursor: 'pointer',
    marginRight: 6,
  });

  return (
    <>
      {/* Void modal */}
      <Modal
        open={!!voidModal}
        onClose={() => setVoidModal(null)}
        title="Void Scan — Tier 2"
        titleColor="var(--bad-fg)"
        confirmLabel={voidLoading ? 'Voiding…' : 'Confirm Void'}
        confirmColor="var(--red)"
        onConfirm={submitVoid}
        loading={voidLoading}
        error={voidError}
      >
        {voidModal && (
          <>
            <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-sm)', padding: 12, marginBottom: 16 }}>
              <div className="eyebrow" style={{ marginBottom: 5 }}>Scan</div>
              <div className="num" style={{ fontSize: 13, color: 'var(--yellow)' }}>{voidModal.upc}</div>
              <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t2)', marginTop: 4 }}>
                {voidModal.activity} · <span className="num">{voidModal.time}</span> · {voidModal.operator}
              </div>
            </div>
            <label className="eyebrow" style={fieldLabel}>
              Reason (required)
            </label>
            <textarea
              value={voidReason}
              onChange={e => setVoidReason(e.target.value)}
              rows={3}
              placeholder="Why is this scan being voided?"
              style={{ ...fieldStyle, resize: 'vertical' }}
            />
            {/* TODO: B-4 follow-up: shared <Modal> doesn't support disabling confirm based on body-state — empty-reason check now happens inside submitVoid which surfaces the error via Modal's error prop. */}
          </>
        )}
      </Modal>

      {/* Amend modal */}
      <Modal
        open={!!amendModal}
        onClose={() => setAmendModal(null)}
        title="Amend Scan — Tier 3"
        titleColor="var(--yellow)"
      >
        {amendModal && (
          <>
            <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-sm)', padding: 12, marginBottom: 16 }}>
              <div className="eyebrow" style={{ marginBottom: 5 }}>Scan</div>
              <div className="num" style={{ fontSize: 13, color: 'var(--yellow)' }}>{amendModal.upc}</div>
              <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t2)', marginTop: 4 }}>
                {amendModal.activity} · <span className="num">{amendModal.time}</span>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
              <div>
                <label className="eyebrow" style={fieldLabel}>Line</label>
                <input
                  value={amendLine}
                  onChange={e => setAmendLine(e.target.value)}
                  placeholder="L1 / L2 / L3"
                  style={fieldStyle}
                />
              </div>
              <div>
                <label className="eyebrow" style={fieldLabel}>Notes</label>
                <input
                  value={amendNotes}
                  onChange={e => setAmendNotes(e.target.value)}
                  placeholder="Optional notes"
                  style={fieldStyle}
                />
              </div>
            </div>

            <label className="eyebrow" style={fieldLabel}>
              Reason (required)
            </label>
            <textarea
              value={amendReason}
              onChange={e => setAmendReason(e.target.value)}
              rows={3}
              placeholder="Why is this scan being amended?"
              style={{ ...fieldStyle, resize: 'vertical' }}
            />
            {amendError && (
              <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--bad-fg)', marginTop: 8 }}>{amendError}</div>
            )}
            {/* TODO: B-4 follow-up: Modal lacks a `footer` slot — keeping inline buttons here to preserve the yellow-on-black brand style (Modal's built-in confirm renders white text). */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
              <button
                onClick={() => setAmendModal(null)}
                style={{ ...btnGhost, opacity: amendLoading ? 0.6 : 1 }}
                disabled={amendLoading}
              >
                Cancel
              </button>
              <button
                onClick={submitAmend}
                disabled={amendLoading || !amendReason.trim()}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 7,
                  background: 'var(--yellow)', color: '#1a1a1a', border: 'none',
                  borderRadius: 'var(--r-sm)', padding: '8px 14px',
                  fontFamily: 'var(--font-display)', fontSize: 12, fontWeight: 700,
                  letterSpacing: '0.05em', textTransform: 'uppercase', cursor: 'pointer',
                  opacity: (amendLoading || !amendReason.trim()) ? 0.5 : 1,
                }}
              >
                {amendLoading ? 'Saving…' : 'Confirm Amend'}
              </button>
            </div>
          </>
        )}
      </Modal>

      {/* Page content */}
      <div style={{ maxWidth: 1180, margin: '0 auto' }}>
        <InboxTabs />

        {/* Date bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
          <span className="eyebrow">Date</span>
          <input
            type="date"
            className="num"
            style={dateInput}
            value={selectedDate}
            onChange={e => setSelectedDate(e.target.value)}
          />
          <FilterChip onClick={() => setSelectedDate(todayStr())}>Today</FilterChip>
          <div style={{ flex: 1 }} />
          <input
            type="text"
            placeholder="Search UPC…"
            style={searchInput}
            value={upcSearch}
            onChange={e => setUpcSearch(e.target.value)}
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t2)', cursor: 'pointer' }}>
            <input type="checkbox" checked={showVoided} onChange={e => setShowVoided(e.target.checked)} />
            Show Voided
          </label>
        </div>

        {/* Activity filter row */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>
          {ACTIVITY_FILTERS.map(f => (
            <FilterChip
              key={f.value || 'all'}
              active={activityFilter === f.value}
              dot={f.value ? ACT_COLORS[f.value] : undefined}
              onClick={() => setActivityFilter(f.value)}
            >
              {f.label}
            </FilterChip>
          ))}
        </div>

        {/* Tier explainer */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 'var(--r-md)', padding: '12px 16px', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t2)' }}>
            <ToneBadge tone="bad">Tier 2 Void</ToneBadge> Supervisor can void scans from the current shift only. Reason required.
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t2)' }}>
            <ToneBadge tone="brand">Tier 3 Amend</ToneBadge> Manager can correct line, operator, or notes on any scan. Immutable audit trail created.
          </div>
        </div>

        {/* Table */}
        <Panel pad={8}>
          {loading ? (
            <div style={{ padding: '40px 0', display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : displayRows.length === 0 ? (
            <div style={{ padding: '36px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, color: 'var(--t3)' }}>
              <Icon name="edit" size={20} />
              <span style={{ fontFamily: 'var(--font-ui)', fontSize: 13 }}>No scans found</span>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {['Time','UPC','Activity','Line','Product','Operator','Loop','Status','Actions'].map(h => (
                      <th key={h} style={thStyle}><span className="eyebrow">{h}</span></th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {displayRows.map(s => {
                    const voided = !!s.voided;
                    return (
                      <tr key={s.id} style={{ opacity: voided ? 0.5 : 1 }}>
                        <td style={tdBase}><span className="num" style={{ fontSize: 11, color: 'var(--t3)' }}>{formatTime(s.timestamp)}</span></td>
                        <td style={tdBase}><span className="num" style={{ fontSize: 11.5, color: 'var(--yellow)' }}>{s.upc || '—'}</span></td>
                        <td style={tdBase}><ActivityBadge activity={s.activity} /></td>
                        <td style={tdBase}><LineChip id={s.line} /></td>
                        <td style={{ ...tdBase, fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--t1)' }}>{s.unit_product || '—'}</td>
                        <td style={{ ...tdBase, fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t2)' }}>{s.operator_name || (s.operator_id ? String(s.operator_id).slice(0, 8) : '—')}</td>
                        <td style={tdBase}><span className="num" style={{ fontSize: 12, color: 'var(--t2)' }}>{s.loop_count != null ? s.loop_count : '—'}</span></td>
                        <td style={tdBase}>
                          {voided
                            ? <ToneBadge tone="bad">Voided</ToneBadge>
                            : <ToneBadge tone="ok">OK</ToneBadge>}
                        </td>
                        <td style={tdBase}>
                          {voided ? (
                            <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--t4)' }}>—</span>
                          ) : (canVoid || canAmend) ? (
                            <>
                              {canVoid  && <button onClick={() => openVoid(s)}  style={actionBtn('var(--bad-fg)')}>Void</button>}
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
