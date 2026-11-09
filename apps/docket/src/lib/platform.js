'use client';
// Apple platforms use ⌘ for shortcuts; everything else Ctrl. Client-only check.
import { useEffect, useState } from 'react';

export function isApple() {
  if (typeof navigator === 'undefined') return true;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '');
}
// The modifier's label for hints: '⌘' or 'Ctrl'. Starts as '⌘' (static export), then
// corrects itself on mount.
export function useModLabel() {
  const [m, setM] = useState('⌘');
  useEffect(() => { if (!isApple()) setM('Ctrl'); }, []);
  return m;
}
// The ⌘K-style modifier for this platform: metaKey on Apple (so Ctrl+K keeps its
// kill-line meaning in text fields there), ctrlKey elsewhere.
export function modPressed(e) { return isApple() ? (e.metaKey && !e.ctrlKey) : (e.ctrlKey && !e.metaKey); }
