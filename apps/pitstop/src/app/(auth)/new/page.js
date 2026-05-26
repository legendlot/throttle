'use client';
import { EmptyState } from '@throttle/ui';
import { Plus } from 'lucide-react';

export default function NewTicketPage() {
  return (
    <div>
      <h1 style={{
        fontFamily: 'var(--font-cond)',
        fontSize: 'var(--text-xl)',
        fontWeight: 600,
        letterSpacing: 'var(--tracking-tight)',
        marginBottom: 'var(--space-4)',
      }}>
        New Ticket
      </h1>
      <EmptyState
        icon={Plus}
        title="Intake form coming in Task 10"
        message="Phone-intake-optimised: UPC scan-to-autofill, past-case hint, keyboard-driven."
      />
    </div>
  );
}
