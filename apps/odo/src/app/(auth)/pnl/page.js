'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
export default function PnlIndex() {
  const router = useRouter();
  useEffect(() => { router.replace('/pnl/overall'); }, [router]);
  return null;
}
