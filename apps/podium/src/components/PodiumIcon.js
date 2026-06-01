'use client';
// Podium logo mark — the podium (three bars) in LOT brand yellow on charcoal.
export function PodiumIcon({ size = 44 }) {
  return (
    <img src="/favicon.svg" alt="Podium" width={size} height={size}
      style={{ display: 'block', borderRadius: 10 }} />
  );
}

export default PodiumIcon;
