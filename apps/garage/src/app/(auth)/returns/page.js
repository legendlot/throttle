'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function ReturnsRoot() {
  const router = useRouter();
  useEffect(() => { router.replace('/returns/shipments'); }, [router]);
  return null;
}
