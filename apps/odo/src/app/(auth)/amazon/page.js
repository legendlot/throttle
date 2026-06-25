'use client';
// The Amazon view now lives under Channels (Channels → Amazon). Keep this route as a redirect so
// any saved /amazon links still land on the merged page.
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function Page() {
  const router = useRouter();
  useEffect(() => { router.replace('/channels/amazon'); }, [router]);
  return null;
}
