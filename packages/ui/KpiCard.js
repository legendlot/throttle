'use client';

const COLORS = {
  green:  '#22c55e',
  red:    '#ef4444',
  blue:   '#3b82f6',
  orange: '#f97316',
};

export function KpiCard({ label, value, sub, color }) {
  return (
    <div style={{
      background: '#0f0f0f', border: '1px solid #222', borderRadius: 6,
      padding: 12, minWidth: 140,
      fontFamily: 'var(--mono, ui-monospace, Menlo, monospace)',
    }}>
      <div style={{ color: '#777', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>{label}</div>
      <div style={{ color: COLORS[color] || '#fff', fontSize: 22, marginTop: 4, fontWeight: 600 }}>{value}</div>
      {sub && <div style={{ color: '#666', fontSize: 11, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
