'use client';
import { btnGhost } from './ui.js';

// The one "this didn't load" state for Podium screens: a short line and a Retry. Shown when a read
// fails and there is nothing to fall back on — instead of an endless spinner, an empty state that
// isn't true, or a 0. `compact` sits inline (a picker, a stat strip); the default fills a panel.
export function LoadError({ message = "Couldn't load this.", onRetry, compact = false, style }) {
  return (
    <div role="alert" style={{
      display: 'flex', alignItems: 'center', gap: compact ? 8 : 12, flexWrap: 'wrap',
      fontSize: compact ? 12 : 13, color: 'var(--t3)', padding: compact ? 0 : '14px 0', ...style,
    }}>
      <span>{message}</span>
      {onRetry && (
        <button type="button" onClick={onRetry}
          style={compact ? { background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--yellow)', fontSize: 12, textDecoration: 'underline' } : btnGhost}>
          Retry
        </button>
      )}
    </div>
  );
}
