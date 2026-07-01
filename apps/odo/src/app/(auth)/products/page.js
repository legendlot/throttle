'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
export default function ProductsIndex() {
  const router = useRouter();
  useEffect(() => { router.replace('/products/drr'); }, [router]);
  return null;
}
