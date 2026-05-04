'use client';
import { useEffect, useState } from 'react';
import { Modal, useToast } from '@throttle/ui';
import { workerFetch } from '@throttle/db';

export function RejectRunModal({ open, runNo, onClose, onSuccess, session }) {
  const { showToast } = useToast();
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setReason('');
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  async function handleConfirm() {
    if (!reason.trim()) {
      setError('Rejection reason is required');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await workerFetch('rejectProductionRun', { data: { run_no: runNo, reason: reason.trim() } }, session);
      showToast(`Run ${runNo} rejected`, 'success');
      onSuccess();
    } catch (e) {
      setError(e.message || 'Failed to reject run');
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`REJECT RUN — ${runNo || ''}`}
      titleColor="var(--yellow)"
      confirmLabel={submitting ? 'REJECTING...' : 'REJECT RUN'}
      confirmColor="red"
      onConfirm={handleConfirm}
      loading={submitting}
      error={error}
    >
      <div>
        <label
          style={{
            display: 'block',
            fontFamily: 'var(--mono)',
            fontSize: 10,
            color: 'var(--t3)',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            marginBottom: 6,
          }}
        >
          Rejection reason *
        </label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={4}
          placeholder="Enter reason for rejecting this run…"
          style={{
            width: '100%',
            background: 'var(--surface)',
            color: 'var(--t1)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: '8px 10px',
            fontFamily: 'var(--mono)',
            fontSize: 12,
            resize: 'vertical',
          }}
          disabled={submitting}
        />
      </div>
    </Modal>
  );
}
