'use client';
import { statusMeta } from '../lib/format.js';

export default function StatusBadge({ status }) {
  const m = statusMeta(status);
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 'var(--radius-full)',
      fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase',
      color: m.color, border: `1px solid ${m.color}`, background: 'transparent',
    }}>
      {m.label}
    </span>
  );
}
