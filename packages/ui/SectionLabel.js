'use client';

export function SectionLabel({ children }) {
  return (
    <h3 style={{
      color: '#888', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1.5,
      margin: '16px 0 8px', fontWeight: 500,
      fontFamily: 'var(--mono, ui-monospace, Menlo, monospace)',
    }}>
      {children}
    </h3>
  );
}
