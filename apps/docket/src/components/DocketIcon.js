'use client';
// Docket logo mark — the clipboard-with-checkmark in LOT brand yellow.
export function DocketIcon({ size = 44 }) {
  return (
    <img src="/favicon.svg" alt="Docket" width={size} height={size}
      style={{ display: 'block', borderRadius: 10 }} />
  );
}

export default DocketIcon;
