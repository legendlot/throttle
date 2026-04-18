'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from './AuthProvider.js';
import { hasPermission, hasWritePermission } from './permissions.js';

function Spinner() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', color: '#999' }}>
      Loading…
    </div>
  );
}

export function RequireAuth({ children, loginPath = '/login/' }) {
  const { session, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !session) {
      router.replace(loginPath);
    }
  }, [loading, session, router, loginPath]);

  if (loading) return <Spinner />;
  if (!session) return null;
  return children;
}

export function RequirePermission({ children, perm, level, fallback = null }) {
  const { perms } = useAuth();
  if (!perm) return children;
  if (level === 'write') {
    return hasWritePermission(perms, perm) ? children : fallback;
  }
  return hasPermission(perms, perm) ? children : fallback;
}
