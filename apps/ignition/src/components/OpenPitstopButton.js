'use client';
import { useState } from 'react';
import { Modal, useToast } from '@throttle/ui';
import { useAuth } from '@throttle/auth';
import { ignitionopsPost } from '../lib/ignitionopsFetch.js';

const DISPOSITIONS = ['replacement','refund','repair'];

export default function OpenPitstopButton({ engagement, onLinked }) {
  const { session } = useAuth();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [description, setDescription] = useState('');
  const [disposition, setDisposition] = useState('replacement');

  if (engagement?.cs_ticket_no) {
    return (
      <div style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '6px 10px', fontSize: 11,
        color: 'var(--state-error-fg)', background: 'var(--state-error-bg)',
        border: '1px solid var(--state-error-fg)', borderRadius: 'var(--radius-sm)',
        fontFamily: 'var(--font-mono)', fontWeight: 600, letterSpacing: '0.04em',
        textTransform: 'uppercase',
      }}>
        Damage → Pitstop {engagement.cs_ticket_no}
      </div>
    );
  }

  async function submit() {
    if (!description.trim()) return;
    setBusy(true);
    try {
      const res = await ignitionopsPost('openPitstopTicket', {
        engagement_id: engagement.id,
        issue_description: description,
        disposition,
      }, session);
      toast(`Pitstop ticket opened: ${res.ticket_no}`, 'success');
      setOpen(false);
      onLinked?.(res.ticket_no);
    } catch (e) {
      toast(`Failed: ${e.message}`, 'error');
    } finally { setBusy(false); }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        style={{
          padding: '6px 12px', fontSize: 11, fontWeight: 700,
          letterSpacing: '0.06em', textTransform: 'uppercase',
          background: 'transparent', color: 'var(--state-error-fg)',
          border: '1px solid var(--state-error-fg)', borderRadius: 'var(--radius-sm)',
          fontFamily: 'var(--font-mono)', cursor: 'pointer',
        }}
      >
        Flag Damage → Pitstop
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Open Pitstop Ticket">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 380 }}>
          <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
            This opens a real Pitstop ticket prefilled with influencer info from
            <strong style={{ color: 'var(--text-1)' }}> {engagement.engagement_no}</strong>.
            Manual handoff per RULE-IGN-004.
          </div>
          <div>
            <label style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              Disposition
            </label>
            <select
              value={disposition}
              onChange={(e) => setDisposition(e.target.value)}
              style={{
                width: '100%', marginTop: 6, padding: '8px 10px',
                background: 'var(--surface-2)', color: 'var(--text-1)',
                border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                fontFamily: 'var(--font-mono)', fontSize: 13,
              }}
            >
              {DISPOSITIONS.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              What happened?
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              placeholder="Damaged in transit, missing battery, etc."
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
              onClick={() => setOpen(false)}
              style={{
                padding: '8px 14px', background: 'transparent', color: 'var(--text-2)',
                border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer',
              }}
            >Cancel</button>
            <button
              onClick={submit}
              disabled={!description.trim() || busy}
              style={{
                padding: '8px 14px', background: '#DE2A2A', color: '#fff',
                border: 'none', borderRadius: 'var(--radius-sm)',
                fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700,
                cursor: description.trim() && !busy ? 'pointer' : 'not-allowed',
                opacity: description.trim() && !busy ? 1 : 0.5,
              }}
            >{busy ? 'Opening…' : 'Open Pitstop Ticket'}</button>
          </div>
        </div>
      </Modal>
    </>
  );
}
