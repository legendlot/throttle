'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Spinner } from '@throttle/ui';

// Alerts was folded into the Overview triage ("Needs Attention Now") in the
// S128 redesign. This route now just forwards to /dashboard so any existing
// links / bookmarks keep working.
export default function AlertsPage() {
  const router = useRouter();
  useEffect(() => { router.replace('/dashboard'); }, [router]);
  return <div style={{ padding: 48, textAlign: 'center' }}><Spinner /></div>;
}
