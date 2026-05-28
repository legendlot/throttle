'use client';
import { HAPPY_PATH, STAGE_LABELS, TERMINAL_FAIL } from '../lib/stages.js';

/**
 * Linear stepper for the engagement happy path.
 * If current stage is a terminal failure, shows the path up to where it diverged
 * plus a red node.
 */
export default function StageStepper({ stage }) {
  const isFail = TERMINAL_FAIL.has(stage);
  const currentIdx = HAPPY_PATH.indexOf(stage);
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
      {isFail && (
        <span style={{
          padding: '4px 10px',
          fontSize: 11,
          fontFamily: 'var(--font-mono)',
          fontWeight: 700,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          color: 'var(--state-error-fg)',
          background: 'var(--state-error-bg)',
          border: '1px solid var(--state-error-fg)',
          borderRadius: 'var(--radius-sm)',
          marginLeft: 'var(--space-2)',
        }}>
          {STAGE_LABELS[stage]}
        </span>
      )}
    </div>
  );
}
