'use client';

const COLOR_MAP = {
  yellow: '#F2CD1A',
  green:  '#22c55e',
  red:    '#DE2A2A',
  blue:   '#213CE2',
  orange: '#f97316',
};

export function KpiCard({ label, value, sub, color }) {
  const stripe = COLOR_MAP[color] || 'transparent';
  return (
    <div style={{
      background:   'var(--surface)',
      border:       '1px solid var(--border)',
      borderRadius: 4,
      padding:      16,
      minWidth:     140,
      position:     'relative',
      overflow:     'hidden',
      fontFamily:   'var(--mono)',
    }}>
      {/* 2px top colour stripe — matches legacy .kpi-card::before */}
      <div style={{
        position:   'absolute',
        top:        0,
        left:       0,
        right:      0,
        height:     2,
        background: stripe,
      }} />

      {/* Label */}
      <div style={{
        fontSize:      10,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color:         'var(--t3)',
        marginBottom:  8,
      }}>{label}</div>

      {/* Value — always --t1 white; colour is expressed by the stripe only */}
      <div style={{
        fontSize:   28,
        color:      'var(--t1)',
        lineHeight: 1,
        fontWeight: 600,
      }}>{value}</div>

      {/* Optional sub-label */}
      {sub && (
        <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 4 }}>{sub}</div>
      )}
    </div>
  );
}
