'use client';

/** Derived-completion pill for the deal header. Styled like DealTypeBadge (the free-text badge
 *  shape in this header) rather than a new component, since it carries no stage vocabulary.
 *  Green = complete; muted = live but still missing numbers, named in `missing` order so the
 *  reader knows what to go and enter. Nothing at all before the deal is live. */
export function CompletenessPill({ completeness }) {
  // `viaGaps` = checks passed by a RECORDED REASON rather than a number (S369). Saying "all
  // metrics captured" over an explained gap claims data we do not hold — the pill has to
  // distinguish measured from explained, which is the whole reason the field exists.
  const { live, complete, missing, viaGaps = [] } = completeness;
  if (!live) return null;
  const p = complete
    ? { fg: 'var(--state-success-fg)', bg: 'var(--state-success-bg)' }
    : { fg: 'var(--text-3)',           bg: 'var(--surface-2)' };
  return (
    <span
      title={complete
        ? (viaGaps.length
            ? `All metrics answered — ${viaGaps.join(', ')} explained, not captured`
            : 'All metrics captured')
        : `Missing: ${missing.join(', ')}`}
      style={{
        display: 'inline-flex',
        padding: '2px 8px',
        fontSize: 11,
        fontFamily: 'var(--font-mono)',
        fontWeight: 600,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        color: p.fg,
        background: p.bg,
        border: '1px solid currentColor',
        borderRadius: 'var(--radius-sm)',
      }}
    >
      {complete
        ? (viaGaps.length ? `Complete · ${viaGaps.length} explained` : 'Complete')
        : `Incomplete · missing: ${missing.join(', ')}`}
    </span>
  );
}
