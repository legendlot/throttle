'use client';
import { HAPPY_PATH, STAGE_LABELS, STAGE_PALETTE } from '../lib/stages.js';

/**
 * Stepper for the engagement happy path (Planning→…→Completed).
 * A current stage that's off the happy path (Delayed / On hold / Ghosted /
 * Dropped) is shown as a trailing badge in its own palette colour.
 */
export default function StageStepper({ stage }) {
  const currentIdx = HAPPY_PATH.indexOf(stage);
  const offPath = currentIdx < 0;
  const pal = STAGE_PALETTE[stage] || { fg: 'var(--text-2)', bg: 'var(--surface-2)' };
  return (
    <div style={{
      display: 'flex',
      flexWrap: 'wrap',
      gap: 2,
      alignItems: 'center',
      padding: 'var(--space-2) 0',
    }}>
      {HAPPY_PATH.map((s, i) => {
        const done = currentIdx >= 0 && i <= currentIdx;
        const current = s === stage;
        return (
          <span key={s} style={{
            padding: '4px 10px',
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
            fontWeight: current ? 700 : 500,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            color: current ? '#FF6B00' : done ? 'var(--text-1)' : 'var(--text-3)',
            background: current ? 'rgba(255,107,0,0.12)' : 'transparent',
            border: `1px solid ${current ? '#FF6B00' : done ? 'var(--border-2)' : 'var(--border)'}`,
            borderRadius: 'var(--radius-sm)',
            whiteSpace: 'nowrap',
          }}>
            {STAGE_LABELS[s]}
          </span>
        );
      })}
      {offPath && (
        <span style={{
          padding: '4px 10px',
          fontSize: 11,
          fontFamily: 'var(--font-mono)',
          fontWeight: 700,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          color: pal.fg,
          background: pal.bg,
          border: `1px solid ${pal.fg}`,
          borderRadius: 'var(--radius-sm)',
          marginLeft: 'var(--space-2)',
        }}>
          {STAGE_LABELS[stage] || stage}
        </span>
      )}
    </div>
  );
}
