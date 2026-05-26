'use client';
import { useAuth } from '@throttle/auth';
import { EmptyState } from '@throttle/ui';
import { ListChecks } from 'lucide-react';

export default function QueuePage() {
  const { user } = useAuth();
  return (
    <div>
      <h1 style={{
        fontFamily: 'var(--font-cond)',
        fontSize: 'var(--text-xl)',
        fontWeight: 600,
        letterSpacing: 'var(--tracking-tight)',
        marginBottom: 'var(--space-4)',
      }}>
        Queue
      </h1>
      <EmptyState
        icon={ListChecks}
        title="Queue under construction"
        message={`Signed in as ${user?.full_name || user?.email}. The queue UI lands in Task 8 — sub-tabs, KPIs, filters, table.`}
      />
    </div>
  );
}
