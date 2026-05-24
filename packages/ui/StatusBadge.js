'use client';

/**
 * StatusBadge — small status indicator with semantic variants.
 *
 * Replaces inline TONE / BADGE_STYLES maps duplicated in 5+ pages
 * (exec/page.js, customer-repairs/page.js, lines/page.js, etc.).
 * Per DESIGN.md "Status Badges" + "The State Triple Rule".
 *
 * Always combine color + label, optionally + icon. Color alone is never the message.
 *
 * Usage:
 *   <StatusBadge variant="success">Completed</StatusBadge>
 *   <StatusBadge variant="error" icon="✗">Failed</StatusBadge>
 *   <StatusBadge variant="warning" icon="⚠">Pending</StatusBadge>
 *   <StatusBadge variant="info">Submitted</StatusBadge>
 *   <StatusBadge variant="brand">Active</StatusBadge>
 *   <StatusBadge variant="neutral">—</StatusBadge>
 *
 * Props:
 *   variant — one of: warning | error | success | info | brand | neutral. Defaults to neutral.
 *   icon    — optional leading glyph (string or node).
 *   children — label text.
 *   style   — merged into the span style.
 */
const VARIANTS = {
  warning: {
    bg:     'rgba(251, 191, 36, 0.12)',
    fg:     '#fbbf24',
    border: 'rgba(251, 191, 36, 0.25)',
  },
  error: {
    bg:     'rgba(222, 42, 42, 0.15)',
    fg:     '#ff7070',
    border: 'rgba(222, 42, 42, 0.30)',
  },
  success: {
    bg:     'rgba(34, 197, 94, 0.12)',
    fg:     '#4ade80',
    border: 'rgba(34, 197, 94, 0.25)',
  },
  info: {
    bg:     'rgba(33, 60, 226, 0.20)',
    fg:     '#7b93ff',
    border: 'rgba(33, 60, 226, 0.35)',
  },
  brand: {
    bg:     'rgba(242, 205, 26, 0.12)',
    fg:     '#f2cd1a',
    border: 'rgba(242, 205, 26, 0.25)',
  },
  neutral: {
    bg:     'rgba(80, 80, 80, 0.20)',
    fg:     '#aaa',
    border: 'rgba(80, 80, 80, 0.30)',
  },
};

export function StatusBadge({ variant = 'neutral', icon, children, style }) {
  const v = VARIANTS[variant] || VARIANTS.neutral;

  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      background: v.bg,
      color: v.fg,
      border: '1px solid ' + v.border,
      borderRadius: 3,
      padding: '2px 7px',
      fontFamily: 'var(--mono)',
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
      whiteSpace: 'nowrap',
      lineHeight: 1.3,
      ...style,
    }}>
      {icon && (
        <span style={{ fontSize: 10, lineHeight: 1 }}>{icon}</span>
      )}
      {children}
    </span>
  );
}
