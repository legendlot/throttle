'use client';

// Bar sparkline (igGrowY, +35ms per bar). `values` are numbers; the last bar is highlighted in
// `color`, earlier bars in `dim`. Height 28px by default. Empty / all-zero input renders flat stubs.
export function Spark({ values = [], color = 'var(--accent)', dim = 'var(--border-2)', height = 28, highlightLast = true, style }) {
  const max = Math.max(0, ...values.map((v) => Number(v) || 0));
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height, ...style }}>
      {values.map((v, i) => {
        const h = max > 0 ? Math.max(8, ((Number(v) || 0) / max) * 100) : 8;
        const hot = !highlightLast || i === values.length - 1;
        return (
          <div key={i} className="ig-growy" style={{
            flex: 1, height: `${h}%`, borderRadius: 2, background: hot ? color : dim,
            animationDuration: '500ms', animationDelay: `${i * 35}ms`,
          }} />
        );
      })}
    </div>
  );
}

export default Spark;
