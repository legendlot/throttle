export default function NotFound() {
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontFamily: 'var(--cond)', fontSize: 28, fontWeight: 700, color: 'var(--t1)' }}>404</div>
      <a href="/" style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--accent)' }}>← Back to Odo</a>
    </div>
  );
}
