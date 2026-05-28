'use client';
import { useState } from 'react';
import { Modal } from '@throttle/ui';
import { STAGE_LABELS, allowedTransitions } from '../lib/stages.js';

export default function AdvanceModal({ open, engagement, onClose, onAdvance }) {
  const [target, setTarget] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  if (!engagement) return null;

  const options = allowedTransitions(engagement.stage);

  async function submit() {
    if (!target) return;
    setBusy(true);
    try {
      await onAdvance({ to_stage: target, note: note || undefined });
      onClose();
    } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Advance ${engagement.engagement_no}`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 360 }}>
        <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
          Current stage: <strong style={{ color: 'var(--text-1)' }}>{STAGE_LABELS[engagement.stage]}</strong>
        </div>
        <div>
          <label style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Move to
          </label>
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            style={{
              width: '100%', marginTop: 6, padding: '8px 10px',
              background: 'var(--surface-2)', color: 'var(--text-1)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
              fontFamily: 'var(--font-mono)', fontSize: 13,
            }}
          >
            <option value="">— select —</option>
            {options.map(s => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
          </select>
        </div>
        <div>
          <label style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Note (optional)
          </label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            style={{
              width: '100%', marginTop: 6, padding: '8px 10px',
              background: 'var(--surface-2)', color: 'var(--text-1)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
              fontFamily: 'var(--font-mono)', fontSize: 13, resize: 'vertical',
            }}
          />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={onClose}
            style={{
              padding: '8px 14px', background: 'transparent', color: 'var(--text-2)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
              fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer',
            }}
          >Cancel</button>
          <button
            onClick={submit}
            disabled={!target || busy}
            style={{
              padding: '8px 14px', background: '#FF6B00', color: '#fff',
              border: 'none', borderRadius: 'var(--radius-sm)',
              fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700,
              cursor: target && !busy ? 'pointer' : 'not-allowed', opacity: target && !busy ? 1 : 0.5,
            }}
          >{busy ? 'Advancing…' : 'Advance'}</button>
        </div>
      </div>
    </Modal>
  );
}
