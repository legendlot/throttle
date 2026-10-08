'use client';

// Card header row: Tomorrow 15–17/700 title (sentence case) + an optional 12/600 text action
// (Edit, + Add, Open →) that turns --text-1 on hover. `eyebrow` adds the mono 12px caps line above.
export function SectionTitle({ children, action, onAction, actionHref, eyebrow, size = 17, style }) {
  const act = action == null ? null : actionHref
    ? <a href={actionHref} className="ig-card-action">{action}</a>
    : <button type="button" className="ig-card-action" onClick={onAction}>{action}</button>;
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 14, ...style }}>
      <div style={{ minWidth: 0 }}>
        {eyebrow && (
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, letterSpacing: 'var(--tracking-eyebrow)',
            textTransform: 'uppercase', color: 'var(--text-4)', marginBottom: 6 }}>{eyebrow}</div>
        )}
        <div style={{ fontFamily: 'var(--font-cond)', fontSize: size, fontWeight: 700, lineHeight: 1.2 }}>{children}</div>
      </div>
      {act}
    </div>
  );
}

export default SectionTitle;
