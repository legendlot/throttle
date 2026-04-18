'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrand as supabase } from '@throttle/db';

export default function AuthCallback() {
  const router = useRouter();

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      router.replace(session ? '/' : '/login');
    });
  }, [router]);

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <p style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', letterSpacing: '.2em', textTransform: 'uppercase' }}>Signing you in...</p>
    </div>
  );
}
