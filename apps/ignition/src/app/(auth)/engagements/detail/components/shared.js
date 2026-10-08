'use client';
import { Card as IgCard } from '../../../../../components/ui/Card.js';
import { SectionTitle } from '../../../../../components/ui/SectionTitle.js';

// One line, one wording, on every card the COMPLETE-deal lock freezes (S373).
export function LockedNote() {
  return (
    <div style={{ marginBottom: 10, fontSize: 12, color: 'var(--text-4)', fontFamily: 'var(--font-mono)', letterSpacing: '0.04em' }}>
      🔒 Locked — deal is complete
    </div>
  );
}

// Deal-page section card (Pit Control): the shared Ignition Card with the 15px Tomorrow title the
// detail grid uses. Props API unchanged ({ title, children }); `action`/`onAction` pass through to
// the header row and anything else (style, className) to the card.
export function Card({ title, action, onAction, actionHref, children, ...rest }) {
  return (
    <IgCard {...rest}>
      {title != null && (
        <SectionTitle size={15} action={action} onAction={onAction} actionHref={actionHref} style={{ marginBottom: 8 }}>{title}</SectionTitle>
      )}
      {children}
    </IgCard>
  );
}

// Label left in --text-3, value right; a hairline between rows (prototype card rows).
export function KV({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '7px 0', borderTop: '1px solid var(--row-divider)', fontSize: 14 }}>
      <span style={{ color: 'var(--text-3)', flexShrink: 0 }}>{label}</span>
      <span style={{ color: 'var(--text-1)', textAlign: 'right', minWidth: 0, overflowWrap: 'anywhere' }}>{value}</span>
    </div>
  );
}
export const miniBtn = { height: 30, padding: '0 12px', background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border-3)', borderRadius: 'var(--r-ctl)', fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 600, cursor: 'pointer' };
