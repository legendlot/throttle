'use client';
import { Button } from './ui/index.js';

// The one "this didn't load" state for Docket screens (Podium's LoadError, in Docket's kit): a short line
// and a Retry. Shown when a read fails and there is nothing true to fall back on — instead of an endless
// spinner, the previous view's rows, or an empty state ("All clear", "No live announcements") that isn't
// true. `compact` sits inline (the sidebar, a freshness line); the default fills a panel.
export function LoadError({ message = "Couldn't load this.", onRetry, compact = false, style }) {
  return (
    <div role="alert" style={{
      display: 'flex', alignItems: 'center', gap: compact ? 8 : 12, flexWrap: 'wrap',
      fontSize: compact ? 12 : 13, color: 'var(--text-3)', padding: compact ? 0 : '24px 0', justifyContent: compact ? 'flex-start' : 'center', ...style,
    }}>
      <span>{message}</span>
      {onRetry && (compact
        ? <button type="button" onClick={onRetry}
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--docket-accent, var(--text-1))', fontSize: 12, textDecoration: 'underline' }}>Retry</button>
        : <Button size="sm" variant="neutral" onClick={onRetry}>Retry</Button>)}
    </div>
  );
}
