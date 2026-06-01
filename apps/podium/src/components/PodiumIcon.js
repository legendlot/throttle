'use client';
// Placeholder Podium mark — three podium steps (2nd | 1st | 3rd) in emerald.
// Replaced by the real logo once the name is locked and Claude design ships it.
export function PodiumIcon({ size = 40 }) {
  const u = size / 32;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <rect x={5}  y={16} width={6} height={11} rx={1} fill="var(--podium-green)" />
      <rect x={13} y={11} width={6} height={16} rx={1} fill="#34D399" />
      <rect x={21} y={19} width={6} height={8}  rx={1} fill="var(--podium-green-deep)" />
    </svg>
  );
}

export default PodiumIcon;
