'use client';
// Static export emits this as 404.html. The app is a single-page switcher
// (no per-screen routes), so bounce any stale/old URL (e.g. /dashboard/) to root.
import { useEffect } from 'react';

export default function NotFound() {
  useEffect(() => { window.location.replace('/'); }, []);
  return null;
}
