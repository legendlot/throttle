'use client';
import { useEffect, useState, useCallback, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { ArrowLeft } from 'lucide-react';
import { docketopsGet, docketopsPost } from '../../../../lib/docketopsFetch.js';
import { TaskForm } from '../../../../components/TaskForm.js';

function NewTaskInner() {
  const { session } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const sp = useSearchParams();
  const parentId = sp.get('parent');

  const [departments, setDepartments] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [parentTask, setParentTask] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const [d, e] = await Promise.all([
        docketopsGet('getDepartments', {}, session),
        docketopsGet('getEmployees', {}, session),
      ]);
      setDepartments(Array.isArray(d) ? d : []);
      setEmployees(Array.isArray(e) ? e : []);
      if (parentId) {
        const p = await docketopsGet('getTask', { id: parentId }, session).catch(() => null);
        if (p) setParentTask(p);
      }
    } catch (e) { showToast(e.message || 'Failed to load', 'error'); }
    finally { setLoading(false); }
  }, [session, parentId, showToast]);
  useEffect(() => { load(); }, [load]);

  async function submit(payload) {
    setSaving(true);
    try {
      const action = payload.parent_task_id ? 'createSubtask' : 'createTask';
      const res = await docketopsPost(action, payload, session);
      showToast(`Created ${res.task_no}`, 'success');
      router.push(`/tasks/detail/?id=${res.id}`);
    } catch (e) { showToast(e.message || 'Create failed', 'error'); setSaving(false); }
  }

  return (
    <div style={{ maxWidth: 760 }}>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12 }}>
        <div>
          <h1 style={h1}>{parentTask ? 'New Sub-task' : 'New Task'}</h1>
          <p style={sub}>Set the owner, team and deadline. The deadline is locked once created; later changes are tracked as revisions.</p>
        </div>
        <button style={btnSecondary} onClick={() => router.back()}><ArrowLeft size={14} /> Back</button>
      </div>
      {loading ? <Spinner /> : (
        <TaskForm departments={departments} employees={employees} parentTask={parentTask} onSubmit={submit} saving={saving} />
      )}
    </div>
  );
}

export default function NewTaskPage() {
  return <Suspense fallback={<Spinner />}><NewTaskInner /></Suspense>;
}

const h1 = { fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' };
const sub = { fontSize: 13, color: 'var(--text-3)', marginTop: 4, maxWidth: 560, lineHeight: 1.5 };
const btnSecondary = { display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 'var(--radius-sm)', padding: '7px 14px', fontFamily: 'var(--font-cond)', fontSize: 12, fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.04em', background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)' };
