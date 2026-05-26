'use client';
import { EmptyState } from '@throttle/ui';
import { BarChart3 } from 'lucide-react';

export default function ReportsPage() {
  return (
    <div>
      <h1 style={{
        fontFamily: 'var(--font-cond)',
        fontSize: 'var(--text-xl)',
        fontWeight: 600,
        letterSpacing: 'var(--tracking-tight)',
        marginBottom: 'var(--space-4)',
      }}>
        Reports
      </h1>
      <EmptyState
        icon={BarChart3}
        title="Reports coming in Task 11"
        message="Monthly trend, per-product / per-platform / per-agent breakdowns, cost summary, CSV export."
      />
    </div>
  );
}
