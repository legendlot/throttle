'use client';

const SIZES = { sm: 14, md: 22, lg: 36 };

export function Spinner({ size = 'md' }) {
  const px = SIZES[size] || SIZES.md;
  return (
    <span
      aria-label="loading"
      style={{
        display: 'inline-block',
        width: px, height: px,
        border: '2px solid #333',
        borderTopColor: '#888',
        borderRadius: '50%',
        animation: 'throttle-spin 0.9s linear infinite',
      }}
    >
      <style>{`@keyframes throttle-spin{to{transform:rotate(360deg)}}`}</style>
    </span>
  );
}
