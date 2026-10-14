'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { RequireAuth, useAuth } from '@throttle/auth';
import { isPartnerPerms, PARTNER_LANDING } from '../lib/partner.js';

function Landing() {
  const router = useRouter();
  const { perms, brandUser } = useAuth();
  // External partners land on the Roster (S419); staff on the dashboard.
  const partner = isPartnerPerms(perms || brandUser?.permissions);
  useEffect(() => { router.replace(partner ? `${PARTNER_LANDING}/` : '/dashboard/'); }, [router, partner]);
  return <div style={{ padding: 20, color: 'var(--text-3)' }}>Loading…</div>;
}

export default function Home() {
  return <RequireAuth><Landing /></RequireAuth>;
}
