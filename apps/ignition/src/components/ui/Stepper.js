'use client';

// Horizontal pipeline stepper. steps: [{ key, label, date? }]; `current` = the current step key.
// When `current` is off the path (a hold or an exit) no node is lit and the fill is empty.
// Done nodes: orange fill + ✓; current: hollow orange with the igRing pulse; future: --text-5.
export function Stepper({ steps = [], current, style }) {
  const idx = steps.findIndex((s) => s.key === current);
  const n = steps.length;
  const inset = n > 0 ? 50 / n : 0;                 // node centres sit at (i + .5) / n
  const fill = idx <= 0 || n < 2 ? 0 : (idx / (n - 1)) * (100 - 2 * inset);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${n}, minmax(0,1fr))`, position: 'relative', ...style }}>
      <div style={{ position: 'absolute', left: `${inset}%`, right: `${inset}%`, top: 13, height: 3, background: 'var(--border-2)', borderRadius: 2 }} />
      <div style={{ position: 'absolute', left: `${inset}%`, top: 13, height: 3, width: `${fill}%`, background: 'var(--accent)',
        borderRadius: 2, transition: 'width 700ms var(--ease-out)' }} />
      {steps.map((s, i) => {
        const done = idx >= 0 && i < idx;
        const now = idx >= 0 && i === idx;
        return (
          <div key={s.key} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, position: 'relative', minWidth: 0 }}>
            <span style={{
              width: 28, height: 28, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700,
              background: done ? 'var(--accent)' : now ? 'var(--bg)' : 'var(--surface)',
              color: done ? 'var(--accent-fg)' : now ? 'var(--accent)' : 'var(--text-5)',
              border: `2px solid ${done || now ? 'var(--accent)' : 'var(--border-3)'}`,
              animation: now ? 'igRing 1.8s infinite' : undefined,
              transition: 'background 400ms, border-color 400ms, color 400ms',
            }}>{done ? '✓' : i + 1}</span>
            <span style={{ fontSize: 13, fontWeight: 600, textAlign: 'center', transition: 'color 400ms',
              color: now ? 'var(--text-1)' : done ? 'var(--text-2)' : 'var(--text-5)' }}>{s.label}</span>
            {s.date != null && (
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-4)' }}>{s.date}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default Stepper;
