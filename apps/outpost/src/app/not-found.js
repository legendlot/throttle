'use client';
// Static export emits this as 404.html. Outpost is one page; send any stale URL to it.
import { useEffect } from 'react';

export default function NotFound() {
  useEffect(() => { window.location.replace('/'); }, []);
  return null;
}
