'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrand as supabase, workerFetch } from '@throttle/db';

export default function AuthCallback() {
  const router = useRouter();

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        router.replace('/login');
        return;
      }
      try {
        const me = await workerFetch('getMe', {}, session.access_token);
        if (me && !me.error) {
          sessionStorage.setItem('throttle_me', JSON.stringify(me));
        }
      } catch {
        // non-fatal — AuthProvider will fetch fresh if cache missing
      }
      router.replace('/');
    })();
  }, [router]);

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <p style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', letterSpacing: '.2em', textTransform: 'uppercase' }}>Signing you in...</p>
    </div>
  );
}
