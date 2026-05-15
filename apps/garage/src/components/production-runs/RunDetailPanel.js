'use client';
import { useEffect, useState } from 'react';
import { ConfirmModal, EmptyState, Modal, Spinner, useToast } from '@throttle/ui';
import { garageFetch, workerFetch } from '@throttle/db';
import { ReceiptPanel } from './ReceiptPanel.js';
import { RejectRunModal } from './RejectRunModal.js';

const panel = { backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4 };
const panelHdr = {
  padding: '10px 16px', borderBottom: '1px solid var(--border)',
  fontFamily: 'var(--cond)', fontWeight: 700, fontSize: 13,
  textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--t2)',
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  gap: 12, flexWrap: 'wrap',
};
const th = {
  padding: '7px 10px', fontSize: 10, textAlign: 'left', color: 'var(--t3)',
  textTransform: 'uppercase', letterSpacing: '0.08em',
  borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
};
const td = { padding: '8px 10px', fontSize: 12, borderBottom: '1px solid rgba(42,42,42,.6)', whiteSpace: 'nowrap' };
const btnPri = {
  background: 'var(--yellow)', color: '#000', border: 'none', borderRadius: 4,
  padding: '6px 14px', fontFamily: 'var(--mono)', fontSize: 11,
  textTransform: 'uppercase', letterSpacing: 1, cursor: 'pointer', fontWeight: 700,
};
const btnSec = {
  background: 'var(--surface2)', color: 'var(--t2)', border: '1px solid var(--border)', borderRadius: 4,
  padding: '6px 14px', fontFamily: 'var(--mono)', fontSize: 11,
  textTransform: 'uppercase', letterSpacing: 1, cursor: 'pointer',
};
const btnDanger = {
  background: 'var(--red)', color: '#fff', border: 'none', borderRadius: 4,
  padding: '6px 14px', fontFamily: 'var(--mono)', fontSize: 11,
  textTransform: 'uppercase', letterSpacing: 1, cursor: 'pointer', fontWeight: 700,
};

const RECEIPT_TONES = {
  Confirmed: { bg: 'rgba(34,197,94,.08)', border: 'rgba(34,197,94,.3)', color: '#4ade80' },
  Resolved: { bg: 'rgba(34,197,94,.08)', border: 'rgba(34,197,94,.3)', color: '#4ade80' },
  'Short-Pending': { bg: 'rgba(255,140,0,.08)', border: 'rgba(255,140,0,.3)', color: '#ffaa33' },
  'Re-appealed': { bg: 'rgba(255,140,0,.08)', border: 'rgba(255,140,0,.3)', color: '#ffaa33' },
  Contested: { bg: 'rgba(222,42,42,.08)', border: 'rgba(222,42,42,.3)', color: '#ff7070' },
  Locked: { bg: 'rgba(222,42,42,.08)', border: 'rgba(222,42,42,.3)', color: '#ff7070' },
};

function statusColor(status) {
  switch (status) {
    case 'Draft': return 'var(--t3)';
    case 'Submitted': return 'var(--blue)';
    case 'Issued':
    case 'In Progress': return 'var(--yellow)';
    case 'Completed': return 'var(--green)';
    case 'Rejected': return 'var(--red)';
    case 'Cancelled': return 'var(--t3)';
    default: return 'var(--t2)';
  }
}

function chip(text, color) {
  return (
    <span
      style={{
        display: 'inline-block', padding: '3px 8px', borderRadius: 3,
        background: 'rgba(80,80,80,.15)', border: '1px solid rgba(80,80,80,.25)',
        fontFamily: 'var(--mono)', fontSize: 11, color: color || 'var(--t2)',
        marginRight: 6, marginBottom: 6,
      }}
    >
      {text}
    </span>
  );
}

export function RunDetailPanel({ runNo, onClose, onRunChange, session, perms }) {
  const { showToast } = useToast();
  const [runData, setRunData] = useState(null);
  const [receipts, setReceipts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [receiptPanelMode, setReceiptPanelMode] = useState(null);

  const [forceResolveOpen, setForceResolveOpen] = useState(false);
  const [forceResolveReason, setForceResolveReason] = useState('');
  const [forceResolveError, setForceResolveError] = useState(null);
  const [forceResolveSubmitting, setForceResolveSubmitting] = useState(false);

  async function load() {
    if (!runNo || !session) return;
    setLoading(true);
    setError(null);
    try {
      const [run, allReceipts] = await Promise.all([
        garageFetch('getProductionRun', { run_no: runNo }, session),
        garageFetch('getIssueReceipts', {}, session),
      ]);
      setRunData(run);
      setReceipts(Array.isArray(allReceipts) ? allReceipts : []);
    } catch (e) {
      setError(e.message || 'Failed to load run');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [runNo, session]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading && !runData) {
    return (
      <div id="pr-detail-panel" style={{ ...panel, marginTop: 16, padding: 32, textAlign: 'center' }}>
        <Spinner />
      </div>
    );
  }
  if (error) {
    return (
      <div id="pr-detail-panel" style={{ ...panel, marginTop: 16 }}>
        <div style={{ padding: 16 }}>
          <EmptyState message={error} />
          <div style={{ textAlign: 'center', marginTop: 12, display: 'flex', gap: 8, justifyContent: 'center' }}>
            <button style={btnSec} onClick={load}>Retry</button>
            <button style={btnSec} onClick={onClose}>✕ Close</button>
          </div>
        </div>
      </div>
    );
  }
  if (!runData?.run) return null;

  const run = runData.run;
  const wos = runData.wos || [];
  const pickList = runData.pick_list || [];
  const issueNo = runData.issue_no || null;
  const receipt = receipts.find((r) => r.run_id === run.id) || null;

  const showCancel = ['Draft', 'Submitted'].includes(run.status);
  const showConfirmReceipt = run.status === 'Issued' && !receipt;
  const showReject = run.status === 'Issued' && !receipt;
  const showReappeal = receipt && receipt.status === 'Contested';
  const showForceResolve = receipt && receipt.status === 'Locked' && !!perms?.procurement_approve;

  const totalUnits = pickList.reduce((s, p) => s + (Number(p.total_qty) || 0), 0);
  const shortCount = pickList.filter((p) => (Number(p.shortfall) || 0) > 0).length;

  async function handleCancel() {
    setCancelling(true);
    try {
      await workerFetch('cancelProductionRun', { data: { run_no: run.run_no } }, session);
      showToast(`Run ${run.run_no} cancelled`, 'success');
      setCancelOpen(false);
      onRunChange(run.run_no);
    } catch (e) {
      showToast(e.message || 'Cancel failed', 'error');
    } finally {
      setCancelling(false);
    }
  }

  async function handleForceResolve() {
    if (!forceResolveReason.trim()) {
      setForceResolveError('Reason is required');
      return;
    }
    setForceResolveSubmitting(true);
    setForceResolveError(null);
    try {
      await workerFetch(
        'forceResolveReceipt',
        { data: { receipt_id: receipt.receipt_id, reason: forceResolveReason.trim() } },
        session,
      );
      showToast('Receipt force-resolved', 'success');
      setForceResolveOpen(false);
      setForceResolveReason('');
      onRunChange(run.run_no);
    } catch (e) {
      setForceResolveError(e.message || 'Force resolve failed');
      setForceResolveSubmitting(false);
    }
  }

  const receiptTone = receipt ? (RECEIPT_TONES[receipt.status] || RECEIPT_TONES.Contested) : null;
  const isRejectedNote = run.notes && run.notes.includes('[REJECTED');

  return (
    <div id="pr-detail-panel" style={{ ...panel, marginTop: 16 }}>
      <div style={panelHdr}>
        <span>
          <span style={{ fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{run.run_no}</span>
          <span style={{ color: 'var(--t3)', margin: '0 8px' }}>—</span>
          <span>{run.product || '—'}</span>
          <span style={{ color: 'var(--t3)', margin: '0 8px' }}>—</span>
          <span style={{ color: statusColor(run.status), fontWeight: 700 }}>{run.status}</span>
        </span>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {showCancel && (
            <button style={btnSec} onClick={() => setCancelOpen(true)}>Cancel Run</button>
          )}
          {showReject && (
            <button style={btnSec} onClick={() => setRejectOpen(true)}>Reject Run</button>
          )}
          {showConfirmReceipt && (
            <button style={btnPri} onClick={() => setReceiptPanelMode('confirm')}>Confirm Receipt</button>
          )}
          {showReappeal && (
            <button style={btnSec} onClick={() => setReceiptPanelMode('reappeal')}>Re-Appeal</button>
          )}
          {showForceResolve && (
            <button style={btnDanger} onClick={() => setForceResolveOpen(true)}>Force Resolve</button>
          )}
          <button style={btnSec} onClick={onClose}>✕ Close</button>
        </div>
      </div>

      <div style={{ padding: 16 }}>
        {/* Outsourced vendor info */}
        {run.run_type === 'outsourced' && (
          <div
            style={{
              marginBottom: 16, padding: '10px 12px', borderRadius: 4,
              background: 'rgba(245,158,11,.08)', border: '1px solid rgba(245,158,11,.3)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span
                style={{
                  padding: '2px 8px', borderRadius: 2, fontFamily: 'var(--mono)', fontSize: 10,
                  textTransform: 'uppercase', letterSpacing: '.06em',
                  background: 'rgba(245,158,11,.15)', color: '#fbbf24',
                  border: '1px solid rgba(245,158,11,.3)',
                }}
              >
                Outsourced
              </span>
              <span style={{ fontSize: 13, color: 'var(--t1)', fontWeight: 600 }}>
                {run.vendor?.vendor_name || '—'}
              </span>
              {run.vendor?.vendor_code && (
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>
                  {run.vendor.vendor_code}
                </span>
              )}
            </div>
          </div>
        )}

        {/* WOs in this run */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
            Work Orders in this Run
          </div>
          {wos.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--t3)' }}>No work orders</div>
          ) : (
            <div>
              {wos.map((wo) => {
                const variantLabel = wo.variant || 'Common';
                const colourLabel = wo.colour ? ` ${wo.colour}` : '';
                const splitText =
                  wo.qty_ecomm != null || wo.qty_retail != null
                    ? `E:${wo.qty_ecomm || 0} R:${wo.qty_retail || 0}`
                    : '';
                return (
                  <span
                    key={wo.wo_no}
                    style={{
                      display: 'inline-block', padding: '4px 8px', marginRight: 6, marginBottom: 6,
                      background: '#1a1a1a', border: '1px solid var(--border)', borderRadius: 3,
                      fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--yellow)',
                    }}
                  >
                    {wo.wo_no} · {variantLabel}{colourLabel} · {wo.qty} units
                    {splitText && (
                      <span style={{ color: 'var(--t3)', marginLeft: 6 }}>{splitText}</span>
                    )}
                  </span>
                );
              })}
            </div>
          )}
        </div>

        {/* Receipt status banner */}
        {receipt && receiptTone && (
          <div
            style={{
              padding: 12, marginBottom: 16, borderRadius: 4,
              background: receiptTone.bg, border: `1px solid ${receiptTone.border}`,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
              <span
                style={{
                  padding: '2px 8px', borderRadius: 2, fontFamily: 'var(--mono)', fontSize: 10,
                  textTransform: 'uppercase', letterSpacing: '.04em',
                  background: receiptTone.bg, color: receiptTone.color, border: `1px solid ${receiptTone.border}`,
                }}
              >
                {receipt.status}
              </span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t1)' }}>
                {receipt.receipt_id}
              </span>
              {receipt.confirmed_by && (
                <span style={{ fontSize: 11, color: 'var(--t3)' }}>
                  Confirmed by {receipt.confirmed_by}
                </span>
              )}
            </div>
            {(() => {
              const shorts = (receipt.lines || []).filter((l) => Number(l.variance) < 0);
              if (!shorts.length) return null;
              return (
                <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
                  <thead>
                    <tr>
                      <th style={th}>Part Code</th>
                      <th style={th}>Part Name</th>
                      <th style={{ ...th, textAlign: 'right' }}>Issued</th>
                      <th style={{ ...th, textAlign: 'right' }}>Received</th>
                      <th style={{ ...th, textAlign: 'right' }}>Variance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shorts.map((l, i) => (
                      <tr key={i}>
                        <td style={{ ...td, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{l.part_code}</td>
                        <td style={td}>{l.part_name || '—'}</td>
                        <td style={{ ...td, fontFamily: 'var(--mono)', textAlign: 'right' }}>{l.qty_issued}</td>
                        <td style={{ ...td, fontFamily: 'var(--mono)', textAlign: 'right' }}>{l.qty_received}</td>
                        <td style={{ ...td, fontFamily: 'var(--mono)', textAlign: 'right', color: 'var(--red)' }}>
                          {l.variance}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              );
            })()}
          </div>
        )}

        {/* Pick list */}
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
          Consolidated Pick List
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          {chip(`Parts: ${pickList.length}`)}
          {chip(`Short: ${shortCount}`, shortCount > 0 ? 'var(--red)' : 'var(--green)')}
          {chip(`Total units: ${totalUnits}`)}
        </div>
        {pickList.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--t3)' }}>No pick list yet</div>
        ) : (
          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 4 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={th}>Part Code</th>
                  <th style={th}>Part Name</th>
                  <th style={th}>Type</th>
                  <th style={{ ...th, textAlign: 'right' }}>Required</th>
                  <th style={{ ...th, textAlign: 'right' }}>In Stock</th>
                  <th style={{ ...th, textAlign: 'right' }}>Shortfall</th>
                  <th style={th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {pickList.map((p, i) => {
                  const required = Number(p.total_qty) || 0;
                  const stock = Number(p.in_stock) || 0;
                  const shortfall = Number(p.shortfall) || 0;
                  const isShort = shortfall > 0;
                  return (
                    <tr key={i}>
                      <td style={{ ...td, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{p.part_code}</td>
                      <td style={td}>{p.part_name || '—'}</td>
                      {/* TD-019-A: part_type not returned by getProductionRun; show '—' */}
                      <td style={{ ...td, color: 'var(--t3)' }}>—</td>
                      <td style={{ ...td, fontFamily: 'var(--mono)', textAlign: 'right' }}>{required}</td>
                      <td style={{ ...td, fontFamily: 'var(--mono)', textAlign: 'right' }}>{stock}</td>
                      <td style={{ ...td, fontFamily: 'var(--mono)', textAlign: 'right' }}>
                        {isShort
                          ? <span style={{ color: 'var(--red)' }}>-{shortfall}</span>
                          : <span style={{ color: 'var(--green)' }}>—</span>}
                      </td>
                      <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 11 }}>
                        {isShort
                          ? <span style={{ color: 'var(--red)' }}>SHORT</span>
                          : <span style={{ color: 'var(--green)' }}>OK</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Rejection notes */}
        {isRejectedNote && (
          <div
            style={{
              marginTop: 16, padding: 12, borderRadius: 4,
              background: 'rgba(222,42,42,.06)', border: '1px solid rgba(222,42,42,.25)',
            }}
          >
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--red)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>
              Rejection Notes
            </div>
            <div style={{ fontSize: 12, color: 'var(--t1)', whiteSpace: 'pre-wrap' }}>{run.notes}</div>
          </div>
        )}

        {/* Receipt panel inline */}
        {receiptPanelMode && (
          <ReceiptPanel
            mode={receiptPanelMode}
            run={run}
            pickList={pickList}
            receipt={receipt}
            issueNo={issueNo}
            session={session}
            onClose={() => setReceiptPanelMode(null)}
            onSuccess={() => {
              setReceiptPanelMode(null);
              onRunChange(run.run_no);
            }}
          />
        )}
      </div>

      <ConfirmModal
        open={cancelOpen}
        onClose={() => !cancelling && setCancelOpen(false)}
        title={`Cancel ${run.run_no}`}
        message={`Cancel run ${run.run_no}? This cannot be undone.`}
        confirmLabel={cancelling ? 'CANCELLING…' : 'Cancel Run'}
        confirmColor="red"
        onConfirm={handleCancel}
        loading={cancelling}
      />

      <RejectRunModal
        open={rejectOpen}
        runNo={run.run_no}
        session={session}
        onClose={() => setRejectOpen(false)}
        onSuccess={() => {
          setRejectOpen(false);
          onRunChange(run.run_no);
        }}
      />

      <Modal
        open={forceResolveOpen}
        onClose={() => !forceResolveSubmitting && setForceResolveOpen(false)}
        title={`Force Resolve — ${receipt?.receipt_id || ''}`}
        confirmLabel={forceResolveSubmitting ? 'RESOLVING…' : 'Force Resolve'}
        confirmColor="red"
        onConfirm={handleForceResolve}
        loading={forceResolveSubmitting}
        error={forceResolveError}
      >
        <div>
          <label
            style={{
              display: 'block', fontFamily: 'var(--mono)', fontSize: 10,
              color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6,
            }}
          >
            Reason *
          </label>
          <textarea
            value={forceResolveReason}
            onChange={(e) => setForceResolveReason(e.target.value)}
            rows={4}
            placeholder="Why is this receipt being force-resolved?"
            style={{
              width: '100%', background: 'var(--surface)', color: 'var(--t1)',
              border: '1px solid var(--border)', borderRadius: 4, padding: '8px 10px',
              fontFamily: 'var(--mono)', fontSize: 12, resize: 'vertical',
            }}
            disabled={forceResolveSubmitting}
          />
        </div>
      </Modal>
    </div>
  );
}
