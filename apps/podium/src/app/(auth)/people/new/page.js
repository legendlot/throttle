'use client';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { ArrowLeft } from 'lucide-react';
import EmployeeForm from '../../../../components/EmployeeForm.js';
import { btnGhost } from '../../../../components/ui.js';

export default function NewPersonPage() {
  const { session, perms } = useAuth();
  const router = useRouter();

  if (perms && !perms.podium_hr) {
    return <div style={{ color: 'var(--t3)' }}>You don’t have permission to add people (requires podium_hr).</div>;
  }

  return (
    <div style={{ maxWidth: 860 }}>
      <button onClick={() => router.back()} style={{ ...btnGhost, marginBottom: 16 }}><ArrowLeft size={14} /> Back</button>
      <EmployeeForm
        session={session}
        onSaved={(id) => router.push(id ? `/people/detail/?id=${id}` : '/people')}
        onCancel={() => router.back()}
      />
    </div>
  );
}
