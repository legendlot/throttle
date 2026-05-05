'use client';
import { useEffect, useMemo, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { todayStr } from '@throttle/domain';

const TONE_STYLES = {
  yellow: { bg: 'rgba(242,205,26,.12)', fg: '#f2cd1a', border: 'rgba(242,205,26,.2)' },
  green:  { bg: 'rgba(34,197,94,.12)',  fg: '#4ade80', border: 'rgba(34,197,94,.2)' },
  red:    { bg: 'rgba(222,42,42,.15)',  fg: '#ff7070', border: 'rgba(222,42,42,.25)' },
  orange: { bg: 'rgba(255,140,0,.15)',  fg: '#ffaa33', border: 'rgba(255,140,0,.25)' },
  gray:   { bg: 'rgba(80,80,80,.2)',    fg: '#aaa',    border: 'rgba(80,80,80,.3)' },
};

function StatusBadge({ label, tone = 'gray' }) {
  const s = TONE_STYLES[tone] || TONE_STYLES.gray;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 6px', borderRadius: 2,
      fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.04em',
      textTransform: 'uppercase',
      background: s.bg, color: s.fg, border: `1px solid ${s.border}`,
    }}>{label}</span>
  );
}

function lossTypeTone(t) {
  const v = (t || '').toLowerCase();
  if (v === 'damage') return 'orange';
  if (v === 'rejection') return 'red';
  if (v === 'scrap') return 'red';
  return 'gray';
}

function lossStatusTone(s) {
  const v = (s || '').toLowerCase();
  if (v === 'pending') return 'yellow';
  if (v === 'approved') return 'green';
  if (v === 'rejected') return 'red';
  return 'gray';
}

const panelStyle       = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const panelHeaderStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)', gap: 8, flexWrap: 'wrap' };
const tableThStyle     = { padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const tableTdStyle     = { padding: '9px 10px', borderBottom: '1px solid rgba(42,42,42,.6)', fontSize: 12, whiteSpace: 'nowrap' };
const inputStyle       = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px', fontSize: 12, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit' };
const labelStyle       = { fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block' };
const btnPrimary       = { background: 'var(--yellow)', border: '1px solid var(--yellow)', borderRadius: 3, padding: '7px 16px', fontSize: 12, fontWeight: 700, color: '#000', cursor: 'pointer', fontFamily: 'var(--cond)', letterSpacing: '0.04em' };
const btnSecondary     = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 12px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)' };
const btnDanger        = { background: '#ef4444', border: '1px solid #ef4444', borderRadius: 3, padding: '7px 16px', fontSize: 12, fontWeight: 700, color: '#fff', cursor: 'pointer', fontFamily: 'var(--cond)', letterSpacing: '0.04em' };

const filterBtn = (active) => ({
  background: active ? 'var(--yellow)' : 'var(--surface2)',
  color: active ? '#000' : 'var(--t3)',
  border: active ? '1px solid var(--yellow)' : '1px solid var(--border)',
  borderRadius: 3, padding: '5px 12px', fontFamily: 'var(--mono)', fontSize: 11,
  textTransform: 'uppercase', letterSpacing: 1, cursor: 'pointer', fontWeight: active ? 700 : 500,
});

function formatDate(raw) {
  if (!raw) return '—';
  const d = new Date(raw);
  if (isNaN(d)) return String(raw).slice(0, 10);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function defaultFromDate() {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
}

export default function LossesPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();

  const [rows, setRows] = useState([]);
  const [filter, setFilter] = useState(''); // '' | 'pending'
  const [fromDate, setFromDate] = useState(defaultFromDate());
  const [toDate, setToDate] = useState(todayStr());
  const [loading, setLoading] = useState(true);

  const [reviewingNote, setReviewingNote] = useState(null);
  const [approvalNotes, setApprovalNotes] = useState('');
  const [lnErr, setLnErr] = useState('');
  const [lnSubmitting, setLnSubmitting] = useState(false);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const params = { from: fromDate, to: toDate };
      if (filter) params.status = filter;
      const data = await garageFetch('getLossNotes', params, session);
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      // Endpoint not yet available — show empty state, no error toast
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [session, filter, fromDate, toDate]);

  useEffect(() => { load(); }, [load]);

  const pendingCount = useMemo(
    () => rows.filter((r) => (r.status || '').toLowerCase() === 'pending').length,
    [rows]
  );

  function openReview(note) {
    setReviewingNote(note);
    setApprovalNotes('');
    setLnErr('');
  }

  async function submitDecision(decision) {
    if (!reviewingNote) return;
    setLnSubmitting(true);
    setLnErr('');
    try {
      await workerFetch('approveLossNote', {
        data: {
          loss_note_id: reviewingNote.loss_note_id,
          decision,
          notes: approvalNotes || null,
        },
      }, session);
      showToast(`${reviewingNote.loss_note_id} ${decision}`, 'success');
      setReviewingNote(null);
      load();
    } catch (e) {
      const msg = e.message || '';
      // Worker action missing → graceful fallback
      if (/Unknown action|not found|404/i.test(msg)) {
        showToast('Not yet available', 'error');
      } else {
        setLnErr(msg || 'Failed to record decision');
      }
    } finally {
      setLnSubmitting(false);
    }
  }

  if (perms && !perms.returns) {
    return <div style={{ padding: 24, color: 'var(--t3)' }}>Access restricted.</div>;
  }

  return (
    <div style={{ color: 'var(--t1)' }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontFamily: 'var(--cond)', fontSize: 28, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.03em', margin: 0 }}>
          Loss Notes
          {pendingCount > 0 && <span style={{ marginLeft: 12, fontSize: 12, color: 'var(--yellow)', fontFamily: 'var(--mono)', letterSpacing: '0.04em' }}>({pendingCount} pending)</span>}
        </h1>
        <p style={{ color: 'var(--t3)', fontSize: 11, marginTop: 4, fontFamily: 'var(--mono)' }}>
          Damage / rejection / scrap notes raised during inspection. Approve or reject pending ones.
        </p>
      </div>

      <div style={panelStyle}>
        <div style={panelHeaderStyle}>
          <div style={{ display: 'flex', gap: 6 }}>
            <button style={filterBtn(filter === 'pending')} onClick={() => setFilter('pending')}>Pending Approval</button>
            <button style={filterBtn(filter === '')} onClick={() => setFilter('')}>All</button>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} style={{ ...inputStyle, fontFamily: 'var(--mono)' }} />
            <span style={{ color: 'var(--t3)', fontSize: 10 }}>→</span>
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} style={{ ...inputStyle, fontFamily: 'var(--mono)' }} />
            <button style={btnSecondary} onClick={load} disabled={loading}>↻</button>
          </div>
        </div>

        <div style={{ overflowX: 'auto' }}>
          {loading ? (
            <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : rows.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>
              No loss notes
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={tableThStyle}>Loss Note ID</th>
                <th style={tableThStyle}>Type</th>
                <th style={tableThStyle}>Unit / UPC</th>
                <th style={tableThStyle}>Description</th>
                <th style={tableThStyle}>Raised By</th>
                <th style={tableThStyle}>Date</th>
                <th style={tableThStyle}>Status</th>
                <th style={{ ...tableThStyle, textAlign: 'right' }}></th>
              </tr></thead>
              <tbody>
                {rows.map((r) => {
                  const status = (r.status || '').toLowerCase();
                  const ref = r.return_unit_id || r.car_upc || r.upc_found || '—';
                  return (
                    <tr key={r.loss_note_id}>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{r.loss_note_id}</td>
                      <td style={tableTdStyle}><StatusBadge label={r.loss_type || '—'} tone={lossTypeTone(r.loss_type)} /></td>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontSize: 11 }}>{ref}</td>
                      <td style={{ ...tableTdStyle, whiteSpace: 'normal', maxWidth: 360 }}>{r.description || '—'}</td>
                      <td style={tableTdStyle}>{r.raised_by || '—'}</td>
                      <td style={tableTdStyle}>{formatDate(r.created_at)}</td>
                      <td style={tableTdStyle}><StatusBadge label={r.status || '—'} tone={lossStatusTone(r.status)} /></td>
                      <td style={{ ...tableTdStyle, textAlign: 'right' }}>
                        {status === 'pending' && (
                          <button style={btnPrimary} onClick={() => openReview(r)}>Review</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {reviewingNote && (
        <div
          onClick={() => !lnSubmitting && setReviewingNote(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9000, padding: 16 }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ background: '#111', border: '1px solid #333', borderRadius: 6, padding: 20, color: '#eee', minWidth: 480, maxWidth: 600 }}>
            <h3 style={{ margin: 0, marginBottom: 6, color: 'var(--yellow)', fontSize: 14, fontFamily: 'var(--cond)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
              Loss Note — {reviewingNote.loss_note_id}
            </h3>
            <div style={{ fontSize: 11, color: 'var(--t3)', marginBottom: 12, fontFamily: 'var(--mono)' }}>
              <StatusBadge label={reviewingNote.loss_type || '—'} tone={lossTypeTone(reviewingNote.loss_type)} />
              {' · '}{reviewingNote.return_unit_id || reviewingNote.car_upc || reviewingNote.upc_found || '—'}
              {' · '}raised by {reviewingNote.raised_by || '—'}
            </div>
            <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: 10, fontSize: 12, lineHeight: 1.6, color: 'var(--t1)', marginBottom: 12 }}>
              {reviewingNote.description || '—'}
            </div>
            <span style={labelStyle}>Approval Notes (optional)</span>
            <textarea
              value={approvalNotes}
              onChange={(e) => setApprovalNotes(e.target.value)}
              rows={2}
              style={{ ...inputStyle, width: '100%', resize: 'vertical' }}
              disabled={lnSubmitting}
            />
            {lnErr && <div style={{ color: '#ff7070', fontSize: 11, marginTop: 6, fontFamily: 'var(--mono)' }}>{lnErr}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 12 }}>
              <button style={btnSecondary} onClick={() => setReviewingNote(null)} disabled={lnSubmitting}>Cancel</button>
              <button style={btnDanger} onClick={() => submitDecision('rejected')} disabled={lnSubmitting}>
                {lnSubmitting ? '…' : 'Reject'}
              </button>
              <button style={btnPrimary} onClick={() => submitDecision('approved')} disabled={lnSubmitting}>
                {lnSubmitting ? '…' : 'Approve'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
