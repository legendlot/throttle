'use client';

export function EmptyState({ message, icon }) {
  return (
    <div style={{
      textAlign: 'center', color: '#666', padding: '32px 16px',
      fontFamily: 'var(--mono, ui-monospace, Menlo, monospace)', fontSize: 13,
    }}>
      {icon && <div style={{ fontSize: 28, marginBottom: 8 }}>{icon === 'search' ? '⌕' : icon}</div>}
      <div>{message}</div>
    </div>
  );
}
