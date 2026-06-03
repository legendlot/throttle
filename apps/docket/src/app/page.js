'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { RequireAuth, useAuth } from '@throttle/auth';

function Landing() {
  const router = useRouter();
  const { perms } = useAuth();
  useEffect(() => {
    if (!perms) return;
    // Reviewers/admins land on the dashboard; everyone else on their task list.
    router.replace((perms.docket_view_all || perms.docket_admin) ? '/dashboard/' : '/tasks/');
  }, [router, perms]);
  return <div style={{ padding: 20, color: '#888' }}>Loading…</div>;
}

export default function Home() {
  return <RequireAuth><Landing /></RequireAuth>;
}
