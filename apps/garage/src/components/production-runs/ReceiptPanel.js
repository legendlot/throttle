'use client';
import { useEffect, useMemo, useState } from 'react';
import { useToast } from '@throttle/ui';
import { workerFetch } from '@throttle/db';

const panel = { backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4 };
const panelHdr = {
  padding: '10px 16px', borderBottom: '1px solid var(--border)',
  fontFamily: 'var(--cond)', fontWeight: 700, fontSize: 13,
  textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--t2)',
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
};
const th = {
  padding: '8px 10px', fontSize: 10, textAlign: 'left', color: 'var(--t3)',
  textTransform: 'uppercase', letterSpacing: '0.08em',
  borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
};
const td = { padding: '8px 10px', fontSize: 12, borderBottom: '1px solid rgba(42,42,42,.6)', whiteSpace: 'nowrap' };
const btnPri = {
  background: 'var(--yellow)', color: '#000', border: 'none', borderRadius: 4,
  padding: '7px 16px', fontFamily: 'var(--mono)', fontSize: 12,
  textTransform: 'uppercase', letterSpacing: 1, cursor: 'pointer', fontWeight: 700,
};
const btnSec = {
  background: 'var(--surface2)', color: 'var(--t2)', border: '1px solid var(--border)', borderRadius: 4,
  padding: '7px 16px', fontFamily: 'var(--mono)', fontSize: 12,
  textTransform: 'uppercase', letterSpacing: 1, cursor: 'pointer',
};
const qtyInputStyle = {
  background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 2,
  padding: '4px 6px', color: 'var(--t1)', fontFamily: 'var(--mono)', fontSize: 12,
  width: 80, textAlign: 'right',
};

function VarianceCell({ value }) {
  if (value === 0) return <span style={{ color: 'var(--t3)' }}>—</span>;
  if (value < 0) return <span style={{ color: 'var(--red)', fontFamily: 'var(--mono)' }}>{value}</span>;
  return <span style={{ color: 'var(--green)', fontFamily: 'var(--mono)' }}>+{value}</span>;
}

export function ReceiptPanel({ mode, run, pickList, receipt, issueNo, onClose, onSuccess, session }) {
  const { showToast } = useToast();
  const [lines, setLines] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (mode === 'confirm') {
      const initial = (pickList || []).map((p) => ({
        part_code: p.part_code,
        part_name: p.part_name,
        qty_issued: Number(p.total_qty) || 0,
        qty_received: Number(p.total_qty) || 0,
      }));
      setLines(initial);
    } else if (mode === 'reappeal') {
      const shorts = (receipt?.lines || []).filter((l) => Number(l.variance) < 0);
      const initial = shorts.map((l) => ({
        part_code: l.part_code,
        part_name: l.part_name,
        qty_issued: Number(l.qty_issued) || 0,
        prev_received: Number(l.qty_received) || 0,
        qty_received: Number(l.qty_received) || 0,
      }));
      setLines(initial);
    }
    setError(null);
    setSubmitting(false);
  }, [mode, pickList, receipt]);

  function updateLine(idx, value) {
    const num = parseInt(value, 10);
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, qty_received: isNaN(num) ? 0 : num } : l)));
  }

  function fillAllAsIssued() {
    setLines((prev) => prev.map((l) => ({ ...l, qty_received: l.qty_issued })));
  }

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      if (mode === 'confirm') {
        const payload = {
          run_no: run.run_no,
          issue_no: issueNo,
          lines: lines.map((l) => ({
            part_code: l.part_code,
            part_name: l.part_name,
            qty_issued: l.qty_issued,
            qty_received: l.qty_received,
          })),
        };
        const res = await workerFetch('postIssueReceipt', { data: payload }, session);
        if (res.data?.status === 'Confirmed') {
          showToast('Receipt confirmed — all quantities match', 'success');
        } else {
          const shortLines = res.data?.short_lines ?? '?';
          const shortWo = res.data?.short_wo ?? '?';
          showToast(`Receipt submitted — ${shortLines} part(s) short. Short Issue WO ${shortWo} raised for store.`, 'success');
        }
        onSuccess();
      } else {
        const payload = {
          receipt_id: receipt.receipt_id,
          lines: lines.map((l) => ({
            part_code: l.part_code,
            part_name: l.part_name,
            qty_issued: l.qty_issued,
            qty_received: l.qty_received,
          })),
        };
        const res = await workerFetch('reappealIssueReceipt', { data: payload }, session);
        const newWo = res.data?.new_wo ?? '?';
        showToast(`Re-appeal submitted — Short Issue WO ${newWo} raised for store`, 'success');
        onSuccess();
      }
    } catch (e) {
      setError(e.message || 'Submit failed');
      setSubmitting(false);
    }
  }

  const isConfirm = mode === 'confirm';
  const title = isConfirm
    ? `Confirm Receipt — ${run?.run_no || ''}`
    : `Re-Appeal — ${receipt?.receipt_id || ''}`;
  const subText = isConfirm
    ? 'Enter the actual quantity received for each part. Leave unchanged if correct.'
    : 'Store has contested this receipt. Update the quantities you believe were received and re-submit.';

  return (
    <div style={{ ...panel, marginTop: 16, border: isConfirm ? '1px solid var(--border)' : '1px solid rgba(255,140,0,0.35)' }}>
      <div style={panelHdr}>
        <span>{title}</span>
        <button style={{ ...btnSec, padding: '2px 10px', fontSize: 11 }} onClick={onClose}>✕ Close</button>
      </div>
      <div style={{ padding: 16 }}>
        <p
          style={{
            fontSize: 11,
            color: isConfirm ? 'var(--t3)' : 'var(--orange)',
            marginBottom: 12,
          }}
        >
          {subText}
        </p>

        {lines.length === 0 ? (
          <div style={{ padding: 12, color: 'var(--t3)', fontSize: 12 }}>No lines to display.</div>
        ) : (
          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 4 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={th}>Part Code</th>
                  <th style={th}>Part Name</th>
                  <th style={{ ...th, textAlign: 'right' }}>Issued</th>
                  {!isConfirm && <th style={{ ...th, textAlign: 'right' }}>Prev. Received</th>}
                  <th style={{ ...th, textAlign: 'right' }}>{isConfirm ? 'Received' : 'Updated Received'}</th>
                  <th style={{ ...th, textAlign: 'right' }}>Variance</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => {
                  const variance = (Number(l.qty_received) || 0) - (Number(l.qty_issued) || 0);
                  return (
                    <tr key={i}>
                      <td style={{ ...td, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{l.part_code}</td>
                      <td style={td}>{l.part_name || '—'}</td>
                      <td style={{ ...td, fontFamily: 'var(--mono)', textAlign: 'right' }}>{l.qty_issued}</td>
                      {!isConfirm && (
                        <td style={{ ...td, fontFamily: 'var(--mono)', textAlign: 'right', color: 'var(--t3)' }}>
                          {l.prev_received}
                        </td>
                      )}
                      <td style={{ ...td, textAlign: 'right' }}>
                        <input
                          type="number"
                          min="0"
                          value={l.qty_received}
                          onChange={(e) => updateLine(i, e.target.value)}
                          style={qtyInputStyle}
                          disabled={submitting}
                        />
                      </td>
                      <td style={{ ...td, textAlign: 'right' }}>
                        <VarianceCell value={variance} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {error && (
          <div style={{ marginTop: 12, fontSize: 12, color: 'var(--red)' }}>{error}</div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          {isConfirm && (
            <button style={btnSec} onClick={fillAllAsIssued} disabled={submitting}>
              All As Issued
            </button>
          )}
          <button style={btnPri} onClick={handleSubmit} disabled={submitting || lines.length === 0}>
            {submitting
              ? (isConfirm ? 'CONFIRMING…' : 'SUBMITTING…')
              : (isConfirm ? 'Confirm Receipt' : 'Submit Re-Appeal')}
          </button>
        </div>
      </div>
    </div>
  );
}
