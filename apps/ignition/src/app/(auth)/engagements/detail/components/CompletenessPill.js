'use client';

/** Derived-completion pill for the deal header. Pill-shaped like StagePill (radius 99, 12/600)
 *  rather than a new primitive, since it carries no stage vocabulary.
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
    : { fg: 'var(--text-3)',           bg: 'var(--chip-neutral)' };
  return (
    <span
      title={complete
        ? (viaGaps.length
            ? `All metrics answered — ${viaGaps.join(', ')} explained, not captured`
            : 'All metrics captured')
        : `Missing: ${missing.join(', ')}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '3px 10px',
        fontSize: 12,
        fontFamily: 'var(--font-ui)',
        fontWeight: 600,
        color: p.fg,
        background: p.bg,
        borderRadius: 99,
        maxWidth: '100%',
        overflowWrap: 'anywhere',
      }}
    >
      {complete
        ? (viaGaps.length ? `Complete · ${viaGaps.length} explained` : 'Complete')
        : `Incomplete · missing: ${missing.join(', ')}`}
    </span>
  );
}
