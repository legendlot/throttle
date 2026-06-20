'use client';

/**
 * CallStatusBadge — Volt (handoff §5).
 * answered=ok / missed=bad / abandoned+in_progress=muted.
 * Tomorrow 9.5px UPPERCASE, *-fg on *-bg with 1px *-bd, radius 5px.
 */
const STYLES = {
  answered:    { fg: 'var(--ok-fg)',  bg: 'var(--ok-bg)',     bd: 'var(--ok-bd)',     label: 'Answered' },
  missed:      { fg: 'var(--bad-fg)', bg: 'var(--bad-bg)',    bd: 'var(--bad-bd)',    label: 'Missed' },
  abandoned:   { fg: 'var(--t3)',     bg: 'var(--surface-3)', bd: 'var(--border-2)',  label: 'Abandoned' },
  in_progress: { fg: 'var(--t3)',     bg: 'var(--surface-3)', bd: 'var(--border-2)',  label: 'Live' },
};

export function CallStatusBadge({ status }) {
  const s = STYLES[status] || STYLES.abandoned;
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      background: s.bg,
      color: s.fg,
      border: `1px solid ${s.bd}`,
      padding: '2px 8px',
      borderRadius: 5,
      fontFamily: 'var(--f-display)',
      fontSize: 9.5,
      fontWeight: 700,
      letterSpacing: '0.06em',
      textTransform: 'uppercase',
      whiteSpace: 'nowrap',
    }}>{s.label}</span>
  );
}
