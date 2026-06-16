'use client';
import { useState } from 'react';
import { Modal } from '@throttle/ui';
import { STAGE_LABELS, allowedTransitions } from '../lib/stages.js';

const fieldStyle = {
  width: '100%', marginTop: 6, padding: '8px 10px',
  background: 'var(--surface-2)', color: 'var(--text-1)',
  border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
  fontFamily: 'var(--font-mono)', fontSize: 13,
};
const lblStyle = { fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.08em' };

export default function AdvanceModal({ open, engagement, onClose, onAdvance }) {
  const [target, setTarget] = useState('');
  const [note, setNote] = useState('');
  const [videoLink, setVideoLink] = useState('');
  const [trackChoice, setTrackChoice] = useState('on_track'); // on_track | delayed (#10)
  const [revisedDate, setRevisedDate] = useState('');
  const [busy, setBusy] = useState(false);
  if (!engagement) return null;

  const options = allowedTransitions(engagement.stage);
  const needsVideoLink = target === 'live';                 // #4
  const isSchedule     = target === 'scheduled';            // #10
  const existingLink   = (engagement.video_link || '').trim();
  const isDelayed      = isSchedule && trackChoice === 'delayed';

  const missingVideo   = needsVideoLink && !(videoLink.trim() || existingLink);
  const missingRevised = isDelayed && !revisedDate;
  const canSubmit = !!target && !busy && !missingVideo && !missingRevised;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    try {
      let to_stage = target;
      let outNote = note;
      const extra = {};
      if (needsVideoLink) extra.video_link = (videoLink.trim() || existingLink);
      if (isDelayed) {
        // "Delayed" routes to the delayed stage with a revised post date; the
        // original is preserved in the history note (#10, no new column).
        to_stage = 'delayed';
        extra.expected_post_date = revisedDate;
        const orig = engagement.expected_post_date ? ` (was ${engagement.expected_post_date})` : '';
        outNote = `Delayed — revised post date ${revisedDate}${orig}${note ? ` — ${note}` : ''}`;
      }
      await onAdvance({ to_stage, note: outNote || undefined, ...extra });
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

        {/* #4 — going live requires a video link */}
        {needsVideoLink && (
          <div>
            <label style={lblStyle}>Video link *</label>
            <input
              value={videoLink || existingLink}
              onChange={(e) => setVideoLink(e.target.value)}
              placeholder="https://…"
              style={fieldStyle}
            />
            {missingVideo && <div style={{ fontSize: 11, color: 'var(--state-error-fg)', marginTop: 4 }}>Required to mark live</div>}
          </div>
        )}

        {/* #10 — scheduling: confirm on-track vs delayed */}
        {isSchedule && (
          <div>
            <label style={lblStyle}>Is it on track?</label>
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              {[['on_track', 'On track'], ['delayed', 'Delayed']].map(([v, label]) => {
                const on = trackChoice === v;
                return (
                  <button type="button" key={v} onClick={() => setTrackChoice(v)}
                    style={{
                      flex: 1, padding: '8px 10px', cursor: 'pointer',
                      background: on ? 'rgba(255,107,0,0.12)' : 'var(--surface-2)',
                      color: on ? '#FF6B00' : 'var(--text-2)',
                      border: `1px solid ${on ? '#FF6B00' : 'var(--border)'}`,
                      borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12,
                    }}>{label}</button>
                );
              })}
            </div>
            {isDelayed && (
              <div style={{ marginTop: 10 }}>
                <label style={lblStyle}>Revised post date *</label>
                <input type="date" value={revisedDate} onChange={(e) => setRevisedDate(e.target.value)} style={fieldStyle} />
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>Moves the deal to <strong>Delayed</strong>; original date kept in history.</div>
              </div>
            )}
          </div>
        )}

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
            disabled={!canSubmit}
            style={{
              padding: '8px 14px', background: '#FF6B00', color: '#fff',
              border: 'none', borderRadius: 'var(--radius-sm)',
              fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700,
              cursor: canSubmit ? 'pointer' : 'not-allowed', opacity: canSubmit ? 1 : 0.5,
            }}
          >{busy ? 'Advancing…' : 'Advance'}</button>
        </div>
      </div>
    </Modal>
  );
}
