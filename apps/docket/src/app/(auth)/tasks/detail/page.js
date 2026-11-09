'use client';
// /tasks/detail/?id=… — TaskView in full-page mode, inside the shell (ClickUp redesign
// P5). The URL is the task's permalink (Copy link, the tasks/new redirect, sub-task
// rows without TaskView). ‹ › walk the list it was opened from; × goes back to it.
import { useEffect, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { docketopsGet } from '../../../../lib/docketopsFetch.js';
import { TaskView } from '../../../../components/task/TaskView.js';

function DetailInner() {
  const { session } = useAuth();
  const router = useRouter();
  const id = useSearchParams().get('id');
  const [departments, setDepartments] = useState([]);
  const [employees, setEmployees] = useState([]);

  useEffect(() => {
    if (!session) return;
    Promise.all([
      docketopsGet('getDepartments', {}, session).catch(() => []),
      docketopsGet('getEmployees', {}, session).catch(() => []),
    ]).then(([d, e]) => { setDepartments(d || []); setEmployees(e || []); });
  }, [session]);

  if (!id) return <div style={{ color: 'var(--text-3)' }}>Task not found.</div>;
  return (
    <TaskView id={id} mode="full" session={session} departments={departments} employees={employees}
      onOpen={(next) => router.push(`/tasks/detail/?id=${next}`)} />
  );
}

export default function DetailPage() {
  return <Suspense fallback={<Spinner />}><DetailInner /></Suspense>;
}
