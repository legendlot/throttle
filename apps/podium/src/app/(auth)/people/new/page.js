'use client';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { ArrowLeft } from 'lucide-react';
import EmployeeForm from '../../../../components/EmployeeForm.js';

export default function NewPersonPage() {
  const { session, perms } = useAuth();
  const router = useRouter();

  if (perms && !perms.podium_hr) {
    return <div style={{ color: 'var(--text-3)' }}>You don’t have permission to add people (requires podium_hr).</div>;
  }

  return (
    <div style={{ maxWidth: 860 }}>
      <button onClick={() => router.back()} style={backBtn}><ArrowLeft size={15} /> Back</button>
      <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', margin: '8px 0 18px' }}>New Person</h1>
      <EmployeeForm
        session={session}
        onSaved={(id) => router.push(id ? `/people/detail/?id=${id}` : '/people')}
        onCancel={() => router.back()}
      />
    </div>
  );
}

const backBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '6px 12px', fontSize: 12, cursor: 'pointer' };
