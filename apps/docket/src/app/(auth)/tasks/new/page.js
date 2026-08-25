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
  const [programs, setPrograms] = useState([]);
  const [parentTask, setParentTask] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const [d, e, p] = await Promise.all([
        docketopsGet('getDepartments', {}, session),
        docketopsGet('getEmployees', {}, session),
        docketopsGet('getPrograms', {}, session).catch(() => []),
      ]);
      setDepartments(Array.isArray(d) ? d : []);
      setEmployees(Array.isArray(e) ? e : []);
      setPrograms(Array.isArray(p) ? p : []);
      if (parentId) {
        const p = await docketopsGet('getTask', { id: parentId }, session).catch(() => null);
        if (p) setParentTask(p);
      }
    } catch (e) { showToast(e.message || 'Failed to load', 'error'); }
    finally { setLoading(false); }
  }, [session, parentId, showToast]);
  useEffect(() => { load(); }, [load]);

  async function createProgram(name) {
    const prog = await docketopsPost('createProgram', { name }, session);
    setPrograms(ps => ps.some(p => p.id === prog.id) ? ps : [...ps, prog].sort((a, b) => a.name.localeCompare(b.name)));
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('docket:programs-changed'));
    return prog; // { id, name, color }
  }

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
    <div className="tk-page" style={{ maxWidth: 760 }}>
      <div className="tk-head" style={{ marginBottom: 16, alignItems: 'flex-end' }}>
        <div className="tk-headmain">
          <div className="dr-title" style={{ fontSize: 21 }}>{parentTask ? 'New Sub-task' : 'New Task'}</div>
          <p className="dr-desc" style={{ marginTop: 5, maxWidth: 560 }}>Set the owner, team and deadline. The deadline is locked once created; later changes are tracked as revisions.</p>
        </div>
        <button className="btn btn-ghost" onClick={() => router.back()}><ArrowLeft size={13} /> Back</button>
      </div>
      {loading ? <Spinner /> : (
        <TaskForm departments={departments} employees={employees} programs={programs} parentTask={parentTask} onCreateProgram={createProgram} onSubmit={submit} saving={saving} />
      )}
    </div>
  );
}

export default function NewTaskPage() {
  return <Suspense fallback={<Spinner />}><NewTaskInner /></Suspense>;
}
