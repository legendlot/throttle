'use client';

const TONES = {
  warning: { fg: '#fbbf24', bg: 'rgba(251,191,36,.08)', bd: 'rgba(251,191,36,.3)' },
  error:   { fg: '#ff7b7b', bg: 'rgba(222,42,42,.08)',  bd: 'rgba(255,123,123,.3)' },
  info:    { fg: '#8ea2ff', bg: 'rgba(33,60,226,.10)',  bd: 'rgba(142,162,255,.3)' },
  success: { fg: '#4ade80', bg: 'rgba(34,197,94,.08)',  bd: 'rgba(74,222,128,.3)' },
  accent:  { fg: '#ff8a33', bg: 'rgba(255,107,0,.08)',  bd: 'rgba(255,107,0,.3)' },
};

// Banner (broken links, approval gate, lock): radius 14, 12px 16px. A bold tone-coloured `lead`
// sentence, then `children` in --text-2, then an optional right-aligned text `action`.
export function Banner({ tone = 'warning', icon, lead, children, action, onAction, actionDisabled, style }) {
  const t = TONES[tone] || TONES.warning;
  return (
    <div role="status" style={{
      display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      padding: '12px 16px', borderRadius: 'var(--r-row)', background: t.bg, border: `1px solid ${t.bd}`,
      fontSize: 14, color: 'var(--text-2)', ...style,
    }}>
      {icon && <span style={{ color: t.fg, display: 'flex', flexShrink: 0 }}>{icon}</span>}
      <div style={{ flex: 1, minWidth: 0 }}>
        {lead && <strong style={{ color: t.fg, fontWeight: 700 }}>{lead}</strong>}
        {lead && children ? ' ' : null}
        {children}
      </div>
      {action != null && (
        <button type="button" onClick={onAction} disabled={actionDisabled} className="ig-card-action"
          style={{ color: t.fg, fontSize: 13, fontWeight: 700, opacity: actionDisabled ? 0.5 : 1 }}>
          {action}
        </button>
      )}
    </div>
  );
}

export default Banner;
