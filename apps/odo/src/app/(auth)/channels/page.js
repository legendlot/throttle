'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
// No Channels landing — the sidebar group lists the families directly. Redirect to the first.
export default function ChannelsIndex() {
  const router = useRouter();
  useEffect(() => { router.replace('/channels/website'); }, [router]);
  return null;
}
