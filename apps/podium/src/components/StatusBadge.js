'use client';
// Employee status → semantic dot-pill (Pit Wall v2). Tomorrow 10px uppercase + 5px dot.
// active=ok · on_leave=warn · notice=bad · exited=neutral (handoff §5 / tokens.css).

const STATUS = {
  active:   { label: 'Active',   fg: 'var(--ok-fg)',      bg: 'var(--ok-bg)',      bd: 'var(--ok-bd)' },
  on_leave: { label: 'On Leave', fg: 'var(--warn-fg)',    bg: 'var(--warn-bg)',    bd: 'var(--warn-bd)' },
  notice:   { label: 'Notice',   fg: 'var(--bad-fg)',     bg: 'var(--bad-bg)',     bd: 'var(--bad-bd)' },
  exited:   { label: 'Exited',   fg: 'var(--neutral-fg)', bg: 'var(--neutral-bg)', bd: 'var(--neutral-bd)' },
};

export function statusPill(status) {
  return STATUS[status] || { label: status || '—', fg: 'var(--neutral-fg)', bg: 'var(--neutral-bg)', bd: 'var(--neutral-bd)' };
}

export default function StatusBadge({ status, label }) {
  const m = statusPill(status);
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      fontFamily: 'var(--font-display)', fontSize: 10, fontWeight: 600, letterSpacing: '0.06em',
      textTransform: 'uppercase', padding: '3px 8px', borderRadius: 5,
      color: m.fg, background: m.bg, border: `1px solid ${m.bd}`,
    }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: m.fg }} />
      {label || m.label}
    </span>
  );
}
